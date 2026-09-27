# Plan — move user lookup into `.env.yaml`, add network mode

**Status:** proposed, not started
**Audience:** us

Retire `config/dispatch.yaml`. Lookup configuration moves into `.env.yaml`
alongside the sender configuration, and the operator picks how recipient data is
found: **`database`** (read it themselves) or **`network`** (ask the client's
API).

Placeholder definitions leave the file entirely — Postgres is already the source
of truth for them.

---

## 1. The short version

<!-- prettier-ignore -->
| | Today | After |
| --- | --- | --- |
| Lookup config | `config/dispatch.yaml` | `.env.yaml` → `user_lookup:` |
| Placeholders | `config/dispatch.yaml` → `placeholders:` | Postgres `variables` table only |
| Backends | `mock`, `sqlite`, `mysql`, `postgres`, `http` | `mode: database` (with `backend:`), `mode: network`, or `mode: mock` |
| Network shape | Fully configurable paths and field names | One published contract |
| `source: query` variables | Allowed everywhere, only work on SQL backends | **Rejected at write time in network mode** |
| Lookup credentials | `.env` (`DB_*`), or an env var named by `token_env` | **Inline in `.env.yaml`** |
| Config files a client writes | `.env`, `config/dispatch.yaml`, `.env.yaml` | `.env`, `.env.yaml` |

**Two files become one.** That is the point: a client currently maintains a YAML
for lookup, a YAML for senders, and a `.env` for secrets.

---

## 2. What already works in our favour

Three things make this far smaller than it looks. Each was verified in the code,
not assumed.

**Postgres is already authoritative for placeholders.**

```ts
// src/user-lookup/config.ts:342
export function getPlaceholderRegistry(): Record<string, PlaceholderEntry> {
  return getPlaceholderSnapshot() ?? getDispatchConfig().placeholders;
}
```

The YAML block is only a fallback for processes that never initialise the DB.
Every real deployment has been reading placeholders from Postgres since the
stateful-dispatcher work landed. Removing `placeholders:` removes a fallback,
not a feature.

**The one-time seed already exists.** `importYamlPlaceholdersOnce()`
(`src/variables/import-yaml.ts`) copies YAML placeholders into the `variables`
table on first boot, guarded by `dispatcher_meta.yamlImportDoneAt`. Existing
deployments have already run it. Only the seed's *source* changes.

**Network mode is 80% built.** `HttpAdapter` (`src/user-lookup/adapters/http.ts`,
171 lines) already does batched POSTs, bearer auth from an env var, chunking,
retry-on-5xx, id coercion and field mapping. We are narrowing its configuration
surface and publishing the contract, not writing it.

---

## 3. Blast radius

`impact({target: "getDispatchConfig", direction: "upstream"})`:

```
risk: CRITICAL   impacted: 25 symbols   processes: 9   modules: 7
direct callers: 5
```

Affected flows: `processDispatch`, `processWhatsAppDispatch`, `readyHandler`,
`buildDiagnosticsReport`, `getState`, `reloadLookupAdapter`,
`importYamlPlaceholdersOnce`, `registerAdminRoutes`, `initDispatcherDb`.

**Mitigation: `getDispatchConfig()` keeps its name and its return type.** All 25
call sites keep compiling and behaving. Only its *input* changes — where the
config is read from. That converts a CRITICAL refactor into a change contained
inside `src/user-lookup/config.ts`.

---

## 4. The new `.env.yaml`

### 4.1 Database mode

`source` and `fields` are unchanged from `dispatch.yaml`. `fields:` stays
**general purpose** — any logical name → any column, exactly as today, because
Postgres variables with `source: field` reference those logical names.

```yaml
version: 1

user_lookup:
  mode: database
  backend: postgres # postgres | mysql | sqlite | mock

  # Connection to YOUR customer database. Read-only credentials.
  # These used to be DB_* in .env; they now live here so the whole
  # lookup configuration is one block.
  connection:
    host: db.internal
    port: 5432
    user: dispatcher_ro
    password: "paste-the-password-here"
    database: customers
    ssl: true
    # sqlite backend instead:
    # file: ./data/dispatch.sqlite

  source:
    kind: table # table | view
    name: customers
    id_column: external_id
    id_type: string # string | int | bigint | uuid

  # Logical name → your column. Only these columns are ever read.
  # `email` is required for email; `phone` for WhatsApp/SMS.
  fields:
    email: email_address
    phone: mobile_number
    first_name: given_name
    last_name: family_name
    company_name: account_name

  batch:
    max_ids_per_query: 1000
    dedupe: true

# NOTE: no `placeholders:` block. Variables live in the dispatcher's own
# database and are edited through the ScaleMargin platform.

senders:
  - id: primary-ses
    # … unchanged
```

**This makes `.env.yaml` a secret file.** See §4.4 — it changes how the file is
stored, mounted and described to clients.

### 4.2 Network mode

```yaml
user_lookup:
  mode: network

  network:
    url: https://api.your-company.com/scalemargin/lookup
    token: "paste-the-bearer-token-here" # sent as: Authorization: Bearer <token>
    timeout_ms: 3000
    retries: 2

  # Same map, same meaning. Here it is the list of fields we ask you for.
  fields:
    email: email
    phone: phone
    first_name: first_name

  batch:
    max_ids_per_query: 500
    dedupe: true
```

**The `fields:` map is the request contract.** The dispatcher asks for exactly
these logical names — a fixed list the client can code against, which only
changes when someone edits `.env.yaml`. Deriving it from the Postgres variables
instead would mean the request shape shifts whenever an operator adds a variable
in the platform, which the client's endpoint has no way to anticipate.

---

### 4.3 Mock mode

```yaml
user_lookup:
  mode: mock
```

That is the whole block. Mock reads no database and calls no API, so `mock` was
never a *database* backend — grouping it under one was a lie the old schema told.
It fabricates recipients for local development and tests.

`source`, `connection`, `network` and `fields` are all rejected here: a mock that
appears configured is worse than one that obviously is not.

> **Mock still mails nobody real.** The existing loud warning stays. This change
> only makes asking for it deliberate; §7 keeps the silent fallback for a
> dispatcher with no config at all, so nothing regresses.

### 4.4 `.env.yaml` now holds secrets

Putting the database password and the bearer token inline is a deliberate
trade: one self-contained lookup block, at the cost of a second secret file.
Three things follow, and none are optional.

**It diverges from the sender convention.** Senders document `api_key_env:`
precisely so `.env.yaml` stays shareable. After this change that file holds live
credentials, so the reasoning no longer holds and the documentation that says so
has to change (§6 of `client-deployment.md` / the README, and the Notion page).
The `*_env` forms stay accepted for senders — and should be accepted for
`user_lookup` too, since the schema already supports both shapes for senders.
Literal is what we document; `_env` is there for anyone whose policy forbids
credentials in a config file.

**It has to be protected like `.env`.**

<!-- prettier-ignore -->
| Where | Requirement | Status |
| --- | --- | --- |
| Local disk | `chmod 600 .env.yaml` | The loader already warns on group/world-readable (`src/env-yaml.ts:337`) |
| Git | Never committed | Covered — `.gitignore` `.env.*` |
| Image | Never baked in | Covered — `.dockerignore` `.env.*` |
| Kubernetes | A `Secret`, never a ConfigMap, `defaultMode: 0400` | Already documented in the acme runbook |
| Compose | Mounted read-only | Already `:ro` |

The existing permission warning was written when the file held only sender
credentials; it now guards the customer database password too. Worth promoting
that log line from `warn` to something an operator cannot miss.

**Support bundles must never include it.** `buildDiagnosticsReport` reports
`user_lookup_backend`; it must never grow a "dump the resolved config" branch.
Add a test asserting the diagnostics payload contains neither the password nor
the token.

---

## 5. The network contract (shareable with clients)

This is the document a client implements against. It is deliberately fixed — no
configurable paths or field names, unlike the current `http` backend.

### Request

```http
POST <your url>
Authorization: Bearer <your token>
Content-Type: application/json
```

```json
{
  "user_ids": ["usr_1", "usr_2", "usr_3"],
  "fields": ["email", "phone", "first_name"]
}
```

<!-- prettier-ignore -->
| Field | Meaning |
| --- | --- |
| `user_ids` | Opaque IDs, exactly as ScaleMargin sent them — always JSON strings. Deduplicated, chunked to `max_ids_per_query` |
| `fields` | The logical names we need back. Taken from `fields:` in `.env.yaml` |

### Response — 200

```json
{
  "users": [
    {
      "user_id": "usr_1",
      "email": "ada@example.com",
      "phone": "+919876543210",
      "first_name": "Ada"
    },
    { "user_id": "usr_2", "email": "grace@example.com", "first_name": "Grace" }
  ]
}
```

Rules:

- **`user_id` is required** on every record and must match the ID we sent. It is
  compared as a string, so a JSON number `42` matches the id `"42"` — but there
  is no type coercion beyond that, and any other mismatch leaves that recipient
  unresolved.
- **Omit users you cannot resolve.** Do not return `null` entries. A missing ID
  is recorded as `user_not_found` and that recipient is skipped — the rest of
  the campaign still sends.
- **Omit fields you do not have** for a given user. The dispatcher applies the
  variable's fallback.
- Order does not matter.
- Return only the fields we asked for. Extra keys are ignored.

### Errors

<!-- prettier-ignore -->
| Status | Dispatcher behaviour |
| --- | --- |
| `2xx` | Parsed as above |
| `4xx` | **No retry.** The chunk fails, its recipients are unresolved, and a warning names the status |
| `5xx`, timeout, network error | Retried with backoff up to `retries`, then the chunk fails |

A failed chunk never fails the whole dispatch. Recipients in that chunk are
reported as unresolved, everyone else still receives their message.

### What we will never send you

No message content, no campaign copy, no ScaleMargin credentials. Only opaque
user IDs and the list of field names.

---

## 6. `source: query` variables in network mode

A `query` variable runs SQL against the client's database
(`SqlAdapter.runScalarQuery`, the only implementation). In network mode there is
no connection, so it cannot work.

**Rejected at write time, not degraded at read time.** Three enforcement points:

### 6.1 The dispatcher refuses to store them

<!-- prettier-ignore -->
| Surface | File | Change |
| --- | --- | --- |
| Platform API — create | `src/api/v1/controllers/dataplane.controller.ts:461` | `422` when `source === "query"` and mode is network |
| Platform API — update | `…controller.ts:521` | Same, including a change *into* `query` |
| Console API — create | `src/admin/api/variables.ts:213` | Same |
| Console API — update | `src/admin/api/variables.ts:236` | Same |

Suggested body:

```json
{
  "error": "unsupported_variable_source",
  "message": "source=query needs a database connection; this dispatcher is in network lookup mode",
  "field": "source"
}
```

### 6.2 The platform knows the mode, so it can grey the option out

`GET /api/v1/data-plane/state` gains a `lookup` block
(`dataplane.controller.ts:157`):

```json
{
  "lookup": {
    "mode": "network",
    "backend": null,
    "supported_variable_sources": ["field", "computed", "constant", "api"]
  }
}
```

In database mode: `"mode": "database"`, `"backend": "postgres"`, and `query`
present in the list. Atlas reads `supported_variable_sources` rather than
hard-coding the rule, so a future source type needs no frontend change.

`buildDiagnosticsReport` already reports `user_lookup_backend`
(`src/ops/diagnostics.ts:387`) — extend it with `mode` for consistency.

### 6.3 Existing `query` variables are hidden, not deleted

Switching an existing deployment to network mode must not destroy configuration.

- `GET /variables` omits `query` rows when in network mode, so the platform
  never lists something unusable.
- The rows stay in the table. Switching back to database mode restores them.
- `refreshPlaceholders()` skips them when building the snapshot, so
  `personalize()` uses each one's fallback.
- Boot logs a single warning naming the count, not one per variable:
  `3 variables use source=query and are inactive in network lookup mode`.

**Why not refuse to boot:** variables are edited through the platform, so a
remote edit could otherwise make the dispatcher fail its next restart. A
dispatcher that sends with fallbacks beats one that will not start.

---

## 7. Migration

`.env.yaml` wins; `config/dispatch.yaml` keeps working for one release with a
warning. No client has to act before upgrading.

```
.env.yaml has user_lookup:  →  use it
otherwise dispatch.yaml:    →  use it, WARN "deprecated, move to .env.yaml"
neither:                    →  mock lookup + the existing loud warning
```

The precedence is per-file, not per-key — no merging. A half-migrated config is
worse than either whole one.

### Connection credentials during the window

`DB_*` in `.env` keeps working, so nobody is forced to move credentials and
config in the same step:

```
.env.yaml user_lookup.connection present?  →  use it
otherwise DB_HOST / DB_USER / …            →  use them, WARN once
neither, and backend needs a connection    →  fail loudly at boot
```

The warning names the variables it fell back to, so it is obvious what to move.
`DB_ALLOW_EMPTY_PASSWORD` applies to the env path only — an inline
`password: ""` is explicit and needs no escape hatch.

Same shape for the network token: `token:` inline wins; a `token_env:` is still
honoured for anyone whose policy forbids credentials in a config file.

### Placeholder seeding during the window

`importYamlPlaceholdersOnce()` currently seeds from
`getDispatchConfig().placeholders`. New order:

1. `dispatch.yaml` exists **and** has `placeholders:` → seed from it (unchanged
   behaviour for anyone mid-migration)
2. otherwise → seed from `DEFAULT_PLACEHOLDERS` (`config.ts:154`)

The `dispatcher_meta` guard means this runs once ever. Existing deployments have
already passed it and are unaffected.

### Deprecation timeline

<!-- prettier-ignore -->
| Release | Behaviour |
| --- | --- |
| N | `.env.yaml` supported. `dispatch.yaml` works, warns on every boot |
| N+1 | Warning becomes an error-level log; still works |
| N+2 | `dispatch.yaml` ignored. Reading it is removed |

---

## 8. Implementation phases

**Status as of 2026-09-07: Phases 1–7 shipped.** 594/594 tests green,
`tsc --noEmit` clean. Phase 8 is deliberately deferred to a later release —
doing it now would end the deprecation window early and break any deployment
still on `config/dispatch.yaml`.

Each phase leaves the tree green. Do not start the next until `pnpm test` and
`tsc --noEmit` pass.

### ✅ Phase 1 — schema, no behaviour change

- Add `user_lookup` to the `.env.yaml` Zod schema in `src/env-yaml.ts`, as a
  three-arm discriminated union on `mode`: `database` | `network` | `mock`.
- Reject cross-mode keys: `network:` under `database`, `source:`/`connection:`
  under `network`, and anything at all under `mock`. A config that means two
  things is a config nobody can debug.
- `id_type` is accepted only under `database`. Under `network` it is rejected
  with a message saying IDs are compared exactly.
- Validate the credential blocks per backend: `connection.host/user/database`
  required for `mysql`/`postgres`, `connection.file` for `sqlite`, neither for
  `mock`; `network.url` and `network.token` for network mode.
- Accept `password_env:` / `token_env:` alongside the literal forms, exactly as
  senders already do (`env-yaml.ts:385` checks the named variable exists).
- Nothing reads it yet.
- **Tests:** schema accepts all three modes; rejects every cross-mode key; rejects `id_type` under `network`.

### ✅ Phase 2 — make `config.ts` read from `.env.yaml`

The heart of it, and the reason the blast radius stays contained.

- `loadDispatchConfigFromDisk()` becomes `loadDispatchConfig()`: read
  `.env.yaml`'s `user_lookup` first, translate it into the existing
  `DispatchConfig` shape, and fall back to `dispatch.yaml`.
- **`DispatchConfig` keeps its shape.** `placeholders` stays on the type,
  populated from `DEFAULT_PLACEHOLDERS` when the source is `.env.yaml`. Every
  one of the 25 impacted call sites is untouched.
- `mode: network` maps to `backend: "http"` internally at first and `mode: mock`
  to `backend: "mock"`, so `index.ts` needs no change yet. The public vocabulary
  changes; the internal enum does not, which is what keeps the blast radius shut.
- Carry the resolved connection on `DispatchConfig` as an optional block. Absent
  → the adapters fall back to `DB_*`, so Phase 2 alone changes no behaviour.
- Keep the old function name as a deprecated alias to avoid a rename across
  tests.
- **Tests:** both sources produce an identical `DispatchConfig`; precedence
  works; the deprecation warning fires exactly once.

### ✅ Phase 3 — `SqlAdapter` reads the connection from config

`sql.ts:42-67` builds its pool straight from `process.env`. It has to take the
resolved connection instead, falling back to `DB_*` when absent.

- Thread the connection block through; keep the env fallback inline so the two
  paths are visibly the same code.
- `ensureDispatchConfigLoaded()` (`config.ts:283`) currently does
  `requireEnv("DB_HOST")` — it must check the resolved connection first and only
  demand env vars when nothing was configured in `.env.yaml`.
- **Tests:** a config-supplied connection is used verbatim; with none, `DB_*` is
  used and warns once; missing both fails with a message naming both options.

### ✅ Phase 4 — the network adapter

- Add `NetworkAdapter`, or narrow `HttpAdapter` behind a fixed contract.
  Reuse the chunking, retry and coercion — they are correct and tested.
- Fixed request/response per §5. No `request.id_field`, no `response.root`.
- **No id coercion.** Compare the returned `user_id` to what we sent, exactly.
  `coerceIdForType` is a SQL concern and stays on the SQL path.
- `backend: http` from `dispatch.yaml` keeps the old flexible adapter during the
  deprecation window. Two adapters briefly; the old one dies with `dispatch.yaml`.
- **Tests:** contract shape, partial responses, missing users, 4xx no-retry,
  5xx retry, timeout, malformed JSON, and a numeric `user_id` in the response
  not matching the string we sent.

### ✅ Phase 5 — the query-variable guard

- A single `lookupMode()` helper. Do not re-derive the mode at four call sites.
- Guard all four write surfaces (§6.1).
- Filter `query` rows from `listVariables` responses and from
  `refreshPlaceholders()` when in network mode.
- One aggregated boot warning.
- **Tests:** create and update rejected with `422` in network mode and accepted
  in database mode; existing rows survive a mode switch; snapshot excludes them;
  fallback is used.

### ✅ Phase 6 — surface the mode

- `lookup` block on `/state` (§6.2).
- `mode` in the diagnostics report.
- `ATLAS_API.md` and the OpenAPI spec.
- **Tests:** both modes reported correctly; `supported_variable_sources` matches
  what the write guard enforces. Assert those two against each other so they
  cannot drift.

### ✅ Phase 7 — documentation

- `.env.yaml.example`: both modes, commented.
- **Correct the "safe to share" claim** about `.env.yaml` wherever it appears —
  README §7.1, `client-deployment.md`, and the Notion page (§4.3).
- `README.md` / `client-deployment.md`: replace §6 (`config/dispatch.yaml`) with
  the new block; §3 file list; the compose mount.
- **New:** the network contract from §5 as a standalone page to hand to clients.
- `docs/user-lookup-contract.md`: mark the `dispatch.yaml` shape deprecated.
- Notion: the deployment page and the Docs index.

### ⏸ Phase 8 — removal (a later release, NOT yet done)

Delete `dispatch.yaml` reading, the old `HttpAdapter`, `USER_LOOKUP_CONFIG_PATH`,
`config/dispatch*.example.yaml`, the `DB_*` fallback, and the YAML seed branch.

---

## 9. Files touched

<!-- prettier-ignore -->
| Area | Files |
| --- | --- |
| Schema | `src/env-yaml.ts` |
| Config | `src/user-lookup/config.ts` ← the centre of the change |
| Adapters | **new** `src/user-lookup/adapters/network.ts`; `adapters/sql.ts` (connection from config); `adapters/http.ts`; `index.ts` |
| Guard | `src/api/v1/controllers/dataplane.controller.ts`, `src/admin/api/variables.ts`, `src/variables/service.ts` |
| Surface | `dataplane.controller.ts` (`getState`), `src/ops/diagnostics.ts` |
| Seeding | `src/variables/import-yaml.ts` |
| Docs | `.env`/`.env.example` (`DB_*` marked deprecated), `.env.yaml.example`, `README.md`, `docs/deployment/client-deployment.md`, **new** network-contract page, `docs/user-lookup-contract.md`, `ATLAS_API.md`, `docs/swagger/atlas-api.yaml` |
| Tests | `src/user-lookup/config.spec.ts`, `index.spec.ts`, `adapters/http.*.spec.ts`, **new** `adapters/network.spec.ts`, `src/env-yaml.spec.ts`, `src/admin/api/variables.integration.spec.ts`, `src/api/v1/routes/dataplane-*.spec.ts` |

Also referencing `dispatch.yaml` and needing a sweep in Phase 7:
`scripts/dev-scalemargin.sh`, the three `*-dual-secret-test-server.ts` harnesses,
`docs/testing.md`, `docs/architecture.md`, `docs/ses.readme.md`,
`docs/sendgrid.readme.md`.

---

## 10. Verification

Beyond `pnpm test` and `npx tsc --noEmit` at every phase:

**Nothing regressed for existing deployments**

```bash
# a dispatch.yaml-only deployment behaves exactly as before, plus one warning
pnpm test src/user-lookup src/variables
docker compose up -d && docker compose logs dispatcher | grep -i "deprecat"
```

**Both config sources agree** — the strongest single check. Translate the same
configuration through each path and assert the resulting `DispatchConfig` is
deep-equal. If that holds, the 25 impacted call sites cannot tell the difference.

**End to end, per mode**

```bash
# database mode: unchanged behaviour
curl -s localhost:3100/api/v1/data-plane/state -H "Authorization: Bearer $KEY" | jq '.lookup'
# → { "mode": "database", "backend": "postgres", "supported_variable_sources": [... "query"] }

# network mode against a stub: recipients resolve, missing ids are skipped
# and a query variable is refused
curl -s -X POST localhost:3100/api/v1/data-plane/variables \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"tier","source":"query","sql":"SELECT 1"}'
# → 422 unsupported_variable_source
```

**The guard and the advertised list cannot drift** — assert
`supported_variable_sources` against the same constant the write guard uses.

---

## 11. Risks

<!-- prettier-ignore -->
| Risk | Mitigation |
| --- | --- |
| `getDispatchConfig` is CRITICAL blast radius | Keep the name and return type. Only the input changes (§3) |
| A client upgrades without migrating | Deprecation window; `dispatch.yaml` keeps working (§7) |
| Switching to network mode silently breaks `query` variables | Rows retained, one aggregated boot warning, fallbacks used, platform greys the option out (§6) |
| Client's endpoint is slow or flaky | Existing chunk/retry/timeout behaviour is reused unchanged; a failed chunk never fails the dispatch |
| `.env.yaml` becomes required | It does not. Absent → `dispatch.yaml` → mock, exactly as today |
| Two config files disagree | Whole-file precedence, never a merge (§7) |
| `.env.yaml` now holds the DB password and bearer token | Same protections as `.env`: `chmod 600`, k8s Secret at `0400`, already git/docker-ignored. Diagnostics must never echo it (§4.4) |
| Credentials in a file that was previously shareable | Every doc calling `.env.yaml` safe to share is corrected in Phase 7 |
| A client moves config but not credentials | `DB_*` stays a warned fallback for the whole window (§7) |

---

## 12. Decisions taken

<!-- prettier-ignore -->
| Question | Decision |
| --- | --- |
| Does `fields:` narrow to contact-only? | **No — stays general.** Postgres `field` variables reference these logical names; narrowing would break `{{company_name}}` |
| Hard cutover or deprecation? | **Deprecation window.** No client has to act before upgrading |
| `query` variables in network mode? | **Rejected at write time**, hidden from the API, retained in the table, fallback at read time |
| Where does the network field list come from? | **The `fields:` map.** A fixed list the client can code against; a list derived from Postgres variables would shift under them whenever an operator edits one |
| Bearer token: literal or `token_env`? | **Literal, pasted into `.env.yaml`.** `token_env` still accepted, undocumented by default |
| Where do the customer-DB credentials live? | **Inline in `.env.yaml`** under `user_lookup.connection`. `DB_*` remains a warned fallback for the deprecation window |
| Does network mode need `id_type`? | **No.** IDs are strings we sent and get back; comparison is exact. Removes a silent-skip path where a coercion failure dropped a recipient with only a warning |
| Is `mock` a backend or a mode? | **A mode.** It reads no database, so `mode: mock` says what it is |

### Follow-on this unlocks

Making mock explicit means "no configuration at all" no longer has to mean
"quietly fabricate recipients" — the failure `build-and-publish.md` §7 calls the
most damaging misconfiguration in the deployment, because nothing errors and the
campaign looks healthy.

Once `mode: mock` exists, a dispatcher with no `user_lookup` block could refuse
to boot instead. **Not proposed here** — it is a behaviour change for anyone
relying on the fallback, and this plan is meant to break nothing. Worth deciding
separately.
