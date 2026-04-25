# SendGrid — configure, test, and debug

This guide covers **outbound mail** (Mail Send API) and **inbound Event Webhooks** for this reference app. For the full **ngrok + dual HMAC + CSV capture** walkthrough, see [`event-dual-secret-local-test.md`](event-dual-secret-local-test.md).

---

## What the app uses SendGrid for

| Flow | Route / behavior |
|------|------------------|
| **Send mail** | Dispatch handler calls `SendGridProvider` when `EMAIL_PROVIDER=sendgrid`. Outbound messages include **`custom_args`** (`campaign_id`, `user_id`, `organization_id`, `analytics_callback_url`) so webhooks can correlate. |
| **Receive events** | `POST /api/scalemargin/sendgrid-events` — ECDSA signature verification on the **raw body**, then parsing, PII stripping, and HMAC-signed analytics POSTs to ScaleMargin’s `analytics_callback_url`. |
| **Unsubscribe link** | `GET /api/unsubscribe` — optional browser path (no `/scalemargin/` in the URL). See [Unsubscribe and links](#unsubscribe-and-links). |

Code touchpoints: `src/providers/sendgrid.ts`, `src/events/adapters/sendgrid.ts`, `src/events/outbound/sendgrid-tagger.ts`, `src/index.ts`.

---

## Environment variables

Set these in `.env` (see also [`.env.example`](../.env.example)).

| Variable | When | Purpose |
|----------|------|---------|
| `EMAIL_PROVIDER` | Required for SendGrid mail | Must be `sendgrid`. |
| `SENDGRID_API_KEY` | Sending mail | Mail Send API key (restrict scopes in production). |
| `FROM_EMAIL` | Sending mail | Must be a **verified** sender identity in SendGrid. |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | Inbound events enabled | Base64 **ECDSA public key** from SendGrid Event Webhook “Signature Verification” — must match the key shown for **that** webhook. |
| `SCALEMARGIN_DISPATCH_SECRET` | Dispatch | Verifies `POST /api/scalemargin/dispatch`. |
| `SCALEMARGIN_ANALYTICS_SECRET` | Analytics POSTs | Signs outbound analytics (same secret verifies dev CSV capture if used). |
| `EVENTS_CONFIG_PATH` | Optional | Path to `events.yaml`; if missing, defaults apply (see `config/events.example.yaml`). |
| `EVENT_SENDGRID_INBOUND_EVENTS` | Optional | `default` \| `*` \| `all` \| comma list of SendGrid **wire** `event` names. Default minimal set **excludes** `open` / `click` unless you opt in. |
| `EVENT_PREFERENCE_SIMULATION_LOG` | Optional | Set to `0` to disable `[Events][PreferenceSimulation]` console lines for `unsubscribed` / `complained`. |
| `UNSUBSCRIBE_URL_BASE` | Mail templates | Base URL for `{{unsubscribe_url}}` in dispatch YAML (often `https://<your-host>/api/unsubscribe`). |
| `UNSUBSCRIBE_LINK_ANALYTICS_URL` | Unsubscribe GET | If set, link clicks POST signed `unsubscribed` analytics here (typically same URL as `metadata.analytics_callback_url`). |
| `UNSUBSCRIBE_LINK_REDIRECT_URL` | Optional | After recording, **302** redirect the browser (e.g. your product “unsubscribed” page). |

Local smoke test extras: `EVENT_TEST_PUBLIC_BASE_URL`, `EVENT_TEST_CSV_PATH`, `EVENT_TEST_RECIPIENTS`, etc. — documented in [`event-dual-secret-local-test.md`](event-dual-secret-local-test.md).

---

## SendGrid dashboard checklist

### 1. API key

- **Settings → API Keys** — create a key with permission to **send mail** (Mail Send).
- Put the value in `SENDGRID_API_KEY`.

### 2. Sender identity

- **Settings → Sender Authentication** — verify the domain or single sender you use for `FROM_EMAIL`.
- Unverified senders will cause API errors or poor deliverability.

### 3. Event Webhook (delivery + engagement)

- **Mail Settings → Event Webhook** (or **Messaging → Event Webhook**, depending on your SendGrid UI).
- **HTTP POST URL** (public HTTPS), e.g.  
  `https://<your-tunnel>.ngrok-free.app/api/scalemargin/sendgrid-events`
- Enable **Signed Event Webhook** and copy the **verification public key** into `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` in `.env` (base64 string).
- Select the **event types** you care about (e.g. **Delivered**, **Processed**, **Bounce**, **Open**, **Click**, **Unsubscribed**, **Group Unsubscribed**).  
  This app applies its **own** allowlist in addition — see [`event-pipeline-contract.md`](event-pipeline-contract.md).

### 4. Tracking vs webhook (common confusion)

- **Settings → Tracking** (e.g. **Open Tracking**) controls whether SendGrid **records** opens and injects the pixel.
- The **Event Webhook** controls which **event types** are **POSTed** to your URL. Both matter for seeing `open` in your pipeline.

### 5. “Test Integration” in the UI

SendGrid’s dashboard **Test Integration** often sends sample payloads **without** `custom_args`. This app **drops** those for correlation and logs a single summary line — **expected**. Use a **real** dispatch send (or `pnpm run dev:event-test` auto-dispatch) so outbound mail includes `custom_args` and webhooks correlate.

---

## Application configuration (`config/events.yaml`)

Copy from `config/events.example.yaml` if you do not already have a file:

```bash
cp config/events.example.yaml config/events.yaml
```

Minimal SendGrid inbound block:

```yaml
events:
  providers:
    sendgrid:
      enabled: true
      signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
      # Optional — omit for default wires, or use ["*"] for all mapped types:
      # inbound_event_types: ["*"]
```

Env overrides: `EVENT_FORWARD_MODE=sync` is useful for local debugging so the HTTP response to SendGrid waits until analytics POST completes. See [`event-pipeline-contract.md`](event-pipeline-contract.md).

---

## Local end-to-end test (recommended)

One command provisions SQLite users, temp `events.yaml`, points `analytics_callback_url` at your tunnel, and starts the real server:

```bash
export EVENT_TEST_PUBLIC_BASE_URL=https://<your-ngrok-host>.ngrok-free.app
pnpm run dev:event-test
```

Then:

1. Run **ngrok** (or similar) to the printed `PORT`.
2. Configure the SendGrid Event Webhook URL to hit **`…/api/scalemargin/sendgrid-events`** on that same origin.
3. Watch logs and optional CSV (`EVENT_TEST_CSV_PATH`).

Full step-by-step: [`event-dual-secret-local-test.md`](event-dual-secret-local-test.md).

---

## Unsubscribe and links

- **Mail template:** `{{unsubscribe_url}}` is built from `dispatch.yaml` placeholders — recommended pattern in [`dispatch.example.yaml`](../config/dispatch.example.yaml) includes `uid`, `campaign_id`, and `organization_id` query parameters (no raw email in the URL).
- **Public path:** `GET /api/unsubscribe` — client-facing path **without** `/scalemargin/`.
- **Double proxy:** Same ngrok host can serve SendGrid webhooks, analytics capture, and `/api/unsubscribe`; `dev:event-test` defaults `UNSUBSCRIBE_URL_BASE` and `UNSUBSCRIBE_LINK_ANALYTICS_URL` accordingly when `EVENT_TEST_PUBLIC_BASE_URL` is set.

---

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| **401** on `POST /api/scalemargin/sendgrid-events` | `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` matches SendGrid’s signing key for **this** webhook; request body is the **raw** JSON SendGrid POSTed (no re-serialization middleware altering it). |
| Events **accepted** but **no analytics** / CSV rows | Correlation: real sends must include **`custom_args`** (dispatch path sets `message.context`). Allowlist: `open` / `click` need `EVENT_SENDGRID_INBOUND_EVENTS=*` or an explicit list — see `src/events/sendgrid-inbound-filter.ts`. |
| **No `open` webhooks** | Tracking enabled in SendGrid **and** “Open” checked on the Event Webhook **and** client loads images; see dual-secret doc. |
| **`[Events][PreferenceSimulation]`** lines | Normal for `unsubscribed` / `complained` / link-click unsubscribes. Disable with `EVENT_PREFERENCE_SIMULATION_LOG=0`. |
| **EADDRINUSE** | Another process on `PORT`; change `PORT` and match ngrok. |

---

## Automated tests in this repo

- **Unit / adapter:** `src/events/adapters/sendgrid.spec.ts`
- **Inbound integration:** `src/events/sendgrid.integration.spec.ts`

Run:

```bash
pnpm exec vitest run src/events/adapters/sendgrid.spec.ts src/events/sendgrid.integration.spec.ts
```

---

## Related documentation

| Doc | Topic |
|-----|--------|
| [`ses.readme.md`](ses.readme.md) | AWS SES configuration set, SNS, `dev:ses-event-test` |
| [`event-dual-secret-local-test.md`](event-dual-secret-local-test.md) | ngrok, `dev:event-test`, CSV capture, opens vs allowlist |
| [`event-pipeline-contract.md`](event-pipeline-contract.md) | Standardized events, allowlist, forwarding |
| [`pii-guarantees.md`](pii-guarantees.md) | What is stripped before analytics |
| [`user-lookup-contract.md`](user-lookup-contract.md) | Dispatch YAML, placeholders, `unsubscribe_url` |
