# User lookup and personalization contract

This document describes the stable integration surface between ScaleMargin dispatch payloads, your user data, and rendered email content.

> **The configuration shape below is deprecated.** Lookup config now lives under
> `user_lookup:` in `.env.yaml` — see [`.env.yaml.example`](../.env.yaml.example)
> and §6 of the [README](../README.md). `config/dispatch.yaml` is still read when
> `.env.yaml` has no `user_lookup` block, and warns at boot; support for it will
> be removed in a future release.
>
> The `UserRecord` contract itself is unchanged — every mode produces the same
> shape. For the HTTP mode specifically, the current fixed contract is
> [`user-lookup-network-contract.md`](user-lookup-network-contract.md); the
> flexible `http` backend described under "SQL vs HTTP field mapping" below is
> the legacy one and retires with `dispatch.yaml`.

## Lookup: inputs and outputs

- **Input:** `user_ids: string[]` — opaque identifiers exactly as ScaleMargin sends them on the wire (always strings).
- **Output:** `Promise<Map<string, UserRecord>>` — one entry per resolved user. Missing IDs are omitted; the dispatcher logs a warning and skips those recipients.

## `UserRecord` shape

```ts
interface UserRecord {
  user_id: string; // same id string from the dispatch batch (used in unsubscribe links, etc.)
  email: string; // recipient — required for sending
  fields: Record<string, string | undefined>; // all other columns / API fields
}
```

- **`email` (top level):** Used by `src/index.ts` as `message.to` unless `DEV_RECIPIENT_EMAIL` is set.
- **`fields`:** Open map. Keys are defined by `user_lookup.fields` in `.env.yaml` (or `config/dispatch.yaml`, deprecated). The `email` key should normally be populated as well so `{{email}}` personalization works.
- **Adding fields:** Add a line under `user_lookup.fields`, then define the matching variable from the ScaleMargin platform. No TypeScript changes are required.

## SQL vs HTTP field mapping

- **MySQL / Postgres / SQLite:** Each value under `user_lookup.fields` is a **column name** on `user_lookup.source.name` (table or view).
- **HTTP:** Each value is a **JSON path** (dot segments) relative to each record in the response array.

The `http.response` block only describes **where the array lives** (`root`) and **which property is the id** (`id_field`). It does not replace `user_lookup.fields`.

## Joins and conditional logic

The YAML intentionally does **not** support multi-table joins or arbitrary expressions in lookups.

- Put joins, prioritization (“prefer work email”), and derived columns in a **database view** (or in your HTTP service), then point `source.name` at that view (or call that API).

## `id_type` (SQL)

- `string` — pass through after trim.
- `int` / `bigint` — numeric string only.
- `uuid` — RFC-style UUID string; normalized to lowercase for comparison.

Invalid IDs for the configured type are skipped with a warning; the rest of the batch continues.

## Placeholders (`placeholders` in YAML)

- Each key becomes a `{{key}}` token in subject / HTML / text bodies.
- **`source: field`** — reads `user.fields[field]` (after trimming); uses `fallback` when empty or missing.
- **`source: computed`** — safe mini-language only: `+` string concat, `'...'` literals, `user_id`, `email`, identifiers for `user.fields.*`, and `env.VAR_NAME` for environment variables. No `eval`, functions, or property chains inside identifiers.

## Configuration files

Resolved in order, first hit wins — per file, never merged per key:

1. `.env.yaml` → `user_lookup:` — the current location. See [`.env.yaml.example`](../.env.yaml.example).
2. `./config/dispatch.yaml` (override with `USER_LOOKUP_CONFIG_PATH`) — **deprecated**, warns at boot.
3. Neither present → **mock** user lookup with built-in placeholders (demo-friendly).

If a file is **present but invalid**, the process exits with a Zod validation error.

`placeholders:` in `dispatch.yaml` is seeded into the `variables` table on first
boot and edited from the ScaleMargin platform thereafter. It has no equivalent in
`.env.yaml` and does not need one.
