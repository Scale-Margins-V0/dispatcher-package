# Variables: system vs user, and the `field` source by lookup mode

Spec for the **Variables page**, the page that lists, creates and edits
personalization variables. The top section is a prompt you can hand straight to
an agent. Everything under it is the reference that prompt points at: the real
API, with responses captured from a running dispatcher.

---

## Prompt for the implementing agent

> You are updating the **Variables page** that manages personalization variables
> on a ScaleMargin Dispatcher, through its data-plane API
> (`/api/v1/data-plane/*`, `Authorization: Bearer <atlas key>`). Read
> `docs/variables-system-and-lookup-fields.md` in full before starting; every
> request and response you need is in it.
>
> Build the following:
>
> 1. **Two groups.** Show **System variables** and **Your variables** as
>    separate sections, split on the `system` boolean on each variable. List the
>    system group first. Use `?system=true` / `?system=false` if you page them
>    separately.
> 2. **System variables are read-only.**
>    - Show a lock or "System" badge and the `description` text.
>    - No edit, rename, enable/disable toggle or delete. Remove those controls;
>      don't just disable them.
>    - They're always enabled and have no timestamps (`created_at` /
>      `updated_at` are `null`). Show "Built-in" instead of a date.
> 3. **User variables** keep full create / edit / rename / toggle / delete.
>    - A user variable can't take a system name: create or rename-onto returns
>      `409`. Show the message inline on the name field.
>    - Validate names client-side against the reserved list: `email`, `phone`,
>      `unsubscribe_url`, `preferences_url`.
> 4. **The source picker follows the lookup mode.**
>    - On page load call `GET /api/v1/data-plane/lookup/fields`.
>    - If `field_source_supported` is `false` (network or mock mode), hide the
>      **Field** option. If you must show it, disable it with the tooltip
>      *"Your dispatcher doesn't read your database in network mode. Use an API
>      variable instead."*
>    - Offer only the sources listed in `GET /state` →
>      `lookup.supported_variable_sources`. Don't hard-code the list.
> 5. **Field picker (database mode only).** When the source is **Field**, the
>    column input is a **dropdown** filled from `lookup/fields` → `fields`. It's
>    not free text. Above it, show `lookup/fields` → `source.name` in a
>    **disabled** input labelled "Table" or "View" (from `source.kind`). It's
>    read-only, so don't offer a table picker.
>    - If that request returns `503`, show *"Couldn't read your database's
>      columns"* with a retry, and block saving a Field variable until it works.
> 6. **Inactive variables.** A user variable whose `source` isn't in
>    `supported_variable_sources` still exists, but it renders its fallback.
>    - Typical case: existing `field` or `query` variables after switching to
>      network mode.
>    - Show an **Inactive in <mode> mode, uses fallback** badge.
>    - Keep it editable, so it can be converted to another source, and
>      deletable.
> 7. **Error handling.** Every error has the shape
>    `{ error, message, details? }`.
>    - Branch on `error` (`forbidden`, `conflict`, `invalid_request`,
>      `not_found`, `unavailable`).
>    - Map each `details[].path` to its form field.
>
> Acceptance: work through the checklist at the end of the doc.

---

## 1. What changed and why

**The user lookup returns contact details only**, in every mode: `email` for
email sends, `phone` for WhatsApp sends. All personalization (names, company,
anything else) is a **variable**.

| Lookup mode | Where personalization comes from |
| --- | --- |
| `database` | `field` variables read any column of the configured view. The lookup selects only the columns that enabled variables use. Plus `query`, `api`, `computed` and `constant`. |
| `network` | `api`, `computed` and `constant` only. **`field` and `query` are unavailable**: the dispatcher has no database connection, and the client's API returns contact details only. |
| `mock` | Same as network. |

**Four variables are system variables.** They're defined by the dispatcher, are
always present, and can't be edited, renamed, disabled or deleted:

| Name | What it is |
| --- | --- |
| `email` | Recipient email address, from the user lookup. Resolved on email sends |
| `phone` | Recipient phone number, from the user lookup. Resolved on WhatsApp sends |
| `unsubscribe_url` | One-click unsubscribe link for this recipient and campaign |
| `preferences_url` | Link to this recipient's preference centre |

They live in code, not the database, so no API call can remove them.

---

## 2. API

Base: `https://<dispatcher>/api/v1/data-plane`. Every request needs
`Authorization: Bearer <DISPATCHER_ATLAS_KEY>`.

### 2.1 `GET /lookup/fields`: what a `field` variable can point at

Call this once when the page loads. It returns column names only, never values.

**Network or mock mode:**

```json
{
  "generated_at": "2026-09-24T09:51:40.350Z",
  "mode": "network",
  "field_source_supported": false,
  "source": null,
  "contact_fields": ["email", "phone"],
  "fields": []
}
```

**Database mode:**

```json
{
  "generated_at": "2026-09-24T09:51:40.350Z",
  "mode": "database",
  "field_source_supported": true,
  "source": { "kind": "view", "name": "v_dispatch_profile" },
  "contact_fields": ["email", "phone"],
  "fields": ["first_name", "last_name", "company_name", "city"]
}
```

| Key | Meaning |
| --- | --- |
| `mode` | `database` \| `network` \| `mock` |
| `field_source_supported` | Whether a `field` variable can be created at all |
| `source` | The table or view `fields` are read from: `user_lookup.source` on the dispatcher. `{ kind, name }` in database mode, `null` otherwise. **Show it read-only**; there's no table picker, and changing it is a dispatcher config change. Absent on older dispatchers |
| `contact_fields` | Always resolved by the lookup; exposed as the `email` / `phone` system variables |
| `fields` | Columns a `field` variable may pick: every column of the view **except** the id column and the email/phone columns. Always `[]` outside database mode |

| Status | When |
| --- | --- |
| `200` | Always in network/mock mode. In database mode, when the view could be read |
| `503` `{ "error": "unavailable", … }` | Database mode, but the customer database can't be reached. Retry |

### 2.2 `GET /state`: which sources to offer

Only the `lookup` block matters here:

```json
{
  "lookup": {
    "mode": "network",
    "backend": null,
    "supported_variable_sources": ["computed", "constant", "api"]
  }
}
```

In database mode `supported_variable_sources` is
`["field", "computed", "constant", "query", "api"]`.

### 2.3 `GET /variables`: the catalog

Query parameters, all optional:

| Param | Values |
| --- | --- |
| `system` | `true` = system only, `false` = user only. Omit for both |
| `source` | `field` \| `computed` \| `constant` \| `query` \| `api` |
| `enabled` | `true` \| `false` |
| `q` | Case-insensitive substring match on the name |
| `page` | 1-based, default 1 |
| `limit` | 1–100, default 25 |

System variables always come first. Response (trimmed to two of the four
system variables and one user variable):

```json
{
  "generated_at": "2026-09-24T09:51:40.347Z",
  "meta": {
    "page": 1, "limit": 25, "total": 5, "total_pages": 1,
    "from": 1, "to": 5, "has_previous_page": false, "has_next_page": false
  },
  "variables": [
    {
      "name": "email",
      "source": "field",
      "definition": { "source": "field", "field": "email" },
      "fallback": "",
      "sample": "sample.user@example.com",
      "enabled": true,
      "system": true,
      "description": "Recipient email address, from the user lookup. Resolved on email sends.",
      "created_at": null,
      "updated_at": null,
      "updated_by": "system"
    },
    {
      "name": "unsubscribe_url",
      "source": "computed",
      "definition": {
        "source": "computed",
        "expr": "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id"
      },
      "fallback": "#",
      "sample": "https://dispatcher.example.com/api/unsubscribe?uid=usr_1024&campaign_id=cmp_sample&organization_id=org_sample",
      "enabled": true,
      "system": true,
      "description": "One-click unsubscribe link for this recipient and campaign.",
      "created_at": null,
      "updated_at": null,
      "updated_by": "system"
    },
    {
      "name": "first_name",
      "source": "field",
      "definition": { "source": "field", "field": "first_name" },
      "fallback": "there",
      "sample": "Ada",
      "enabled": true,
      "system": false,
      "description": null,
      "created_at": "2026-09-24T09:51:40.342Z",
      "updated_at": "2026-09-24T09:51:40.342Z",
      "updated_by": "atlas:kkkkkkkk"
    }
  ]
}
```

| Field | System variable | User variable |
| --- | --- | --- |
| `system` | `true` | `false` |
| `description` | one line of text | `null` |
| `enabled` | always `true` | `true` / `false` |
| `created_at`, `updated_at` | `null` | ISO timestamps |
| `updated_by` | `"system"` | who last saved it |

`sample` is the value rendered against a fictional recipient. The system
variables' `source` is `field` or `computed`. Don't use it to decide editability
or mode support; use `system`.

### 2.4 `GET /variables/:name`

Returns `{ "variable": { …same shape… } }`. Works for system names too.
Unknown names return `404`.

### 2.5 `POST /variables`: create a user variable

```json
{
  "name": "first_name",
  "definition": { "source": "field", "field": "first_name" },
  "fallback": "there",
  "enabled": true
}
```

The `definition` shape depends on `source`:

| `source` | `definition` |
| --- | --- |
| `field` | `{ "source": "field", "field": "<column from lookup/fields>" }` (database mode only) |
| `computed` | `{ "source": "computed", "expr": "first_name + ' ' + last_name" }` |
| `constant` | `{ "source": "constant", "value": "Winter Sale" }` |
| `query` | `{ "source": "query", "sql": "SELECT … WHERE id = {{user_id}}" }` (database mode only) |
| `api` | `{ "source": "api", "api": { "method": "GET", "url": "https://api.acme.com/users/{{user_id}}", "headers": { "Authorization": "Bearer …" }, "json_path": "profile.first_name", "timeout_ms": 3000 } }` |

In network mode, personalization is almost always an **`api`** variable. It's
called once per recipient, with `{{user_id}}` interpolated at send time.

| Status | Body | When |
| --- | --- | --- |
| `201` | `{ "variable": {…} }` | Created |
| `400` | `{ "error": "invalid_request", "details": [{ "path": "definition.source", "message": "source=field reads a column of your customer database; this dispatcher is in network lookup mode" }] }` | Source not supported in this mode, or any validation failure (`details[].path` points at the field) |
| `409` | `{ "error": "conflict", "message": "\"phone\" is a system variable — choose another name" }` | Name is a system name |
| `409` | `{ "error": "conflict", "message": "Variable \"x\" already exists" }` | Name taken by a user variable |

### 2.6 `PATCH /variables/:name`: edit a user variable

Partial body: any of `name` (rename), `definition` (replaced whole), `fallback`,
`sample`, `enabled`.

| Status | Body | When |
| --- | --- | --- |
| `200` | `{ "variable": {…} }` | Updated |
| `403` | `{ "error": "forbidden", "message": "\"email\" is a system variable and cannot be changed" }` | Target is a system variable. This covers any edit, including `enabled` |
| `409` | `{ "error": "conflict", … }` | Renaming onto a system name or an existing name |
| `400` | `invalid_request` | Validation, or changing to an unsupported source |
| `404` | `not_found` | No such variable |

### 2.7 `DELETE /variables/:name`

| Status | Body | When |
| --- | --- | --- |
| `200` | `{ "deleted": true, "name": "first_name" }` | Deleted |
| `403` | `{ "error": "forbidden", "message": "\"email\" is a system variable and cannot be deleted" }` | System variable |
| `404` | `not_found` | No such variable |

### 2.8 Error envelope

Every error from `/api/v1`:

```json
{ "error": "<code>", "message": "<human readable>", "details": [{ "path": "…", "message": "…" }] }
```

`error` is one of: `invalid_request` (400), `unauthorized` (401), `forbidden`
(403), `not_found` (404), `conflict` (409), `rate_limited` (429),
`unavailable` (503), `internal` (500). `details` is only present on
`invalid_request`.

---

## 3. The dispatcher's own admin console

The admin console bundled with the dispatcher (`admin/src/pages/Variables.tsx`)
talks to a different API with the **same rules**:

| Data-plane | Admin console (session cookie) |
| --- | --- |
| `GET /api/v1/data-plane/lookup/fields` | `GET /admin/api/lookup/fields`, same body |
| `GET /api/v1/data-plane/variables` | `GET /admin/api/variables`, not paginated, flat fields (`field`, `expr`, `config`, `preview`), plus `system` and `description` |
| `PATCH` / `DELETE` on a system variable → `403` | `PUT` / `DELETE` → `403 { "error": "…is a system variable…" }` |
| Create with a system name → `409` | `POST` → `409` |

Apply the same UI rules if you're changing that page too.

---

## 4. Behaviour worth knowing

- **Inactive variables render their fallback.** In network mode an existing
  `field` or `query` variable stays in the list and in templates, and renders
  its `fallback` (empty if none). A raw `{{name}}` never goes out.
- **An unknown column never breaks a send.** If a `field` variable points at a
  column the view doesn't have, it's skipped with a warning in the dispatcher
  log and renders its fallback. Everyone still gets the message.
- **Database mode only reads what's used.** The lookup selects the recipient's
  contact column plus the columns that enabled `field` and `computed` variables
  reference. A column no variable uses is never read.
- **`{{email}}` on WhatsApp and `{{phone}}` on email are empty.** Each send only
  looks up its own channel's contact field.

---

## 5. API variables: query params, JSON body, nested response paths

An `api` variable calls the client's service once per recipient. Templates can
reach into its JSON response with a dotted path after the variable name.

```json
{
  "name": "user_info",
  "fallback": "friend",
  "definition": {
    "source": "api",
    "api": {
      "method": "GET",
      "url": "https://crm.example.com/users",
      "query": [{ "key": "user_id", "value": "{{user_id}}" }],
      "headers": { "Authorization": "Bearer …" },
      "json_path": "info.firstname",
      "response_sample": "{\"info\":{\"firstname\":\"Ada\",\"address\":{\"pincode\":\"560001\"}}}"
    }
  }
}
```

| Template token | Renders |
| --- | --- |
| `{{user_info}}` | The value at `json_path` (`Ada`). Offered only when `json_path` is set |
| `{{user_info.info.firstname}}` | `Ada` |
| `{{user_info.info.address.pincode}}` | `560001` |
| `{{user_info.orders.0.id}}` | First order's id (arrays are indexed by number) |
| `{{user_info.info.address}}` | The `fallback`. It's an object, and objects are never placeholders |
| A path the response doesn't have | The variable's `fallback` |

**Single values only.** A placeholder must end at a string, number or boolean.
Objects and arrays are walked through (`info.address.pincode`, `orders.0.id`)
but never offered. The `placeholders` list and the parsed sample contain only
single-value paths, a `json_path` that points at an object is refused, and at
send time any path that holds an object or array renders the fallback, never
JSON.

- **Query params:** `query` rows are appended to the URL. Values take `{{tokens}}` and are URL-encoded. Values under credential-like names (`api_key`, `token`, …) are masked in responses, like headers.
- **Body:** POST only. It's JSON unless a `Content-Type` header says otherwise. It must be valid JSON with `{{tokens}}` inside quotes, and recipient values are JSON-escaped when inserted.
- **Response shape:** send `response_schema` (a list of `{path, type}`), or a write-only `response_sample` that the dispatcher reduces to paths and discards. The variable's `placeholders` then lists every `{{name.path}}` for autocomplete.
- **The schema is not a gate.** A path used in a template resolves even if it isn't listed; listing it only makes it discoverable.
- **One request per recipient** fills every path, however many a template uses.
- **Works on every channel:** email, Freshchat and Gupshup WhatsApp.

## 6. Acceptance checklist

- [ ] System and user variables appear in separate, clearly labelled groups.
- [ ] System variables show a lock/badge and their `description`, and have no
      edit, rename, toggle or delete controls.
- [ ] "Built-in" is shown where timestamps are `null`.
- [ ] Creating or renaming to `email` / `phone` / `unsubscribe_url` /
      `preferences_url` is blocked client-side, and a `409` shows inline if the
      server says so.
- [ ] Network/mock mode: the **Field** source is hidden (or disabled with the
      tooltip). Offered sources match `supported_variable_sources`.
- [ ] Database mode: the Field column is a dropdown from `lookup/fields`.
      A `503` shows an error with retry and blocks saving a Field variable.
- [ ] Existing variables whose source isn't supported show
      "Inactive in <mode> mode, uses fallback".
- [ ] `403` / `409` / `400` responses show `message` or map `details[].path`
      to the right input.
