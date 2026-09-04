# Deploying the ScaleMargin Dispatcher

**What you are installing.** One container that runs inside your infrastructure,
next to your customer database. ScaleMargin sends it campaigns containing
placeholders and opaque IDs; it looks up the real values in _your_ database,
personalizes each message, and sends through _your_ email provider. No customer
data ever reaches ScaleMargin.

**What it takes.** A `.env` file, a `config/dispatch.yaml` file, and
`docker compose up -d`. Roughly twenty minutes end to end.

---

## 1. Before you start

| You need                                   | Notes                                                         |
| ------------------------------------------ | ------------------------------------------------------------- |
| Docker Engine 24+ with Compose v2          | `docker --version`, `docker compose version`                  |
| 2 vCPU / 2 GB RAM / 10 GB disk             | Comfortable for millions of sends a month                     |
| Read-only access to your customer database | A dedicated user. See §6                                      |
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
| Configured by     | `DB_*` variables in `.env`               | `DISPATCHER_DB_*` — already set for you        |
| Runs where        | Wherever it already runs                 | The `postgres` service in this stack           |

The dispatcher never writes to your customer database. It reads the columns you
map in `config/dispatch.yaml` and nothing else.

---

## 3. Get the files

Create a directory and put these files in it:

```
dispatcher/
  docker-compose.yml     from §4 below
  .env                   from §5 below — you fill this in
  .env.yaml              from §7 below — only if you send from
                         more than one account
  config/
    dispatch.yaml        from §6 below — you fill this in
```

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
    env_file:
      - .env
    environment:
      # The dispatcher's OWN database — the postgres service below.
      # Do not point this at your customer database.
      DISPATCHER_DB_DIALECT: postgres
      DISPATCHER_DB_URL: postgres://dispatcher:${DISPATCHER_DB_PASSWORD}@postgres:5432/dispatcher_state
    volumes:
      # Which table and columns to read from your customer database.
      # Without this the dispatcher runs in MOCK mode and mails nobody real.
      - ./config/dispatch.yaml:/app/config/dispatch.yaml:ro
      # Multiple sending accounts (§7). DELETE this line if you use one account —
      # Docker creates an empty directory here if the file does not exist.
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
      POSTGRES_PASSWORD: ${DISPATCHER_DB_PASSWORD}
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

---

## 5. `.env`

Copy this template and fill in every line marked **REQUIRED**. Everything else
has a working default.

```bash
# ─────────────────────────────────────────────────────────────
# 1. ScaleMargin — from your onboarding email          REQUIRED
# ─────────────────────────────────────────────────────────────
SCALEMARGIN_DISPATCH_SECRET=
SCALEMARGIN_ANALYTICS_SECRET=

# ─────────────────────────────────────────────────────────────
# 2. The dispatcher's own database                     REQUIRED
#    Any long random string. Used by BOTH services in the
#    compose file, so set it once here.
#    Generate:  openssl rand -base64 24
# ─────────────────────────────────────────────────────────────
DISPATCHER_DB_PASSWORD=

# ─────────────────────────────────────────────────────────────
# 3. Sending                                           REQUIRED
# ─────────────────────────────────────────────────────────────
EMAIL_PROVIDER=ses                # ses | sendgrid

# The address recipients see. MUST be verified in your provider
# account, or every send is rejected. This is the single most
# common setup failure.
FROM_EMAIL=campaigns@yourdomain.com

# --- If EMAIL_PROVIDER=ses ---
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
# Omit both keys to use an IAM role instead (recommended on EC2/ECS).
# Required for open/click/bounce tracking:
SES_EVENT_CONFIG_SET=

# --- If EMAIL_PROVIDER=sendgrid ---
# SENDGRID_API_KEY=
# SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=

# ─────────────────────────────────────────────────────────────
# 4. YOUR customer database — read-only user           REQUIRED
#    This is NOT the dispatcher's database above.
# ─────────────────────────────────────────────────────────────
USER_LOOKUP_BACKEND=postgres      # postgres | mysql | sqlite | http
DB_HOST=                          # see section 6.3 for host values
DB_PORT=5432
DB_USER=dispatcher_ro
DB_PASSWORD=
DB_NAME=
DB_SSL=true

# ─────────────────────────────────────────────────────────────
# 5. ScaleMargin management access                    REQUIRED
#    This dispatcher has no local web console — you manage it
#    from the ScaleMargin platform. This key is what lets the
#    platform read its health, variables, campaigns and logs.
#    Leave it unset and that API stays completely off.
#    Generate:  openssl rand -base64 32
#    Then give the SAME value to your ScaleMargin contact.
# ─────────────────────────────────────────────────────────────
DISPATCHER_ATLAS_KEY=

#    Browser origins allowed to call that API (comma-separated,
#    absolute, https). LEAVE UNSET unless you are told otherwise:
#    unset means no CORS headers at all, so only server-to-server
#    calls work — which is the safe default, because anything
#    calling from a browser must carry DISPATCHER_ATLAS_KEY.
#    "*" is accepted but warns at boot; list real origins instead.
DISPATCHER_ATLAS_CORS_ORIGINS=https://atlas.scalemargin.com

# ─────────────────────────────────────────────────────────────
# 6. Service identity
#    Used for signed links and session security. Any long
#    random string;  openssl rand -base64 32
# ─────────────────────────────────────────────────────────────
BETTER_AUTH_SECRET=
DISPATCHER_PUBLIC_URL=http://localhost:3100

# ─────────────────────────────────────────────────────────────
# 7. Unsubscribe / preference links (set if you use them)
# ─────────────────────────────────────────────────────────────
# UNSUBSCRIBE_URL_BASE=https://dispatcher.yourdomain.com
```

Lock the file down — it holds two sets of database credentials and your provider
keys:

```bash
chmod 600 .env
```

---

## 6. `config/dispatch.yaml` — which data to read

This file maps the dispatcher to _your_ schema. It is required; without it the
dispatcher starts in **mock mode** and personalizes with fabricated data while
appearing perfectly healthy.

### 6.1 The file

```yaml
user_lookup:
  backend: postgres # must match USER_LOOKUP_BACKEND in .env

  source:
    kind: table # table | view
    name: customers # your table
    id_column: external_id # the column holding the ID ScaleMargin sends
    id_type: string # string | int | bigint | uuid

  # Logical name  →  your column name.
  # Only these columns are ever read. `email` is mandatory.
  fields:
    email: email_address
    first_name: given_name
    last_name: family_name
    phone: mobile_number
    company_name: account_name

  batch:
    max_ids_per_query: 1000
    dedupe: true

placeholders:
  first_name: { source: field, field: first_name, fallback: "there" }
  last_name: { source: field, field: last_name, fallback: "" }
  company_name: { source: field, field: company_name, fallback: "" }
  full_name:
    {
      source: computed,
      expr: "first_name + ' ' + last_name",
      fallback: "there",
    }
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
happens in your database, where it belongs.

### 6.2 The database user

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

Grant `SELECT` only. The dispatcher never writes to your database, so a
read-only user is not a restriction — it is a guarantee.

### 6.3 What to put in `DB_HOST`

This trips people up, because the dispatcher is inside a container.

| Your database runs                      | `DB_HOST`              | Extra step                                                                                       |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Managed service (RDS, Cloud SQL, Neon…) | The service hostname   | Allow the host's IP in the firewall                                                              |
| Another server                          | Its hostname or IP     | —                                                                                                |
| **On the Docker host itself**           | `host.docker.internal` | On Linux, add to the dispatcher service:<br>`extra_hosts: ["host.docker.internal:host-gateway"]` |
| In another compose stack                | The service name       | Attach both to the same external network                                                         |

`localhost` in `DB_HOST` means _inside the dispatcher container_, which is
almost never what you want.

---

## 7. Sending from more than one account (optional)

Skip this section entirely if you send from a single address. Everything above
already works — one provider, one `FROM_EMAIL`, done.

Add `.env.yaml` when you want any of:

- **Several sending accounts**, with traffic split between them
- **Automatic failover** — if one account starts rejecting messages, the next takes over
- **Different accounts per organization**, when you run more than one brand
- **WhatsApp as well as email**

The file sits next to `.env` and is mounted read-only by the compose file in §4.

### 7.1 Keep the secrets out of this file

Every credential can be written two ways:

<!-- prettier-ignore -->
| In `.env.yaml` | Meaning |
| --- | --- |
| `api_key_env: SENDGRID_API_KEY` | **Recommended.** Read the value from `SENDGRID_API_KEY` in your `.env` |
| `api_key: SG.xxxxx` | The literal key, written here |

Prefer the `_env` form. It keeps every secret in one file — `.env`, already
locked down with `chmod 600` — and leaves `.env.yaml` safe to read, diff and
hand to a colleague.

> ⚠️ **The `_env` suffix is the whole difference.** `api_key: SENDGRID_API_KEY`
> does **not** read an environment variable. It sets your API key to the literal
> text `SENDGRID_API_KEY`, and the first send fails with an authentication
> error. The dispatcher cannot warn you, because any string is a plausible key
> as far as it knows.

### 7.2 A working example

Two email accounts and one WhatsApp account:

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
| `No .env.yaml found — using single-sender back-compat configuration from environment` | Not picked up. The dispatcher **still sends**, using the single account from `.env` |
| `references missing env var 'X'` | An `_env` field names a variable that is not in your `.env` |

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

### 7.5 Changing it later

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

# 3. Your customer database is connected and mapped
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
```

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

Then set `DISPATCHER_PUBLIC_URL=https://dispatcher.yourdomain.com` in `.env` and
restart. The dispatcher trusts exactly one proxy hop, which is what lets it set
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
| Container exits immediately, `[FATAL] Missing required env vars`   | `SCALEMARGIN_*_SECRET` blank                                                            | Fill both in `.env`                                                                                                    |
| `denied` or `unauthorized` pulling the image                       | Not an auth problem — the image is public and needs no login                            | Check the tag is spelled right; then tell us, it may be a publishing fault on our side                                 |
| Pull hangs or times out                                            | Egress to `ghcr.io` is filtered                                                         | Allowlist `ghcr.io` and `pkg-containers.githubusercontent.com` — §3                                                    |
| `manifest unknown`                                                 | That version tag does not exist                                                         | Use the exact tag from our release note; do not invent version numbers                                                 |
| `exec format error`                                                | Image architecture mismatch                                                             | Tell us your platform — we will publish a matching build                                                               |
| Sends fail with `403 Forbidden` or `Email address is not verified` | `FROM_EMAIL` not verified in your provider                                              | Verify that exact address, or use one that is                                                                          |
| Campaigns report success but reach nobody real                     | `config/dispatch.yaml` not mounted → mock mode                                          | Check the volume mount and step 4 in §8                                                                                |
| `getaddrinfo ENOTFOUND` for your database                          | `DB_HOST` unreachable from the container                                                | §6.3 — usually `host.docker.internal`                                                                                  |
| `Resolved 0/N users` on every send                                 | `id_column` or `id_type` mismatch                                                       | Confirm the column holds the ID ScaleMargin sends                                                                      |
| Personalization shows fallbacks everywhere                         | `fields` map points at wrong columns                                                    | Compare `config/dispatch.yaml` with your schema                                                                        |
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

- The dispatcher holds **read-only** credentials to your customer database.
- Customer data never leaves your network. ScaleMargin receives counts, opaque
  IDs and timestamps — never names, addresses, phone numbers or message content.
- Provider error messages are scrubbed of email addresses, phone numbers and IPs
  before they are stored or shared.
- Both databases live on machines you control.
- `.env` is the only file holding secrets. `chmod 600` it, keep it out of version
  control, and back it up somewhere you would keep any other credential.
- `DISPATCHER_ATLAS_KEY` is the only management credential, and unsetting it
  turns the management API off entirely.
