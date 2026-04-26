# User lookup and personalization contract

This document describes the stable integration surface between ScaleMargin dispatch payloads, your user data, and rendered email content.

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
- **`fields`:** Open map. Keys are defined by `user_lookup.fields` in `config/dispatch.yaml`. The `email` key should normally be populated as well so `{{email}}` personalization works.
- **Adding fields:** Add a line under `user_lookup.fields` and a matching entry under `placeholders`. No TypeScript changes are required.

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

- Default path: `./config/dispatch.yaml` (override with `USER_LOOKUP_CONFIG_PATH`).
- If the file is **missing**, the server starts with **mock** user lookup and built-in placeholders (demo-friendly).
- If the file is **present but invalid**, the process exits with a Zod validation error.

See [config/dispatch.example.yaml](../config/dispatch.example.yaml) for a full example.
