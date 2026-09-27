# User lookup over the network — the contract

**Who this is for.** You are running the ScaleMargin Dispatcher in **network
mode**, so instead of giving it read access to your database, you expose one
endpoint that resolves opaque user IDs into contact details.

You implement one endpoint. It takes a list of IDs and the channel being sent
on, and returns **contact details only**: the email address for an email send,
the phone number for a WhatsApp send. Nothing else is ever asked for —
personalization (names, company, …) is configured as variables, not looked up
here.

---

## 1. The shape of it

```
ScaleMargin  ──►  Your dispatcher  ──►  Your lookup API  ──►  your data
                       │
                       └──► sends the messages
```

The dispatcher never sees your customer records except through this call, and
never stores what comes back beyond the life of one send.

---

## 2. The request

```http
POST <your url>
Authorization: Bearer <your token>
Content-Type: application/json
```

```json
{
  "user_ids": ["usr_1", "usr_2", "usr_3"],
  "channel": "email",
  "fields": ["email"]
}
```

| Field | Meaning |
| --- | --- |
| `user_ids` | Opaque IDs, exactly as ScaleMargin sent them. Always JSON strings. Deduplicated, and split into batches of `max_ids_per_query` |
| `channel` | `email` or `whatsapp`: what these recipients are about to be sent |
| `fields` | **Your** name for the one contact field this channel needs, from the right-hand side of the `fields:` map. Return the value under exactly that key |

`fields:` in network mode uses `email` and `phone` only. Any other key is
ignored, and the dispatcher logs a warning at boot naming it. With this mapping:

```yaml
fields:
  email: email_address
  phone: mobile_number
```

| `channel` | `fields` we send |
| --- | --- |
| `email` | `["email_address"]` |
| `whatsapp` | `["mobile_number"]` |

The URL and token come from `user_lookup.network` in `.env.yaml`. The field
lists are fixed by your configuration, so you can code against them and they
won't change underneath you.

---

## 3. The response

```json
{
  "users": [
    { "user_id": "usr_1", "email": "ada@example.com" },
    { "user_id": "usr_2", "email": "grace@example.com" }
  ]
}
```

### Rules

- **`user_id` is required** on every record and must match an ID we sent. It is
  compared as a string; a JSON number `42` matches the ID `"42"`, but anything
  else leaves that recipient unresolved.
- **Omit users you cannot resolve.** Do not return `null` placeholders. A
  missing ID is recorded as `user_not_found`, that recipient is skipped, and the
  rest of the campaign still sends.
- **The channel's contact field is required.** On an `email` request, a record
  without a non-empty email is dropped. On a `whatsapp` request, a record
  without a phone is dropped. A database lookup applies the same rule.
- Order does not matter, and extra keys are ignored.
- A record for an ID we did not ask about is ignored.

---

## 4. Errors and retries

| Your response | What the dispatcher does |
| --- | --- |
| `2xx` | Parses it as above |
| `4xx` | **No retry.** Your credential or the request is wrong, and repeating it cannot help. That batch is unresolved |
| `5xx` | Retries with backoff, up to `retries` (default 2) |
| Timeout or connection error | Same as `5xx` |
| Malformed JSON | Treated as a failed batch |

**A failed batch never fails the campaign.** Those recipients are reported
unresolved; everyone else still receives their message. If you return 500 for a
single bad ID, you cost that whole batch — prefer omitting the record.

Default timeout is 3 seconds per request. If your lookup is slower, raise
`timeout_ms` rather than letting it abort.

---

## 5. A minimal implementation

```js
app.post("/scalemargin/lookup", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.SM_LOOKUP_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // `fields` holds your name for the one contact field this channel needs.
  const { user_ids, fields } = req.body;
  const rows = await db.query(
    `SELECT external_id, email_address, mobile_number
       FROM customers
      WHERE external_id = ANY($1) AND marketing_consent = true`,
    [user_ids]
  );

  // Only what was asked for; omit anyone not found.
  const users = rows.map((r) => ({
    user_id: r.external_id,
    ...(fields.includes("email_address") && { email_address: r.email_address }),
    ...(fields.includes("mobile_number") && { mobile_number: r.mobile_number }),
  }));

  res.json({ users });
});
```

Consent filtering belongs here, in your query — the dispatcher sends to whoever
you return.

---

## 6. Checklist

- [ ] Rejects a request with a missing or wrong bearer token — `401`
- [ ] Returns only `user_id` plus the one requested contact field
- [ ] Omits unresolvable IDs instead of returning nulls
- [ ] Handles the full `max_ids_per_query` batch (default 500–1000 IDs)
- [ ] Responds within `timeout_ms`
- [ ] Returns `5xx` only for genuine faults, never for one unknown ID
- [ ] Filters out anyone who has not consented

---

## 7. What changes in network mode

**`field` and `query` variables stop being available.** Both read your
database — a column, or a SQL query — and in network mode the dispatcher has no
connection. It refuses to create them, the ScaleMargin platform hides both
options, and any that already exist are kept but inactive: they render their
fallback until you switch back.

**Personalize with the other three:** `api` (an HTTP call per recipient —
e.g. `GET https://api.your-company.com/users/{{user_id}}/first-name`),
`computed` and `constant`. The system variables `email`, `phone`,
`unsubscribe_url` and `preferences_url` always work.

A client can ask the dispatcher what is available rather than hard-coding it:
`GET /api/v1/data-plane/lookup/fields` returns
`{ "mode": "network", "field_source_supported": false, "fields": [] }`.

---

## 8. What we never send you

No message content, no campaign copy, no ScaleMargin credentials, and no data
about your other recipients. Only the opaque IDs for the batch being sent, the
channel, and the one contact field name that channel needs.
