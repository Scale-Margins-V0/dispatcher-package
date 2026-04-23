# ScaleMargin dispatch handler (reference implementation)

Express service that:

1. Accepts **signed** campaign dispatch webhooks from ScaleMargin (`POST /api/scalemargin/dispatch`).
2. Resolves recipients via **configurable user lookup** (SQLite, MySQL, Postgres, HTTP, or mock).
3. Sends email through **AWS SES** or **SendGrid**.
4. Ingests **provider event webhooks** (SendGrid, SES/SNS, Gupshup) and forwards **HMAC-signed** analytics batches to ScaleMargin callback URLs.

---

## Prerequisites

- **Node.js** 20+ (global `fetch` and current syntax; CI often uses 22).
- **pnpm** 9.x — the repo pins it in `package.json` (`packageManager`). Enable via Corepack:

  ```bash
  corepack enable
  corepack prepare pnpm@9.15.4 --activate
  ```

---

## Install

From the repository root:

```bash
pnpm install
```

This installs dependencies and respects `pnpm-lock.yaml` for reproducible builds.

**Build** (TypeScript → `dist/`):

```bash
pnpm run build
```

**Run compiled output**:

```bash
pnpm run start
```

(`start` runs `node dist/index.js` — run `build` first.)

---

## Environment variables

1. **Copy the template** (never commit real secrets):

   ```bash
   cp .env.example .env
   ```

2. **Edit `.env`** with your values. The authoritative list of variables, grouped by feature, lives in [`.env.example`](.env.example). Highlights:

| Area | Required (typical prod) | Notes |
|------|---------------------------|--------|
| Core | `SCALEMARGIN_DISPATCH_SECRET`, `SCALEMARGIN_ANALYTICS_SECRET` | HMAC for inbound dispatch vs outbound analytics. |
| Server | `PORT`, `FROM_EMAIL`, `EMAIL_PROVIDER` | `EMAIL_PROVIDER` is `ses` or `sendgrid`. |
| SendGrid mail | `SENDGRID_API_KEY` | When `EMAIL_PROVIDER=sendgrid`. |
| SES mail | `AWS_REGION`, credentials or IAM role | When `EMAIL_PROVIDER=ses`. |
| Event pipeline | See **Events** in `.env.example` | SendGrid inbound needs `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` when enabled in `config/events.yaml`. |

3. **Local-only placeholders** — For quick local runs without Atlas secrets:

   ```bash
   pnpm run dev:local
   ```

   With `LOCAL_DEV=1`, missing `SCALEMARGIN_*` values get insecure defaults (see comments in `.env.example`). **Do not use in production.**

4. **Path overrides** (optional):

   - `USER_LOOKUP_CONFIG_PATH` — defaults to `./config/dispatch.yaml` if that file exists.
   - `EVENTS_CONFIG_PATH` — defaults to `./config/events.yaml` if that file exists.

---

## Configuration YAML

### Dispatch: user lookup and placeholders

- **Example:** [`config/dispatch.example.yaml`](config/dispatch.example.yaml)
- **Runtime file:** `config/dispatch.yaml` (create by copying the example)

```bash
cp config/dispatch.example.yaml config/dispatch.yaml
# Edit config/dispatch.yaml — backend (sqlite | mysql | postgres | http | mock), DB paths, HTTP profile URL, placeholders, etc.
```

If `config/dispatch.yaml` is **missing**, the app uses a **mock** user lookup with safe defaults so the server can still boot.

Details of fields, HTTP adapter, and SQL views: [`docs/user-lookup-contract.md`](docs/user-lookup-contract.md).

### Events: inbound webhooks and forwarding

- **Example:** [`config/events.example.yaml`](config/events.example.yaml)
- **Runtime file:** `config/events.yaml` (optional)

```bash
cp config/events.example.yaml config/events.yaml
# Edit providers.sendgrid / ses / gupshup enabled flags, forward mode, buffer, inbound_event_types, etc.
```

If `config/events.yaml` is **missing**, built-in defaults apply (see example header): SES inbound may be on; SendGrid inbound often **off** until you set keys and enable it.

- **Pipeline contract** (event types, adapters, extension): [`docs/event-pipeline-contract.md`](docs/event-pipeline-contract.md)
- **PII handling:** [`docs/pii-guarantees.md`](docs/pii-guarantees.md)

### Local data directory

[`data/`](data/) is **gitignored** (SQLite DBs, event buffers, local CSV captures). Create it as needed; `pnpm run seed:sqlite` can populate a dispatch DB — see [`docs/testing.md`](docs/testing.md).

---

## Run the server (development)

**Watch mode** (TypeScript directly via `tsx`):

```bash
pnpm run dev
```

**Watch + local dev secrets** (see above):

```bash
pnpm run dev:local
```

Health check: `GET http://localhost:3100/health` (or your `PORT`).

Main routes:

- `POST /api/scalemargin/dispatch` — ScaleMargin campaign dispatch (HMAC: `X-ScaleMargin-Signature`).
- `POST /api/scalemargin/sendgrid-events` — SendGrid Event Webhook (when enabled in events config).
- `POST /api/scalemargin/ses-notifications` — SES via SNS.
- `POST /api/scalemargin/gupshup-events` — Gupshup (when enabled).

---

## Tests

```bash
pnpm test                 # unit + integration
pnpm run test:unit        # fast unit specs only
pnpm run test:integration # includes SQLite / HTTP / dispatch E2E style tests
pnpm run test:coverage    # with coverage (if configured)
```

More detail: [`docs/testing.md`](docs/testing.md).

---

## Optional: dual-secret + SendGrid local smoke test

End-to-end style flow (ngrok, real sends, CSV capture of signed analytics) is documented here:

[`docs/event-dual-secret-local-test.md`](docs/event-dual-secret-local-test.md)

Entry point:

```bash
pnpm run dev:event-test
```

---

## Database seeding

```bash
pnpm run seed:sqlite
pnpm run seed:mysql    # set DB_* env vars first
pnpm run seed:postgres
```

See [`docs/testing.md`](docs/testing.md) for paths and env vars.

---

## Project layout (short)

| Path | Role |
|------|------|
| `src/index.ts` | Express app, dispatch route, provider webhook routes, optional CSV capture for local tests. |
| `src/events/` | Event pipeline (config, adapters, forwarder, buffer, scrubber). |
| `src/providers/` | SES / SendGrid send implementations. |
| `src/user-lookup/` | Dispatch-time user resolution. |
| `config/*.example.yaml` | Copy to `config/*.yaml` for local/prod. |
| `scripts/` | Seeds, HTTP profile mock, `event-dual-secret-test-server.ts`. |

---

## Documentation index

| Document | Topic |
|----------|--------|
| [`.env.example`](.env.example) | All environment variables (commented). |
| [`docs/user-lookup-contract.md`](docs/user-lookup-contract.md) | Dispatch YAML and user lookup backends. |
| [`docs/event-pipeline-contract.md`](docs/event-pipeline-contract.md) | Standardized events, forwarding, SendGrid allowlist. |
| [`docs/pii-guarantees.md`](docs/pii-guarantees.md) | What is stripped before analytics POSTs. |
| [`docs/event-dual-secret-local-test.md`](docs/event-dual-secret-local-test.md) | ngrok, SendGrid webhook, CSV capture, `dev:event-test`. |
| [`docs/testing.md`](docs/testing.md) | Vitest, seeds, mocks. |

---

## License / support

This repository is a **reference implementation** for integrating with ScaleMargin Atlas webhooks. Adjust policies, secrets, and infrastructure to match your organization before production use.
