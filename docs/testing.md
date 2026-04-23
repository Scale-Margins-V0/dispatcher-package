# Testing and local data

This repo uses **pnpm** (see `packageManager` in [package.json](../package.json)). Install dependencies:

```bash
pnpm install
```

## Unit tests

Fast, no external services:

```bash
pnpm run test:unit
```

## Integration tests

SQLite-backed adapter tests, an **HTTP user-lookup** test that binds the same Express app as [`dev:http-profile-mock`](../package.json) on an ephemeral port (real `fetch`, no stubbed `global.fetch`), and an end-to-end dispatch test (mocked email + analytics). Vitest sets `VITEST=true` automatically.

```bash
pnpm run test:integration
```

Run everything:

```bash
pnpm test
```

## Seeding databases

Shared fixtures live in [scripts/seed/fixtures/users.json](../scripts/seed/fixtures/users.json). DDL per engine is under [scripts/seed/schema/](../scripts/seed/schema/).

```bash
# SQLite (writes DB_FILE or ./data/dispatch.sqlite by default)
pnpm run seed:sqlite

# MySQL / Postgres — set DB_* env vars first, same as production
pnpm run seed:mysql
pnpm run seed:postgres
```

Then point `config/dispatch.yaml` at the same database (see [config/dispatch.example.yaml](../config/dispatch.example.yaml)) and set `USER_LOOKUP_BACKEND` accordingly.

## HTTP profile mock server

For manual or local testing of **`user_lookup.backend: http`** without a real profile service, run the mock server (it serves data from [scripts/seed/fixtures/users.json](../scripts/seed/fixtures/users.json)). The Express app lives in [src/http-profile-mock-app.ts](../src/http-profile-mock-app.ts); integration tests import the same module and listen on an ephemeral port.

```bash
# Terminal A — optional Bearer on the mock; if set, use the SAME string as PROFILE_API_TOKEN below
PROFILE_MOCK_TOKEN=my-local-secret pnpm run dev:http-profile-mock
```

Defaults: **port `4310`**, path **`/v1/users:batchGet`**, request body field **`user_ids`**, response shape **`{ users: [...] }`** with record id field **`id`**. Override with env: `PROFILE_MOCK_PORT`, `PROFILE_MOCK_PATH`, `PROFILE_MOCK_TOKEN`, `PROFILE_MOCK_REQUEST_FIELD`, `PROFILE_MOCK_RESPONSE_ROOT`, `PROFILE_MOCK_RESPONSE_ID_FIELD`.

**Terminal B — dispatch handler** (same repo, different shell). `PROFILE_API_TOKEN` is what the handler sends as `Authorization: Bearer …` (see `token_env` in the YAML). It must match `PROFILE_MOCK_TOKEN` when the mock requires auth.

You do **not** need real Atlas HMAC secrets for this flow: use **`pnpm run dev:local`**, which sets `LOCAL_DEV=1` so missing `SCALEMARGIN_*` vars get **insecure placeholders** (never use in production). You must **`export`** vars so they apply to the dev process:

```bash
export USER_LOOKUP_CONFIG_PATH=./config/dispatch.http-mock.example.yaml
export USER_LOOKUP_BACKEND=http
export PROFILE_API_TOKEN=my-local-secret
pnpm run dev:local
```

If you use plain `pnpm run dev`, set real secrets (or copy `.env.example` to `.env` and fill `SCALEMARGIN_*`).

Each profile row includes both top-level `email` and nested `contact.primaryEmail` (same value) so you can point `user_lookup.fields.email` at either path in YAML.

**Quick curl** against the mock only:

```bash
curl -sS -X POST "http://127.0.0.1:4310/v1/users:batchGet" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-local-secret" \
  -d '{"user_ids":["sm-001","sm-002","unknown-id"]}' | jq .
```

## Extending placeholders (TDD)

1. Add a failing assertion in [src/personalize.spec.ts](../src/personalize.spec.ts) (or an integration case) for the new `{{token}}`.
2. Extend `user_lookup.fields` and `placeholders` in YAML (or defaults in [src/user-lookup/config.ts](../src/user-lookup/config.ts) if you are changing built-in behavior).
3. Implement the minimal code change and keep the test green.

Use `setDispatchConfigForTests()` from `src/user-lookup/config.ts` in unit tests to inject parsed YAML without touching the filesystem.
