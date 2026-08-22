# Architecture — how the dispatcher actually works

How a dispatch becomes an email/WhatsApp message, how provider events come
back, and where every knob lives. Companion to
[`multi-sender-design.md`](./multi-sender-design.md), which describes the
multi-email-provider change on top of this.

---

## 1. What this service is

One Express process (`src/index.ts`) that plays four roles:

| Role | Entry point |
| --- | --- |
| **Inbound dispatch** — ScaleMargin Atlas tells it to send a campaign | `POST /api/scalemargin/dispatch` |
| **Sending** — resolves recipients, personalizes, calls SES / SendGrid / Gupshup | `src/dispatch/*`, `src/providers/*` |
| **Inbound provider events** — SendGrid / SES-SNS / Gupshup webhooks | `POST /api/scalemargin/{sendgrid-events,ses-notifications,gupshup-events}` |
| **Outbound analytics** — HMAC-signed standardized event batches back to Atlas | `src/events/{outbox,forwarder}.ts` |

Plus an operations console (`/admin`), a log query API (`/logs`), public
unsubscribe/preference pages, and a signed diagnostics endpoint.

Two HMAC secrets, deliberately separate:

- `SCALEMARGIN_DISPATCH_SECRET` — verifies **inbound** dispatch/diagnostics
  (`X-ScaleMargin-Signature`, computed over the **raw** body — that is why
  `src/index.ts:162-173` parses those routes as `express.text` first).
- `SCALEMARGIN_ANALYTICS_SECRET` — signs **outbound** analytics POSTs.

---

## 2. Boot sequence (`src/index.ts`)

Order matters; every step is fail-fast except the last:

1. `loadRepoDotEnv()` — loads repo-root `.env` unless `VITEST=true`.
   Last duplicate key wins; a non-empty shell export is **not** overwritten.
2. `LOCAL_DEV=1` → insecure placeholder `SCALEMARGIN_*` secrets (never prod).
3. Required env check → `SCALEMARGIN_DISPATCH_SECRET`,
   `SCALEMARGIN_ANALYTICS_SECRET`. Missing → `process.exit(1)`.
4. `ensureDispatchConfigLoaded()` — parses `config/dispatch.yaml` through Zod
   and validates the env the chosen lookup backend needs. Invalid → exit.
5. `initDispatcherDb()` — opens the **state DB** and runs Drizzle migrations.
   Failure → exit.
6. `initializeEventPipeline()` — resolves the events config, asserts enabled
   providers have their keys, starts the batched flusher timer.
7. Routes are registered, `startServer()` listens on `PORT` (default 3100).

Config is **cached per process**. `config/dispatch.yaml`, `config/events.yaml`
and every `process.env` read at boot need a restart to take effect. The one
exception is personalization variables (§6), which are DB-backed and hot.

---

## 3. Two databases — do not confuse them

| | **Client user-lookup DB** | **Dispatcher state DB** |
| --- | --- | --- |
| Env prefix | `DB_*` | `DISPATCHER_DB_*` |
| Owner | you / the client | this service |
| Holds | recipient PII (email, phone, names) | variables, dispatch + webhook activity, failures, app logs, campaign events, callback registry, event outbox, admin accounts |
| Written by dispatcher | never | always |
| Configured in | `config/dispatch.yaml` | env only |

State DB defaults to SQLite at `./data/dispatcher.db`; point
`DISPATCHER_DB_DIALECT/URL/...` at MySQL or Postgres for production. Schema is
defined three times, once per dialect (`src/db/schema/{sqlite,mysql,pg}.ts`),
kept column-compatible with the dialect-neutral row types in
`src/db/schema/shared.ts`. Migrations live in `drizzle/{sqlite,mysql,pg}/`.

**Single-replica model.** The event outbox has no row-claim locking, so run one
dispatcher per state database.

Retention sweeps hourly (`src/db/retention.ts`): logs 14 days /200k rows,
dispatch+webhook history 90 days, delivered outbox rows 7 days, failed 30 days,
unused callback registrations 30 days.

---

## 4. The dispatch request lifecycle

### 4.1 Accept (`src/index.ts:308-387`)

```
POST /api/scalemargin/dispatch
  → express.text (raw body, 10 MB — base64 images)
  → verifyHmacSignature            src/middleware/hmac.ts
  → bindCampaignId()               puts campaign_id on every log line
  → recordDispatchProgramForPayload()   wire id → program mapping
  → recordDispatchActivity(status: "accepted")
  → 202 { accepted: true }         ← responds BEFORE sending
  → processDispatch(...)  (floating promise)
      .then  → recordDispatchActivity("completed", sent/failed/duration)
      .catch → recordDispatchActivity("failed", error + stack)
```

Two consequences of the 202-then-process shape:

- **Nothing after the ack can return an HTTP error.** Every later failure is
  visible only in the console, `dispatch_recipient_failures`, and logs.
- Any validation that should produce a `400` must run **before** the 202.
  Today only the HMAC does.

### 4.2 Program correlation

A drip step arrives with `campaign_id = drip_{enrollmentId}_{stepId}` — that
names *one send*, not a campaign. `metadata.drip_sequence_id` is the only key
that groups drips into what a human calls "the campaign", and it exists **only
on this payload**; later provider webhooks carry the wire id alone. So
`recordDispatchProgramForPayload()` persists `campaign_id → program_id` into
`dispatch_programs` *before* any event is emitted, and `persistCampaignEvents()`
resolves through it (`src/events/persist.ts`).

### 4.3 Payload shape (`src/dispatch/types.ts`)

```ts
{
  campaign_id, channel,            // "email" | "whatsapp"
  user_ids: string[],
  dispatch_ids?: { [user_id]: string },
  content: { subject?, html_body?, text_body?, caption?, media_url?, has_cta? },
  personalization_fields?: string[],
  images?: [{ placeholder, url, raw_url, content_type, alt_text?, base64_data? }],
  metadata: {
    organization_id, analytics_callback_url,
    dispatch_kind?, drip_sequence_id?, step_id?, enrollment_id?, lead_id?,
    correlation_id?, campaign_name?, variant_id?, scheduled_at?
  }
}
```

### 4.4 Email path (`src/dispatch/processor.ts`)

```
ensurePlaceholdersFresh()            pick up admin variable edits, once per run
  ↓ channel === "whatsapp" → processWhatsAppDispatch(), return
resolveAnalyticsCallbackUrl()        payload URL vs env override
registerCampaignCallback()           campaign_id → callback URL (SES needs this later)
lookupUsers(user_ids)                → Map<user_id, UserRecord>
resolveDynamicValues()               async query/api variables, once per recipient set
processImages() + rewriteImageUrls() base64/remote → hosted URLs, swap {{img}} in HTML
getProvider()                        ← singleton, EMAIL_PROVIDER env
for each user_id:
    personalize(subject/html/text)
    build EmailMessage { to, from, subject, html, text?, context }
for each message (SEQUENTIAL):
    provider.send()
    on failure → telemetry + recordRecipientFailure()
    emitEvent(dispatched | failed)
return { sent, failed }
```

Notes that bite:

- Sends are **sequential**, one `await` per recipient. No concurrency, no rate
  limiting, no retry. A 5 000-recipient campaign is 5 000 serial HTTPS calls.
- A `user_id` missing from lookup is skipped with a `user_not_found` failure
  row — it never reaches the provider and produces **no** analytics event.
- `DEV_RECIPIENT_EMAIL` rewrites every recipient to one address and `break`s
  after the first message, recording the campaign in `dev_sent_campaigns` so a
  redelivery of the same campaign is skipped entirely.
- `from` is a single process-wide constant: `FROM_EMAIL`, read once at
  `src/index.ts:145` and passed as an argument into `processDispatch`.

### 4.5 WhatsApp path (`src/dispatch/whatsapp.ts`)

Same skeleton, different provider (`GupshupWhatsAppProvider`), plus:

- content is either a **media spec** (`content.caption` + `media_url`/images →
  `SENDMEDIAMESSAGE`) or a **template spec** (template JSON in
  `text_body`/`html_body`, or `GUPSHUP_DEFAULT_TEMPLATE`); media wins.
- recipient is a phone number (`resolveRecipientPhone`), not an email.
- correlation cannot ride in the payload: Gupshup's `tag` field is 50 chars, so
  the dispatcher sends `smsign_<hmac>` (`src/events/tag-sign.ts`) and the
  backend re-derives the identity from `externalId`.
- a "success" with no provider message id is downgraded to `failed`
  (`noProviderMessageId`) because delivery receipts key on that id.

---

## 5. User lookup — how recipients are resolved

`config/dispatch.yaml` → `user_lookup` (Zod schema in
`src/user-lookup/config.ts`). Backends: `sqlite | mysql | postgres | http |
mock`; `USER_LOOKUP_BACKEND` env overrides the file. Missing file → mock
backend + default placeholders so the server still boots.

```yaml
user_lookup:
  backend: sqlite
  sqlite: { file: ./data/dispatch.sqlite }
  source: { kind: table, name: users, id_column: user_id, id_type: string }
  fields:                 # logical name → SQL column / JSON path
    first_name: first_name
    email: email
    phone: phone_no
  batch: { max_ids_per_query: 1000, dedupe: true }
```

- SQL backends build a parameterized `WHERE id IN (...)` in chunks
  (`src/user-lookup/sql-build.ts`); `id_type` controls casting.
- HTTP backend posts a batch of ids to your profile API, with
  bearer/header/none auth, timeout and retries (`adapters/http.ts`).
- `fields.email` is what the send path reads. A config without it only warns —
  and then every recipient silently has no address.
- `POST /api/scalemargin/validate-pii` is the signed smoke test: counts and
  field *names* only, never values.

Contract details: [`user-lookup-contract.md`](./user-lookup-contract.md).

---

## 6. Personalization and dynamic variables

`{{name}}` tokens are resolved by `src/personalize.ts` against a registry that
comes from the **state DB** when it is up, falling back to
`config/dispatch.yaml`'s `placeholders` (`getPlaceholderRegistry()`).

| Source | Resolved | Notes |
| --- | --- | --- |
| `field` | sync | a column from the lookup record |
| `computed` | sync | safe string expression, `+` concatenation, `env.X` access |
| `constant` | sync | fixed value |
| `query` | **async, per recipient** | SELECT/WITH only, single statement, tokens bound as parameters (not interpolated), timed out |
| `api` | **async, per recipient** | http(s) only, token interpolation in url/headers/body, JSON-path extraction, timeout + size cap |

Async sources run once for the whole recipient set before the personalize pass
(`resolveDynamicValues`), are cached per identical query/URL within a run,
concurrency-capped, and **fall back to the variable's fallback with a warning**
on failure — a broken source degrades a value, it never wedges the campaign.

Variables are created/edited in **Admin → Variables** and apply to the next
dispatch with no restart (`ensurePlaceholdersFresh()` at the top of
`processDispatch`). API `headers` (e.g. `Authorization`) are stored in the
state DB and redacted in API responses.

`unsubscribe_url` / `preferences_url` are ordinary `computed` placeholders built
from `UNSUBSCRIBE_URL_BASE` — the links are **dispatcher-hosted**, not
provider-hosted.

---

## 7. Channels and provider configuration

### 7.1 The two dimensions

Provider configuration is split across two independent surfaces, and this is
the single most confusing thing in the repo:

| | **Outbound (sending)** | **Inbound (event webhooks)** |
| --- | --- | --- |
| Configured in | **env only** (`.env.yaml` once multi-sender lands) | `config/events.yaml` + env |
| Email selector | `EMAIL_PROVIDER` = `ses` \| `sendgrid` | `events.providers.{sendgrid,ses,gupshup}.enabled` |
| Credentials | `AWS_*` / `SENDGRID_API_KEY` / `GUPSHUP_*` | verification keys: `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`, SNS certs, `GUPSHUP_WEBHOOK_SECRET` |
| Code | `src/providers/index.ts` | `src/events/config.ts`, `src/events/*/adapter.ts` |

You can (and often do) **send** through SES while having SendGrid inbound
disabled, or accept Gupshup events while never sending WhatsApp.

### 7.2 Outbound: the provider registry

`src/providers/index.ts` is 50 lines:

```ts
const PROVIDERS = { ses: () => new SESProvider(), sendgrid: () => new SendGridProvider() };
let _instance = null;
export function getProvider() {
  if (_instance) return _instance;
  _instance = PROVIDERS[process.env.EMAIL_PROVIDER || "ses"]();
  return _instance;
}
```

- **One provider per process, chosen by env, memoized forever.** There is no
  reset, no per-campaign choice, no fallback.
- Every provider implements `EmailProvider { name, send(), sendBulk() }`
  (`src/providers/types.ts`). `sendBulk` is a sequential loop in both
  implementations and is not used by the dispatch path.
- `SESProvider` builds a `SendEmailCommand` and warns if `AWS_ACCESS_KEY_ID`
  doesn't look like a real key (a leftover `~/.zshrc` export shadowing `.env`
  is the usual cause of `InvalidClientTokenId`).
- `SendGridProvider` calls `sgMail.setApiKey()` on the **module-level shared
  `MailService` singleton** exported by `@sendgrid/mail` — see the hazard note
  in the multi-sender doc.
- WhatsApp is not in this registry: `processWhatsAppDispatch` constructs
  `new GupshupWhatsAppProvider()` directly.

### 7.3 Outbound tagging — how a send stays correlatable

Before handing a message to the provider, the dispatch path attaches a
`SendContext { campaign_id, user_id, dispatch_id?, organization_id,
analytics_callback_url }`, and each provider translates it:

| Provider | Mechanism | Carries callback URL? |
| --- | --- | --- |
| SendGrid | `customArgs` on the Mail Send payload, echoed on every event | **yes** |
| SES | `Tags` (`campaign_id`, `user_id`, `dispatch_id`, `organization_id`), echoed in SNS `mail.tags`; each value ≤256 chars | **no** — the URL doesn't fit, so it is recovered from the `campaign_callbacks` registry |
| Gupshup | `smsign_<hmac>` in `extra`/`tag` (50-char limit) | no — backend matches on `externalId` |

SES additionally needs `ConfigurationSetName`, read from `SES_EVENT_CONFIG_SET`
in `src/events/outbound/ses-tagger.ts`. **Without a configuration set, SES sends
mail but emits no events at all** — delivery works and analytics is silently
empty.

SendGrid open tracking needs the `%open-track%` substitution tag in the HTML;
the provider appends a hidden span when it's missing.

### 7.4 Inbound: the events config

`config/events.yaml` (optional; built-in defaults otherwise), schema in
`src/events/config.ts`:

```yaml
events:
  forward:  { mode: batched, batch_size: 100, batch_interval_ms: 5000 }
  delivery: { mode: at_least_once, buffer: { kind: memory, max_events_memory: 10000 } }
  providers:
    sendgrid: { enabled: true,  signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
                inbound_event_types: [delivered, open, click, bounce] }
    ses:      { enabled: true,  configuration_set_env: SES_EVENT_CONFIG_SET }
    gupshup:  { enabled: true,  secret_env: GUPSHUP_WEBHOOK_SECRET }
```

`applyProviderEnablementFromEnv()` **overwrites** the YAML `enabled` flags:

- `sendgrid.enabled = Boolean(env[signing_key_env])` — key present ⇒ on.
- `ses.enabled = true`, `gupshup.enabled = true` — always.
- then `EVENT_PROVIDERS_DISABLED=a,b` turns off, `EVENT_PROVIDERS_ENABLED=a,b`
  forces on.

So in practice the YAML `enabled:` field is advisory for email and the env is
the switch. `enabled` gates **forwarding**, not acceptance: a disabled SendGrid
route 404s, a disabled Gupshup route still 200s and logs.

Env overrides for everything else: `EVENT_FORWARD_MODE`,
`EVENT_DELIVERY_MODE`, `EVENT_BATCH_SIZE`, `EVENT_BATCH_INTERVAL_MS`,
`EVENT_BUFFER_DIR` (also flips the buffer to disk),
`EVENT_SENDGRID_INBOUND_EVENTS` (`default` | `*` | csv), `EVENT_DEBUG=1`.

---

## 8. The event pipeline

### 8.1 Inbound webhook handling

Routes are registered in `src/routes/inbound-webhooks.ts`; the shared handler
factory is `createInboundWebhookHandler()` in `src/events/index.ts`.

```
raw body
 → adapter.verifySignature()      401 on failure
 → adapter.parseEvents()          400 on unparseable
 → per item:
     (sendgrid) wire-type allowlist  → skip
     adapter.extractCorrelation()    → null? drop / receipt path
     adapter.stripPii()
     adapter.toStandardEvent()       → null? unsupported type, drop
     ensureIdempotency() + scrubPii(metadata)
     persistCampaignEvents()         ← console record, BEFORE the URL gate
     resolveAnalyticsCallbackUrl()   → no URL? persisted, not forwarded
     → envelope { callbackUrl, event }
 → enqueueEvents() (outbox) or in-memory buffer
 → 200 { received, count, receipts }
```

Per-provider specifics:

- **SES** (`/api/scalemargin/ses-notifications`): SNS envelope. Signature is
  verified against AWS's published certificate (`src/events/sns-verify.ts`) —
  **account-agnostic**. `SubscriptionConfirmation` is auto-confirmed, but only
  if the `SubscribeURL` host ends in `.amazonaws.com`. Correlation from
  `mail.tags`; the callback URL comes from the `campaign_callbacks` registry.
- **SendGrid** (`/api/scalemargin/sendgrid-events`): ECDSA signature over the
  raw body using **one** public key. Correlation from `custom_args`. There is a
  wire-type allowlist (`sendgrid/inbound-filter.ts`) and a dedicated
  `explainSendGridCorrelationDrop()` because "Test Integration" payloads from
  the dashboard carry no `custom_args` and are the #1 support question.
- **Gupshup** (`/api/scalemargin/gupshup-events`): always logs the raw payload
  first. HMAC verification only if `GUPSHUP_WEBHOOK_SECRET` is set — otherwise
  **the webhook is open**, and boot warns about it. Correlation-free delivery
  receipts take a separate path (`forwardGupshupReceipts`) and are rejected
  unless they echo an `smsign_` stamp.

### 8.2 Standardized event

`StandardizedEvent` (`src/events/common/types.ts`) is the wire format for
everything the backend receives:

```ts
{ campaign_id, user_id, organization_id, analytics_callback_url?,
  channel: "email" | "whatsapp" | "sms",
  event: dispatched | delivered | opened | clicked | bounced | unsubscribed
       | complained | failed | sent | read | deferred | expired | preference_update,
  provider: "sendgrid" | "ses" | "gupshup" | "link_click",
  provider_message_id, occurred_at, idempotency_key?, metadata? }
```

### 8.3 Delivery: outbox → forwarder

- If the state DB is up, `enqueueEvents()` writes to the **`event_outbox`**
  table; the in-memory ring buffer is only a fallback for processes without a
  DB (unit tests).
- `forward.mode: batched` runs `deliverDueBatch()` on a timer; `sync` flushes
  inline on the request path.
- `flushEnvelopesSync()` groups by callback URL, signs each batch with
  `SCALEMARGIN_ANALYTICS_SECRET`, POSTs, and records a `webhook_activity` row.
- Failures back off and retry up to `DISPATCHER_OUTBOX_MAX_ATTEMPTS` (10), then
  the row is marked failed.
- `idempotency_key` is derived from
  `provider|provider_message_id|event|occurred_at`;
  `campaign_events.dedupe_key` (`src/events/persist.ts`) additionally folds in
  `campaign_id` and `user_id` so live persist and outbox backfill dedupe
  against each other.

### 8.4 PII

`stripPii` per adapter plus a global `scrubPii` on metadata. Nothing leaving
this service carries recipient addresses, IPs, or message content — only opaque
`user_id`s. See [`pii-guarantees.md`](./pii-guarantees.md).

---

## 9. Everything else on the process

| Surface | Route / file | Notes |
| --- | --- | --- |
| Health | `GET /health` | minimal; no telemetry (probes would flood PostHog) |
| Version | `GET /version` | package + build metadata |
| Status | `GET /status` | required env / dispatch config / events config checks; probes nothing external |
| Diagnostics | `POST /api/scalemargin/diagnostics` | HMAC-signed; config **shapes** and env **presence booleans** only, never values |
| Admin console | `/admin` | React SPA + Better Auth accounts, invite-only; overview, campaigns, logs, variables, members, observability, API keys |
| Log API | `GET /logs` | bearer token or admin session; keyset pagination over `app_logs` |
| Log webhook | Settings → Observability | POSTs `warn`+ logs to your endpoint, optional HMAC, fire-and-forget, drops under overload |
| Unsubscribe | `GET/POST /api/unsubscribe` | reason survey → PII-free `unsubscribed` analytics |
| Preferences | `GET/POST /api/preferences` | per-category opt-out; `preference_update` is **logged only, never suppresses** |
| Images | `src/images/*` | base64/remote → local disk, S3, or GCS; HTML rewritten to hosted URLs |
| Telemetry | `src/telemetry/posthog.ts` | anonymous by design; no PII, no ids, no raw errors — sanitized `dispatcher_error` with a stack hash |
| Logging | `src/logging/*` | pino → console + `app_logs` sink + optional webhook; `request_id` and `campaign_id` bound per request |

---

## 10. Where each knob lives

```
.env                      secrets, provider selection, hosts, feature flags   (client-defined)
.env.yaml                 email senders + structured deployment config        (client-defined)
config/dispatch.yaml      user lookup backend + field map + default placeholders
config/events.yaml        event forwarding mode, buffer, inbound provider flags
state DB                  variables (live-editable), observability settings, API keys, accounts
```

Rule of thumb: **client-owned config at the repo root (`.env`, `.env.yaml`),
app-shipped shape under `config/`, operator-editable content in the state DB.**

`config/*.yaml` never contains a secret — it names the env var that holds it
(`signing_key_env`, `token_env`). `.env.yaml` is the one exception: it is
gitignored and secret-bearing like `.env`, so it accepts inline credentials as
well as `*_env` references.

Path resolution differs, and it matters when the working directory isn't the
repo root:

| File | Resolved from |
| --- | --- |
| `.env`, `.env.yaml` | the **module** root — `src/..` in dev, `dist/..` (`/app`) in Docker |
| `config/dispatch.yaml`, `config/events.yaml` | `process.cwd()`, overridable via `USER_LOOKUP_CONFIG_PATH` / `EVENTS_CONFIG_PATH` |

`.env.yaml` is the sender-configuration file introduced by
[`multi-sender-design.md`](./multi-sender-design.md) — see §3 there for the
schema, secret handling, and the Docker bind mount it needs.

---

## 11. Known sharp edges (pre-existing)

1. `getProvider()` memoizes one provider for the process lifetime and cannot be
   reset — tests mock the module instead.
2. `processor.ts:175` labels emitted events by reading `EMAIL_PROVIDER` from env
   rather than asking the provider that actually sent. Harmless with one
   provider, wrong the moment there is more than one.
3. Sends are sequential and unthrottled; there is no rate limiter and no retry.
4. Everything after the 202 is invisible to the caller.
5. SES without a configuration set = zero events, no error.
6. SendGrid inbound verifies against exactly one public key.
7. Breaker/health state, dev-send dedupe and the outbox all assume a single
   replica.
