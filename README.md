# ScaleMargin Dispatcher

**What you are installing.** One container that runs inside your infrastructure,
next to your customer database. ScaleMargin sends it campaigns containing
placeholders and opaque IDs; it looks up the real values in _your_ database,
personalizes each message, and sends through _your_ email provider. No customer
data ever reaches ScaleMargin.

**What it takes.** One `.env.yaml` file and `docker compose up -d`. Roughly
twenty minutes end to end.

---

## 1. Before you start

| You need                                   | Notes                                                         |
| ------------------------------------------ | ------------------------------------------------------------- |
| Docker Engine 24+ with Compose v2          | `docker --version`, `docker compose version`                  |
| 2 vCPU / 2 GB RAM / 10 GB disk             | Comfortable for millions of sends a month                     |
| Recipient data the dispatcher can reach     | Read-only database access, **or** a lookup API you host. See §6 |
| An email provider account                  | AWS SES or SendGrid, with a **verified sender address**       |
| Two secrets from ScaleMargin               | `SCALEMARGIN_DISPATCH_SECRET`, `SCALEMARGIN_ANALYTICS_SECRET` |
| Outbound access to `ghcr.io`               | To pull the image. No account or credentials needed — see §3  |

The dispatcher must be able to reach your customer database, your email
provider, and `api.scalemargin.com`. It does **not** need to accept inbound
traffic from the internet unless you want provider webhooks (delivery and open
tracking) or want to manage it from the ScaleMargin platform — see §9.

---

## 2. There are two databases. This is the thing to get right.

|                   | Your customer database                   | The dispatcher's own database                  |
| ----------------- | ---------------------------------------- | ---------------------------------------------- |
| Contains          | Your customers — names, emails, balances | Variables, campaign history, logs, event queue |
| Who owns it       | You, already                             | Created by this compose file                   |
| Dispatcher access | **Read only**                            | Read and write                                 |
| Configured by     | `user_lookup:` in `.env.yaml`            | `dispatcher.database:` in `.env.yaml`          |
| Runs where        | Wherever it already runs                 | The `postgres` service in this stack           |

The dispatcher never writes to your customer database. It reads the columns you
map in `.env.yaml` and nothing else — or, if you prefer, it never touches your
database at all and asks an API you host instead (§6).

---

## 3. Get the files

Create a directory and put these files in it:

```
dispatcher/
  docker-compose.yml     from §4 below
  .env.yaml              from §5 below — you fill this in
```

**One configuration file.** There is no `.env`. Everything that used to live
there — platform secrets, database settings, provider keys, retention, logging
— is now a block in `.env.yaml`. It holds credentials, so `chmod 600` it.

**There is no registry login step.** Our image is published publicly on GitHub
Container Registry, so you pull it the same way you would pull `postgres`:

```bash
docker pull ghcr.io/scale-margins-v0/scalemargin-dispatcher:0.3.0
```

No account, no key file, no token, nothing that expires. If that command
succeeds you have everything you need from us on the registry side, and
`docker compose pull` will keep working unattended for as long as the machine
lives.

Only requirement: the host can reach `ghcr.io` on port 443. If your egress is
filtered, allowlist `ghcr.io` and `pkg-containers.githubusercontent.com` (the
latter serves the actual layers). If you cannot allow outbound access to a
public registry at all, tell us — we will send you the image as a signed tarball
instead.

---

## 4. `docker-compose.yml`

Copy this exactly. The only line you should change is the image tag, and only
when we tell you to upgrade.

```yaml
services:
  dispatcher:
    image: ghcr.io/scale-margins-v0/scalemargin-dispatcher:0.3.0
    restart: unless-stopped
    ports:
      # Bind to localhost only. Put a reverse proxy in front if you need
      # provider webhooks or the ScaleMargin dashboard — see section 8.
      - "127.0.0.1:3100:3100"
    # Nothing is set here: the dispatcher's own database is configured by the
    # `dispatcher.database:` block in .env.yaml. Anything you DO put here wins over
    # that file, which is the intended escape hatch for injected secrets.
    volumes:
      # Where recipient data comes from (§6) and which accounts send (§7).
      # Create this file BEFORE the first `up` — Docker silently creates an
      # empty directory in its place otherwise, and the dispatcher then runs
      # in MOCK mode and mails nobody real.
      - ./.env.yaml:/app/.env.yaml:ro
      # Local runtime state. Small, but keep it across restarts.
      - dispatcher-data:/app/data
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://localhost:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: dispatcher_state
      POSTGRES_USER: dispatcher
      # Must match `state_database.password` in .env.yaml. Written literally
      # because Compose's ${VAR} interpolation reads a `.env` file, and there
      # is no longer one to read.
      POSTGRES_PASSWORD: replace-with-a-long-random-string
    volumes:
      - dispatcher-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dispatcher -d dispatcher_state"]
      interval: 10s
      timeout: 5s
      retries: 10
    # Not published to the host — only the dispatcher needs to reach it.

volumes:
  dispatcher-data:
  dispatcher-postgres-data:
```

Two deliberate choices worth knowing about:

- **Postgres has no `ports:` entry.** It is reachable only from the dispatcher
  container on the compose network. Publishing it would expose your campaign
  history to the host network for no benefit.
- **The dispatcher binds to `127.0.0.1`.** Nothing from outside the machine can
  reach it until you deliberately put a proxy in front.
- **No `env_file:` and no `${VAR}` interpolation.** Both read a `.env` file.
  Configuration comes from the mounted `.env.yaml` instead; the one value that
  must be repeated is the Postgres password, because the database container
  needs it before the dispatcher has read anything.

---

## 5. `.env.yaml` — the only configuration file

Everything the dispatcher needs is one YAML file. There is no `.env`.

Create it next to `docker-compose.yml`, `chmod 600` it, and fill in the blocks
you need. Almost every key is optional — the dispatcher boots with sensible
defaults and tells you at startup what it could not find. The exceptions are
your two ScaleMargin secrets and **`dispatcher.retention.message_id_ttl`** (§5.3), which
has no default and will stop the container if unset.

```yaml
version: 1

# This service itself — how it is reached, and its own database and retention.
dispatcher:
  port: 3100
  public_url: https://dispatcher.your-company.com
  atlas_key: "…" # openssl rand -base64 32, then share it with us

  # Its OWN database — not your customer database.
  database:
    dialect: postgres
    host: postgres
    port: 5432
    user: dispatcher
    password: "replace-with-a-long-random-string" # must match docker-compose.yml
    database: dispatcher_state

  # How long provider message ids are kept. MANDATORY — no default. See §5.3.
  retention:
    message_id_ttl: "5d 2h"

# The two secrets from your onboarding email.  REQUIRED
scalemargin:
  dispatch_secret: "…"
  analytics_secret: "…"

# Where recipient data comes from. See §6 — this is the one to get right.
user_lookup:
  mode: database
  # …

# Sending, for a single account. See §7 for several.
email:
  provider: ses
  from: campaigns@your-company.com

# Anything not modelled above, set verbatim. This is where provider keys live
# now that there is no `.env`.
env:
  AWS_ACCESS_KEY_ID: "…"
  AWS_SECRET_ACCESS_KEY: "…"
```

A complete file, with every block and worked examples for four different
environments, is in **§13 at the end of this document**. The same content ships
in the package as `.env.yaml.example`.

### 5.0 How the file is laid out

One rule decides where a setting goes:

- **`dispatcher:`** — how the dispatcher itself runs. How it is reached, who may
  reach it, its own database, admin auth, retention, logging, telemetry.
- **Everything else is top-level** — what it does. `scalemargin:`,
  `user_lookup:`, `email:` / `routing:` / `senders:`, `links:`, `events:`,
  `storage:`, and the `env:` escape hatch.

```
dispatcher:            ← this service
  port, public_url, atlas_key, atlas_cors_origins, logs_api_token
  database:            its own state database
  admin:               console auth, session secret
  retention:           incl. the mandatory message_id_ttl
  logging:
  telemetry:
scalemargin:           ← what it does
user_lookup:
email / routing / senders
links / events / storage
env:
```

**If you wrote an earlier version of this file,** `state_database:`, `admin:`,
`retention:`, `logging:` and `telemetry:` used to be top-level. They are now
rejected there, with a message naming where each went — they are not silently
ignored:

```
state_database: moved — write this block under `dispatcher.database` instead
admin:          moved — write this block under `dispatcher.admin` instead
```

Indent the block two spaces under `dispatcher:`, and rename `state_database`
to `database`. Nothing else about the block changes.

### 5.1 Where a setting can come from

Three places, highest priority first:

<!-- prettier-ignore -->
| | Source | Use it for |
| --- | --- | --- |
| 1 | A real environment variable — Docker `environment:`, a Kubernetes Secret, a shell export | Rotated secrets, per-environment overrides, one-off debugging |
| 2 | A typed block in `.env.yaml` | Everything else |
| 3 | The `env:` map in `.env.yaml` | Provider keys and anything not modelled as a typed block |

**A real environment variable is never overwritten by the file.** That ordering
is deliberate: a platform injecting a freshly rotated secret has to win over a
value baked into a mounted file, and
`DISPATCHER_LOG_LEVEL=debug docker compose up` has to actually take effect.

If a typed block and the `env:` map set the same thing, the typed block wins and
the dispatcher says so at boot rather than picking one quietly.

### 5.2 Two ways to write any secret

<!-- prettier-ignore -->
| In `.env.yaml` | Meaning |
| --- | --- |
| `atlas_key: "abc123"` | The value itself |
| `atlas_key_env: DISPATCHER_ATLAS_KEY` | The **name** of a variable holding it |

The `_env` form keeps the secret out of the file, which matters if you template
`.env.yaml` into version control. It needs the named variable to exist
somewhere — your container's `environment:`, a Kubernetes Secret, or the `env:`
map at the bottom of the same file.

> ⚠️ **The `_env` suffix is the whole difference.** `atlas_key: DISPATCHER_ATLAS_KEY`
> does **not** read a variable. It sets your key to that literal text. If the
> name you reference does not exist, the dispatcher says so at boot instead of
> storing the name as the value.

### 5.3 `dispatcher.retention.message_id_ttl` — the one mandatory setting

Every provider gives a message an id when it accepts it. The dispatcher records
those ids in the **`provider_message_ids`** table of its own database, so you can
query them and poll the provider for status yourself.

```yaml
dispatcher:
  retention:
    message_id_ttl: "5d 2h" # REQUIRED — the dispatcher will not start without it
```

One row per accepted WhatsApp send. No API — it is yours to query directly:

| Column | |
| --- | --- |
| `id` | Row id |
| `provider` | `freshchat` or `gupshup` — the sender that actually sent it |
| `provider_message_id` | What the provider called the message. Freshchat returns its `request_id` |
| `user_id` | The recipient — the user id ScaleMargin sent in the dispatch |
| `sent_at` | When we sent it |

```sql
SELECT user_id, provider_message_id, sent_at
FROM provider_message_ids
WHERE provider = 'freshchat' AND sent_at > now() - interval '1 day';
```

Full reference, and how delivery/read events reach ScaleMargin:
[docs/message-ids-and-analytics.md](docs/message-ids-and-analytics.md).

**The format is a duration** — `"5d 2h"`, `"12h"`, `"30d"`. Days, hours and
minutes, in any order. **Minimum one hour.**

**There is deliberately no default,** which is why it is the only mandatory
setting besides your ScaleMargin secrets. Too short and the ids are gone before
you used them; too long and you are storing them forever. Only you know which,
so the dispatcher refuses to guess:

```
[FATAL] dispatcher.retention.message_id_ttl (DISPATCHER_MESSAGE_ID_TTL) is required —
        set it to how long to keep the data, e.g. "5d 2h". Minimum 1h.
```

Two details worth knowing:

- **Pruning runs hourly**, so a row survives at most one tick past its window.
  `"2h"` deletes rows between two and three hours old — never younger than two.
- **Only accepted sends are recorded.** A send the provider rejected has no id
  to look up, so it gets no row. Failures are in `dispatch_send_logs`.

---

## 6. `.env.yaml` — where recipient data comes from

ScaleMargin sends the dispatcher opaque IDs. This section tells it how to turn
those into an email address and a name.

**Pick one mode.** Without a `user_lookup` block the dispatcher starts in **mock
mode** — it personalizes with fabricated data while appearing perfectly healthy.

<!-- prettier-ignore -->
| Mode | The dispatcher | Choose it when |
| --- | --- | --- |
| `database` | Connects read-only to your database and `SELECT`s the columns you map | You are comfortable granting a read-only user |
| `network` | Calls an HTTPS endpoint you host, with a bearer token | Your data is behind a service, or policy forbids direct DB access |
| `mock` | Fabricates recipients | Local trials only |

> ⚠️ **`.env.yaml` holds credentials** — a database password or a bearer token.
> `chmod 600 .env.yaml`, keep it out of version control, and treat it exactly
> like any other credential store. In Kubernetes it is a Secret mounted at
> `defaultMode: 0400`,
> never a ConfigMap.

### 6.1 `mode: database`

```yaml
version: 1

user_lookup:
  mode: database
  backend: postgres # postgres | mysql | sqlite

  # Read-only credentials for YOUR customer database.
  connection:
    host: db.internal # see §6.3 for what to put here
    port: 5432
    user: dispatcher_ro
    password: "a-long-random-password" # or: password_env: DB_PASSWORD
    database: your_db
    ssl: true

  source:
    kind: table # table | view
    name: customers # your table
    id_column: external_id # the column holding the ID ScaleMargin sends
    id_type: string # string | int | bigint | uuid

  # Your column for each contact field. The lookup returns these and nothing
  # else: `email` to send email, `phone` to send WhatsApp.
  # Personalization (names, company, …) is variables: a `field` variable reads
  # any other column of `source`, and only the columns in use are ever read.
  fields:
    email: email_address
    phone: mobile_number

  batch:
    max_ids_per_query: 1000
    dedupe: true
```

**A view is often the better answer.** Rather than granting access to a customer
table, expose exactly the columns the dispatcher needs:

```sql
CREATE VIEW dispatcher_recipients AS
  SELECT external_id, email_address, given_name, family_name, mobile_number, account_name
  FROM customers
  WHERE deleted_at IS NULL AND marketing_consent = true;
```

Then set `kind: view` and `name: dispatcher_recipients`. Consent filtering
happens in your database, where it belongs. **The view is also your allow-list:**
a `field` variable can read any column the view has, and no column it lacks.

**The database user** — grant `SELECT` only. The dispatcher never writes to your
database, so a read-only user is not a restriction, it is a guarantee.

```sql
-- PostgreSQL
CREATE USER dispatcher_ro WITH PASSWORD 'a-long-random-password';
GRANT CONNECT ON DATABASE your_db TO dispatcher_ro;
GRANT USAGE ON SCHEMA public TO dispatcher_ro;
GRANT SELECT ON dispatcher_recipients TO dispatcher_ro;   -- that view only
```

```sql
-- MySQL
CREATE USER 'dispatcher_ro'@'%' IDENTIFIED BY 'a-long-random-password';
GRANT SELECT ON your_db.dispatcher_recipients TO 'dispatcher_ro'@'%';
FLUSH PRIVILEGES;
```

For `backend: sqlite`, replace the connection block with a path:
`connection: { file: /app/data/customers.sqlite }`.

### 6.2 `mode: network`

The dispatcher never touches your database. It POSTs a batch of IDs to an
endpoint you host and you return the contact details.

```yaml
version: 1

user_lookup:
  mode: network
  network:
    url: https://api.your-company.com/scalemargin/lookup
    token: "the-bearer-token" # or: token_env: LOOKUP_API_TOKEN
    timeout_ms: 3000
    retries: 2 # 5xx and timeouts only; 4xx is never retried

  # Contact details only — email and phone. Any other key is ignored, with a
  # warning at boot. The right-hand side is YOUR name for it; we ask for and
  # read back that name. An email send asks only for email, a WhatsApp send
  # only for phone.
  fields:
    email: email
    phone: phone

  batch:
    max_ids_per_query: 500
    dedupe: true
```

We send (for an email campaign; a WhatsApp one sends `"channel": "whatsapp"`
and `phone` instead of `email`):

```json
{ "user_ids": ["usr_1", "usr_2"], "channel": "email", "fields": ["email"] }
```

You return:

```json
{ "users": [{ "user_id": "usr_1", "email": "ada@example.com" }] }
```

Omit anyone you cannot resolve — a missing ID skips that recipient and the rest
of the campaign still sends. **The full contract, with error handling, batching
and a worked implementation, is in
[`docs/user-lookup-network-contract.md`](docs/user-lookup-network-contract.md)** — that
is the page to hand to whoever builds the endpoint.

There is no `source:` block, because there is no table to point at, and no
`connection:`, because there is no database to connect to.

> **Two variable types are unavailable in network mode.** `field` reads a column
> of your database and `query` runs SQL against it; with no connection neither
> can produce a value, so the dispatcher refuses to create them and the
> ScaleMargin platform hides both options. Any that already exist are kept but
> sit inactive, rendering their fallback, until you switch back to `database`
> mode. Personalize with `api`, `computed` and `constant` variables instead —
> `GET /api/v1/data-plane/lookup/fields` tells a client what is available.

### 6.3 What to put in `connection.host`

This trips people up, because the dispatcher is inside a container.

| Your database runs                      | `host`                 | Extra step                                                                                       |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Managed service (RDS, Cloud SQL, Neon…) | The service hostname   | Allow the host's IP in the firewall                                                              |
| Another server                          | Its hostname or IP     | —                                                                                                |
| **On the Docker host itself**           | `host.docker.internal` | On Linux, add to the dispatcher service:<br>`extra_hosts: ["host.docker.internal:host-gateway"]` |
| In another compose stack                | The service name       | Attach both to the same external network                                                         |

`localhost` here means _inside the dispatcher container_, which is almost never
what you want.

### 6.4 Upgrading from an older dispatcher

Two things moved into `.env.yaml`, and both old forms still work for now:

<!-- prettier-ignore -->
| Was | Now | Status |
| --- | --- | --- |
| `config/dispatch.yaml` | `user_lookup:` in `.env.yaml` | Still read if `.env.yaml` has no `user_lookup` block. Logs a deprecation warning at boot; will be removed in a future release |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_SSL` | `user_lookup.connection:` | Still read from the environment if there is no `connection:` block. Logs a warning |

`.env.yaml` always wins. Precedence is **per file, not per key** — an inline
`connection:` block ignores every `DB_*` variable, rather than merging with
them, so there is never a configuration that is half from one place and half
from the other.

To migrate: copy the `user_lookup:` block out of `config/dispatch.yaml` into
`.env.yaml`, add `mode: database` at the top of it, move the `DB_*` values into
`connection:`, then delete `config/dispatch.yaml` and its volume mount. Your
`placeholders:` block does **not** move — variables live in the dispatcher's own
database and are edited from the ScaleMargin platform. Anything still in
`config/dispatch.yaml` was seeded on first boot and is already there.

---

## 7. `.env.yaml` — senders and deployment settings (optional)

Same file as §6, second half. Skip §7.1–7.4 if you send from a single address —
everything above already works with one provider and one `FROM_EMAIL`. §7.5 is
independent of senders and useful on its own.

Add a `senders:` block when you want any of:

- **Several sending accounts**, with traffic split between them
- **Automatic failover** — if one account starts rejecting messages, the next takes over
- **Different accounts per organization**, when you run more than one brand
- **WhatsApp as well as email**

### 7.1 Keep the sending secrets out of this file

Every provider credential can be written two ways:

<!-- prettier-ignore -->
| In `.env.yaml` | Meaning |
| --- | --- |
| `api_key_env: SENDGRID_API_KEY` | **Recommended.** Read the value from a variable named `SENDGRID_API_KEY` — set in the container's `environment:` or the `env:` map (§5.2) |
| `api_key: SG.xxxxx` | The literal key, written here |

Prefer the `_env` form if you template this file into version control — it
keeps the key itself out of the file. If the file is already a mounted Secret,
writing the value inline is equally safe and simpler to read.

> ⚠️ **The `_env` suffix is the whole difference.** `api_key: SENDGRID_API_KEY`
> does **not** read an environment variable. It sets your API key to the literal
> text `SENDGRID_API_KEY`, and the first send fails with an authentication
> error. The dispatcher cannot warn you, because any string is a plausible key
> as far as it knows.

This does **not** make `.env.yaml` safe to circulate: the `user_lookup`
credentials in §6 are written inline. Treat the file as a secret regardless.

### 7.2 A working example

Two email accounts and one WhatsApp account. These keys sit alongside the
`user_lookup:` block from §6 in the same `.env.yaml` — `version: 1` appears once.

```yaml
version: 1

routing:
  failover:
    max_attempts: 2 # attempts per recipient, across accounts
    on_timeout: false # never retry an unclear outcome — avoids duplicates
    on_identity_error: false # an unverified sender is a config fault, not a blip
    breaker:
      failure_threshold: 5 # consecutive failures before an account is parked
      cooldown_ms: 60000 # how long it stays parked
  default_sender:
    email: primary-ses
    whatsapp: primary-wa

senders:
  - id: primary-ses
    channel: email
    provider: ses
    organizations: ["*"] # ["*"] = every org, or ["org_1", "org_2"]
    from: "campaigns@your-domain.com"
    reply_to: "support@your-domain.com"
    weight: 3 # roughly 3x the traffic of a weight-1 account
    enabled: true
    ses:
      region: ap-south-1
      configuration_set: ses-events # needed for open/click/bounce tracking
      access_key_id_env: AWS_ACCESS_KEY_ID
      secret_access_key_env: AWS_SECRET_ACCESS_KEY

  - id: backup-sendgrid
    channel: email
    provider: sendgrid
    organizations: ["*"]
    from: "campaigns@your-domain.com"
    weight: 1
    enabled: true
    sendgrid:
      api_key_env: SENDGRID_API_KEY
      event_webhook_public_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY

  - id: primary-wa
    channel: whatsapp
    provider: gupshup
    organizations: ["*"]
    weight: 1
    enabled: true
    gupshup:
      mode: api_key # api_key | enterprise
      api_key_env: GUPSHUP_API_KEY
      src_name: YourAppName
      source: "919999999999" # sender number, digits only
      default_template: welcome_v1
      template_language: en
      webhook_secret_env: GUPSHUP_WEBHOOK_SECRET
```

A template covering every provider, including Freshchat for WhatsApp, ships in
the package as `.env.yaml.example`.

### 7.3 What each field does

**Per account:**

<!-- prettier-ignore -->
| Field | Meaning |
| --- | --- |
| `id` | Your name for the account. It appears in reporting and logs — make it recognisable |
| `channel` | `email` or `whatsapp` |
| `provider` | `ses`, `sendgrid`, `gupshup` or `freshchat` |
| `organizations` | `["*"]` for all, or a list of organization IDs this account may send for |
| `from` | The sending address. Must be verified with the provider |
| `reply_to` | Optional. Where replies go, if different |
| `weight` | Share of traffic. `3` gets roughly three times as much as `1`. **`0` means never chosen automatically** |
| `enabled` | `false` parks the account without deleting its configuration |

**Routing:**

<!-- prettier-ignore -->
| Field | Meaning |
| --- | --- |
| `default_sender` | Which account to use per channel when nothing else applies |
| `max_attempts` | How many accounts to try for one recipient before giving up |
| `on_timeout` | Retry when the outcome is unclear. **Leave `false`** — a timeout often means the message *was* sent, and retrying delivers it twice |
| `on_identity_error` | Retry on an unverified-sender error. **Leave `false`** — that is broken configuration, and the next account fails the same way |
| `failure_threshold` | Consecutive failures before an account is parked |
| `cooldown_ms` | How long it stays parked before being tried again |

Recipients are spread across accounts by a stable hash, so the same recipient
consistently uses the same account. That warms sender reputation evenly instead
of at random, and keeps a person's mail coming from one address.

### 7.4 Check it loaded

```bash
docker compose up -d
docker compose logs dispatcher | grep -i "env.yaml"
```

<!-- prettier-ignore -->
| What you see | Meaning |
| --- | --- |
| `Loaded .env.yaml multi-sender configuration` | Working |
| `No .env.yaml found — using single-sender back-compat configuration from environment` | Not picked up. The dispatcher **still sends**, using the single account from `email:` |
| `references missing env var 'X'` | An `_env` field names a variable that does not exist — add it to the `env:` map or the container's `environment:` |

The middle line is the one to watch for. A `.env.yaml` that fails to load stops
nothing — sending carries on with one account, and you only notice when the
traffic split and failover you configured never happen.

To see what the dispatcher actually loaded:

```bash
curl -s -H "Authorization: Bearer $DISPATCHER_ATLAS_KEY" \
  localhost:3100/api/v1/data-plane/senders | jq
```

```json
{
  "generated_at": "2026-08-27T10:00:00.000Z",
  "senders": [
    {
      "id": "primary-ses",
      "channel": "email",
      "provider": "ses",
      "from": "campaigns@your-domain.com",
      "weight": 3,
      "enabled": true,
      "organizations": ["*"],
      "breaker_state": "closed"
    }
  ]
}
```

`breaker_state` is `closed` when healthy, `open` when the account has been
parked after repeated failures, and `half_open` while it is being tried again.
No credentials appear in this response, so it is safe to paste into a support
thread.

### 7.5 Deployment settings in `.env.yaml` (optional)

Four settings that describe how this deployment is reached. Useful when your
deployment templates `.env.yaml` as a single secret and you would rather not
maintain two files.

```yaml
dispatcher:
  port: 3100
  public_url: https://dispatcher.your-company.com
  atlas_key: "the-key-you-shared-with-us" # or: atlas_key_env: DISPATCHER_ATLAS_KEY
  atlas_cors_origins:
    - https://atlas.scalemargin.com
```

<!-- prettier-ignore -->
| Key | Replaces | If set in neither place |
| --- | --- | --- |
| `port` | `PORT` | `3100` |
| `public_url` | `DISPATCHER_PUBLIC_URL` | Falls back to `UNSUBSCRIBE_URL_BASE`, then `localhost` |
| `atlas_key` | `DISPATCHER_ATLAS_KEY` | **The management API is off** — every route returns 503 |
| `atlas_cors_origins` | `DISPATCHER_ATLAS_CORS_ORIGINS` | No CORS headers; server-to-server calls only |

**Nothing changes if you skip this.** The environment variables are not
deprecated and every existing deployment keeps working untouched.

Two details worth knowing:

- **Precedence is per key here**, unlike the `connection:` block in §6, which is
  per file. `port` from the environment and `atlas_key` from this file is an
  ordinary setup, not a half-migration.
- **A typo is rejected at boot**, not ignored. `atlas_keys:` fails to start
  rather than silently leaving the management API disabled — which is the
  failure you would otherwise discover when ScaleMargin cannot reach you.

`atlas_cors_origins` also accepts a comma-separated string, so you can paste the
old environment variable value straight in.

### 7.6 Changing it later

`.env.yaml` is read once at startup:

```bash
docker compose restart dispatcher
```

If the file has a mistake, the dispatcher logs the problem and falls back to
single-sender — it does not refuse to start. Always re-check the log line in
§7.4 after a change.

---

## 8. Start it

```bash
docker compose up -d
docker compose logs -f dispatcher
```

Migrations run automatically on first boot — there is no separate step.

### What a healthy first boot looks like

```
Dispatcher started {"port":3100,"provider":"ses","node_env":"production"}
[UserLookup][postgres] Resolved 0/0 users
```

### Verify, in order

```bash
# 1. The process is alive
curl -s localhost:3100/health
# {"status":"ok"}

# 2. Dependencies are actually reachable
curl -s localhost:3100/api/v1/internal/ready | jq
# every check "ok": true

# 3. Recipient lookup is wired up
docker compose logs dispatcher | grep -i "UserLookup"

# 4. NOT in mock mode  — this must print nothing
docker compose logs dispatcher | grep -i "MOCK user lookup"

# 5. Sender is configured — this must also print nothing
docker compose logs dispatcher | grep -i "FROM_EMAIL is not set"
```

```bash
# 6. Management API is enabled (only if you set DISPATCHER_ATLAS_KEY)
curl -s -H "Authorization: Bearer $DISPATCHER_ATLAS_KEY" \
  localhost:3100/api/v1/data-plane/build | jq '.service'
# => version, git_sha, build_time

# 7. The lookup mode is the one you configured
curl -s -H "Authorization: Bearer $DISPATCHER_ATLAS_KEY" \
  localhost:3100/api/v1/data-plane/state | jq '.lookup'
```

```json
{
  "mode": "database",
  "backend": "postgres",
  "supported_variable_sources": [
    "field",
    "computed",
    "constant",
    "query",
    "api"
  ]
}
```

`"mode": "mock"` here means the dispatcher did not find your `user_lookup`
block — it will run, and mail nobody real. In `network` mode `backend` is `null`
and `query` is absent from the list (§6.2).

Tell your ScaleMargin contact you are up, and give them the `DISPATCHER_ATLAS_KEY`
value plus your dispatcher's URL. They will send one test campaign to an address
you nominate.

---

## 9. Exposing the dispatcher (only if you need to)

Everything above works with the dispatcher bound to localhost. You need inbound
access for two optional things:

| Feature                                        | Needs                          | Path                        |
| ---------------------------------------------- | ------------------------------ | --------------------------- |
| Delivery / open / click tracking               | Your provider to POST webhooks | `/api/scalemargin/*-events` |
| Managing variables, reading campaigns and logs | ScaleMargin to reach the API   | `/api/v1/data-plane/*`      |

Since there is no local console, the second row is how you administer this
dispatcher at all. If you cannot expose it, everything still sends — you just
manage configuration through us instead of directly.

Put a TLS-terminating reverse proxy in front. Nginx:

```nginx
server {
  listen 443 ssl;
  server_name dispatcher.yourdomain.com;

  ssl_certificate     /etc/letsencrypt/live/dispatcher.yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dispatcher.yourdomain.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # No /admin rule needed — the console is not shipped and the route 503s.
}
```

Then set `dispatcher.public_url: https://dispatcher.yourdomain.com` in
`.env.yaml` and restart. The dispatcher trusts exactly one proxy hop, which is what lets it set
secure cookies correctly.

`/api/v1/internal/*` is for your own monitoring and should **not** be exposed.

### Browser access to the management API (CORS)

By default the dispatcher sends **no CORS headers**, so a web page cannot call
`/api/v1/data-plane/*` — only server-to-server calls work. That is deliberate:
any browser able to reach that API must carry `DISPATCHER_ATLAS_KEY`, and that
key grants full read access and cannot be revoked without a restart.

Set `DISPATCHER_ATLAS_CORS_ORIGINS` only if ScaleMargin tells you their console
calls your dispatcher directly from the browser rather than from their backend:

```bash
DISPATCHER_ATLAS_CORS_ORIGINS=https://atlas.scalemargin.com,https://staging.atlas.example
```

Comma-separated, absolute origins, scheme included. The dispatcher warns at boot
if you use `*`, list an unparseable entry, or use plaintext `http://` for
anything other than localhost — the last one would put your API key on the wire
in clear.

Authentication is a bearer header rather than a cookie, so the dispatcher never
sends `Access-Control-Allow-Credentials`.

---

## 10. Day-two operations

### Upgrading

```bash
# 1. Change the image tag in docker-compose.yml to the version we specify
# 2. Pull and restart
docker compose pull
docker compose up -d

# 3. Confirm
curl -s localhost:3100/api/v1/internal/ready | jq '.checks'
```

Migrations apply automatically. **Back up first** — see below. Pin an explicit
version; never use `latest`, or an unattended `pull` becomes an unplanned
upgrade.

### Backups

The `dispatcher-postgres-data` volume holds campaign history, logs and the
outgoing event queue. Your customer data is not in it.

```bash
docker compose exec -T postgres \
  pg_dump -U dispatcher dispatcher_state | gzip > dispatcher-$(date +%F).sql.gz
```

Restore:

```bash
gunzip -c dispatcher-2026-08-20.sql.gz | \
  docker compose exec -T postgres psql -U dispatcher -d dispatcher_state
```

### Logs

```bash
docker compose logs -f dispatcher              # live
docker compose logs dispatcher | grep -i warn  # problems only
```

The same logs are browsable in the ScaleMargin platform with filters for level,
component and campaign — usually faster than the terminal, and it works without
shell access to this machine.

### Stopping

```bash
docker compose down            # stop, keep all data
docker compose down -v         # stop and DELETE all campaign history. Careful.
```

---

## 11. Troubleshooting

| Symptom                                                            | Cause                                                                                   | Fix                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Container exits immediately, `[FATAL] Missing required env vars`   | `scalemargin:` secrets blank or the block missing                                       | Fill `dispatch_secret` and `analytics_secret` in `.env.yaml` — §5                                                       |
| `denied` or `unauthorized` pulling the image                       | Not an auth problem — the image is public and needs no login                            | Check the tag is spelled right; then tell us, it may be a publishing fault on our side                                 |
| Pull hangs or times out                                            | Egress to `ghcr.io` is filtered                                                         | Allowlist `ghcr.io` and `pkg-containers.githubusercontent.com` — §3                                                    |
| `manifest unknown`                                                 | That version tag does not exist                                                         | Use the exact tag from our release note; do not invent version numbers                                                 |
| `exec format error`                                                | Image architecture mismatch                                                             | Tell us your platform — we will publish a matching build                                                               |
| Sends fail with `403 Forbidden` or `Email address is not verified` | `FROM_EMAIL` not verified in your provider                                              | Verify that exact address, or use one that is                                                                          |
| Campaigns report success but reach nobody real                     | No `user_lookup` block reached the container → mock mode                                | Step 7 in §8. Usually the `.env.yaml` mount, or a stray directory Docker created in its place                          |
| `getaddrinfo ENOTFOUND` for your database                          | `connection.host` unreachable from the container                                        | §6.3 — usually `host.docker.internal`                                                                                  |
| `Resolved 0/N users` on every send                                 | `id_column` or `id_type` mismatch — or, in network mode, your API returned no `user_id` match | Confirm the column holds the ID ScaleMargin sends; in network mode compare `user_id` values against what we sent  |
| Personalization shows fallbacks everywhere                         | `fields` map points at wrong columns or wrong field names                               | Compare the `fields:` block in `.env.yaml` with your schema (or your API's response keys)                             |
| The platform will not let you create a `query` variable            | **Expected in network mode** — there is no database to query                            | §6.2. Use `field`, `computed`, `constant` or `api` instead                                                             |
| Boot warns `Reading user lookup from config/dispatch.yaml`                  | Lookup config still in the old file                                                     | Migrate it into `.env.yaml` — §6.4                                                                                     |
| `password authentication failed` at boot                           | `DISPATCHER_DB_PASSWORD` changed after the volume was created                           | Postgres keeps the original password. Either restore it, or `docker compose down -v` and start fresh (deletes history) |
| No opens or clicks recorded                                        | Provider webhooks not configured, or dispatcher not reachable                           | §9, and confirm `SES_EVENT_CONFIG_SET` for SES                                                                         |
| `/admin` returns 503                                               | **Expected** — no console is shipped in this image                                      | Manage through the ScaleMargin platform                                                                                |
| Traffic split / failover not happening                             | `.env.yaml` did not load; still on a single account                                     | §7.4 — check the boot log                                                                                              |
| Provider rejects every message with an auth error                  | Used `api_key:` where you meant `api_key_env:`                                          | §7.1                                                                                                                   |
| `.env.yaml` exists but the dispatcher cannot read it               | Docker created it as a _directory_ because the file was missing when you first ran `up` | `rm -rf .env.yaml`, create the real file, then `docker compose up -d`                                                  |
| ScaleMargin cannot reach the dispatcher                            | Not exposed, or `DISPATCHER_ATLAS_KEY` unset                                            | §9, and confirm the key is set and shared                                                                              |
| `EADDRINUSE` on 3100                                               | Something else on that port                                                             | Change the host side: `"127.0.0.1:3200:3100"`                                                                          |

Still stuck? Send us:

```bash
docker compose logs --tail=200 dispatcher > dispatcher-logs.txt
curl -s localhost:3100/api/v1/internal/ready > ready.json
```

Both are safe to share — neither contains customer data, passwords or
connection strings.

---

## 12. Security summary

- The dispatcher holds **read-only** credentials to your customer database — or,
  in network mode, no database credentials at all.
- Customer data never leaves your network. ScaleMargin receives counts, opaque
  IDs and timestamps — never names, addresses, phone numbers or message content.
- Provider error messages are scrubbed of email addresses, phone numbers and IPs
  before they are stored or shared.
- Both databases live on machines you control.
- **`.env.yaml` is the only file, and it holds every secret.** `chmod 600` it,
  keep it out of version control, and back it up as you would any other
  credential. It carries your customer-database password, your lookup token and
  your management key — it is not a file to circulate or paste into a ticket.
- The Atlas key is the only management credential, and leaving it unset turns
  the management API off entirely.

---

## 13. `.env.yaml` — the complete reference

Everything the dispatcher reads, in one file. Nothing here is required; delete
any block you do not need. The same content ships as `.env.yaml.example`.

Skip to §13.2 for four worked environments — local, staging, production, and
network-lookup — if you would rather start from something closer to your case.

### 13.1 Every block

```yaml
version: 1

# ═══ dispatcher: — THIS SERVICE ════════════════════════════════════════════
# Everything about how the dispatcher itself runs. What it DOES — lookup,
# sending, links, events, images — is top-level, below.
dispatcher:
  # ── How it is reached ──────────────────────────────────────────────────
  port: 3100
  public_url: https://dispatcher.your-company.com

  # ── Who may reach it ───────────────────────────────────────────────────
  atlas_key: "32-char-random" # or: atlas_key_env: DISPATCHER_ATLAS_KEY
  atlas_cors_origins: # omit entirely for server-to-server only
    - https://atlas.scalemargin.com
  # logs_api_token: "…"       # overrides the console-managed logs token
  # logs_api_token_env: DISPATCHER_LOGS_API_TOKEN

  # ── Its own database ───────────────────────────────────────────────────
  database:
    dialect: postgres # sqlite | mysql | postgres
    host: postgres
    port: 5432
    user: dispatcher
    password: "…" # or: password_env: DISPATCHER_DB_PASSWORD
    database: dispatcher_state
    # url: postgres://user:pass@host:5432/db    # wins over the fields above
    # file: ./data/dispatcher.db                # dialect: sqlite only

  # ── Admin console and session security ─────────────────────────────────
  admin:
    auth_secret: "32-char-random" # generated if omitted; set it in production
    # api_key_encryption_secret_env: DISPATCHER_API_KEY_ENCRYPTION_SECRET
    # email: operator@your-company.com
    # password_env: DISPATCHER_ADMIN_PASSWORD
    # cookie_secure: true
    # trusted_origins: [https://console.your-company.com]
    # auth_secret_file: ./data/.better-auth-secret           # where a generated secret persists
    # credentials_file: ./data/initial-admin-credentials.txt # first-boot login

  # ── Retention ──────────────────────────────────────────────────────────
  retention:
    # REQUIRED, no default. How long provider message ids are kept in
    # `provider_message_ids` for you to query. "5d 2h", "12h", "30d".
    # Minimum 1h; the sweep runs hourly. See §5.3.
    message_id_ttl: "5d 2h"
    # log_days: 14
    # log_max_rows: 200000
    # campaign_event_days: 90
    # campaign_event_max_rows: 500000
    # outbox_max_attempts: 10

  # ── Logging and telemetry ──────────────────────────────────────────────
  # logging:
  #   level: info                # trace | debug | info | warn | error | fatal
  # telemetry:
  #   disabled: false

# ═══ scalemargin: — platform credentials (from onboarding)  REQUIRED ══════
scalemargin:
  dispatch_secret: "…"
  analytics_secret: "…"
  # dispatch_secret_env: SCALEMARGIN_DISPATCH_SECRET
  # analytics_secret_env: SCALEMARGIN_ANALYTICS_SECRET
  # analytics_callback_url: https://api.scalemargin.com/analytics

# ═══ user_lookup: — where recipient data comes from. PICK ONE MODE (§6) ═══
user_lookup:
  mode: database # database | network | mock
  backend: postgres
  connection:
    host: db.internal
    port: 5432
    user: dispatcher_ro
    password: "…"
    database: customers
    ssl: true
  source:
    kind: view
    name: dispatcher_recipients
    id_column: external_id
    id_type: string
  fields:
    email: email_address
    phone: mobile_number
  batch:
    max_ids_per_query: 1000
    dedupe: true

# ═══ email: — sending, one-account shorthand ══════════════════════════════
email:
  provider: ses # ses | sendgrid
  from: campaigns@your-company.com
  reply_to: support@your-company.com

# ═══ routing: + senders: — several accounts, weights, failover (§7) ═══════
# `senders:` wins over `email:` above when both are present.
routing:
  failover:
    max_attempts: 2
    on_timeout: false
    on_identity_error: false
    breaker: { failure_threshold: 5, cooldown_ms: 60000 }
  default_sender:
    email: primary-ses
    whatsapp: primary-wa

senders:
  - id: primary-ses
    channel: email
    provider: ses
    organizations: ["*"]
    from: campaigns@your-company.com
    weight: 3
    enabled: true
    ses:
      region: ap-south-1
      configuration_set: ses-events
      access_key_id_env: AWS_ACCESS_KEY_ID
      secret_access_key_env: AWS_SECRET_ACCESS_KEY

# ═══ links: — URLs inside messages ════════════════════════════════════════
links:
  unsubscribe_url_base: https://dispatcher.your-company.com
  # logo_url: https://cdn.your-company.com/logo.png
  # unsubscribe_redirect_url: https://your-company.com/goodbye
  # preferences_redirect_url: https://your-company.com/preferences
  # unsubscribe_reasons: [Too many emails, Not relevant, I never signed up]

# ═══ events: — the event pipeline ═════════════════════════════════════════
# events:
#   batch_size: 100
#   batch_interval_ms: 5000
#   buffer_dir: ./data/events
#   sendgrid_inbound_events: "*"
#   providers_enabled: [ses, sendgrid]
#   debug: false
#   config_path: ./config/events.yaml

# ═══ storage: — campaign images ═══════════════════════════════════════════
# storage:
#   provider: local                  # local | s3 | gcs
#   local_dir: ./public/images
#   local_base_url: https://dispatcher.your-company.com/images
#   # s3_bucket / s3_region / s3_prefix / cdn_base_url
#   # gcs_bucket / gcs_project_id / gcs_credentials_json_env

# ═══ env: — escape hatch: anything not modelled above, set verbatim ═══════
# Lowest precedence. This is where provider keys live now that there is no
# `.env`, and where the targets of any `_env:` reference above must exist.
env:
  AWS_ACCESS_KEY_ID: "…"
  AWS_SECRET_ACCESS_KEY: "…"
  # SENDGRID_API_KEY: "SG.…"
  # GUPSHUP_API_KEY: "…"
  # FRESHCHAT_API_KEY: "…"
```

### 13.2 Four worked environments

#### A. Local development — nothing real, nothing sent

Mock lookup means no customer database. SQLite means no Postgres container.

```yaml
version: 1

dispatcher:
  database:
    dialect: sqlite
    file: ./data/dispatcher.db

  retention:
    message_id_ttl: "2h" # REQUIRED — short locally; ids are throwaway here

  logging:
    level: debug

  telemetry:
    disabled: true

scalemargin:
  dispatch_secret: "local-dev-placeholder"
  analytics_secret: "local-dev-placeholder"

user_lookup:
  mode: mock # fabricates recipients; mails nobody real

email:
  provider: ses
  from: dev@example.com
```

#### B. Staging — real data, real sending, loose retention

```yaml
version: 1

dispatcher:
  port: 3100
  public_url: https://dispatcher.staging.your-company.com
  atlas_key_env: DISPATCHER_ATLAS_KEY # injected by the platform
  atlas_cors_origins:
    - https://staging.atlas.scalemargin.com

  database:
    dialect: postgres
    host: postgres
    user: dispatcher
    password_env: DISPATCHER_DB_PASSWORD
    database: dispatcher_state

  retention:
    message_id_ttl: "2d" # REQUIRED
    log_days: 3 # staging logs are noise after a few days
    campaign_event_days: 14

  logging:
    level: debug

scalemargin:
  dispatch_secret_env: SCALEMARGIN_DISPATCH_SECRET
  analytics_secret_env: SCALEMARGIN_ANALYTICS_SECRET

user_lookup:
  mode: database
  backend: postgres
  connection:
    host: staging-db.internal
    user: dispatcher_ro
    password_env: DB_PASSWORD
    database: customers_staging
    ssl: true
  source:
    { kind: view, name: dispatcher_recipients, id_column: external_id }
  fields:
    email: email_address

email:
  provider: sendgrid
  from: staging@your-company.com

links:
  unsubscribe_url_base: https://dispatcher.staging.your-company.com

env:
  SENDGRID_API_KEY: "SG.staging-key"
```

Every secret here is a `_env` reference, so this file can live in version
control and the real values are injected by the platform.

#### C. Production — multi-sender, failover, strict retention

```yaml
version: 1

dispatcher:
  port: 3100
  public_url: https://dispatcher.your-company.com
  atlas_key_env: DISPATCHER_ATLAS_KEY
  atlas_cors_origins:
    - https://atlas.scalemargin.com

  database:
    dialect: postgres
    url_env: DISPATCHER_DB_URL

  admin:
    auth_secret_env: BETTER_AUTH_SECRET # stable across redeploys
    api_key_encryption_secret_env: DISPATCHER_API_KEY_ENCRYPTION_SECRET
    cookie_secure: true

  retention:
    message_id_ttl: "30d" # REQUIRED — how long you can poll the provider
    log_days: 14
    campaign_event_days: 90
    campaign_event_max_rows: 500000

  logging:
    level: info # debug on a production send path is a lot of rows

scalemargin:
  dispatch_secret_env: SCALEMARGIN_DISPATCH_SECRET
  analytics_secret_env: SCALEMARGIN_ANALYTICS_SECRET

user_lookup:
  mode: database
  backend: postgres
  connection:
    host: prod-db.internal
    user: dispatcher_ro
    password_env: DB_PASSWORD
    database: customers
    ssl: true
  source:
    kind: view
    name: dispatcher_recipients
    id_column: external_id
    id_type: uuid
  fields:
    email: email_address
    phone: mobile_number
    first_name: given_name
  batch:
    max_ids_per_query: 1000
    dedupe: true

routing:
  failover:
    max_attempts: 2
    on_timeout: false # a timeout often means it WAS sent
    on_identity_error: false # an unverified sender fails the same way twice
    breaker: { failure_threshold: 5, cooldown_ms: 60000 }
  default_sender:
    email: primary-ses

senders:
  - id: primary-ses
    channel: email
    provider: ses
    organizations: ["*"]
    from: campaigns@your-company.com
    weight: 3
    enabled: true
    ses:
      region: ap-south-1
      configuration_set: ses-events
      access_key_id_env: AWS_ACCESS_KEY_ID
      secret_access_key_env: AWS_SECRET_ACCESS_KEY

  - id: backup-sendgrid
    channel: email
    provider: sendgrid
    organizations: ["*"]
    from: campaigns@your-company.com
    weight: 1
    enabled: true
    sendgrid:
      api_key_env: SENDGRID_API_KEY
      event_webhook_public_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY

links:
  unsubscribe_url_base: https://dispatcher.your-company.com
  logo_url: https://cdn.your-company.com/logo.png

storage:
  provider: s3
  s3_bucket: prod-campaign-images
  s3_region: ap-south-1
  cdn_base_url: https://cdn.your-company.com
```

No `env:` block at all — every secret is injected by the platform, so this file
holds nothing sensitive.

#### D. Network lookup — we never touch your database

```yaml
version: 1

dispatcher:
  public_url: https://dispatcher.your-company.com
  atlas_key_env: DISPATCHER_ATLAS_KEY

  database:
    dialect: postgres
    url_env: DISPATCHER_DB_URL

  retention:
    message_id_ttl: "5d 2h" # REQUIRED

scalemargin:
  dispatch_secret_env: SCALEMARGIN_DISPATCH_SECRET
  analytics_secret_env: SCALEMARGIN_ANALYTICS_SECRET

user_lookup:
  mode: network
  network:
    url: https://api.your-company.com/scalemargin/lookup
    token_env: LOOKUP_API_TOKEN
    timeout_ms: 3000
    retries: 2
  fields:
    email: email
    phone: phone
  batch:
    max_ids_per_query: 500
    dedupe: true

email:
  provider: ses
  from: campaigns@your-company.com

links:
  unsubscribe_url_base: https://dispatcher.your-company.com
```

There is no `connection:` and no `source:` — there is no database to point at.
Remember that `source: query` variables cannot resolve in this mode (§6.2).

### 13.3 Things that will waste your afternoon

**An empty `.env.yaml` is a boot failure, not a no-op.** `yaml.load("")` is
`undefined` and the schema rejects it. Keep at least `version: 1`.

**Create the file before the first `docker compose up`.** If the bind-mount
source does not exist, Docker creates a *directory* in its place. The dispatcher
then boots in mock mode, looking perfectly healthy and mailing nobody real.

**An unknown key is rejected, not ignored.** `retention: { log_dayz: 14 }` fails
at boot rather than silently keeping the default. This is deliberate: a typo in
a retention or security setting that is quietly ignored is worse than one that
stops the container.

**A `_env:` reference to a variable that does not exist** is reported at boot.
It will not be stored as the literal name.

**Real environment variables win.** If a setting seems not to apply, check
whether something is already exporting it — `docker compose exec dispatcher env | grep NAME`.

**`dispatcher.retention.message_id_ttl` has no default and will stop the container.** It is
the only non-secret setting that does. `"5d 2h"`, minimum `1h` — §5.3.
