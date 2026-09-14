# User lookup over the network — the contract

**Who this is for.** You are running the ScaleMargin Dispatcher in **network
mode**, so instead of giving it read access to your database, you expose one
endpoint that resolves opaque user IDs into contact details.

You implement one endpoint. It takes a list of IDs and a list of field names,
and returns whatever it can resolve.

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
  "fields": ["email", "phone", "first_name"]
}
```

| Field | Meaning |
| --- | --- |
| `user_ids` | Opaque IDs, exactly as ScaleMargin sent them. Always JSON strings. Deduplicated, and split into batches of `max_ids_per_query` |
| `fields` | The logical names we need. Taken from the `fields:` map in `.env.yaml`, so it only changes when that file changes |

The URL and token come from `user_lookup.network` in `.env.yaml`. The field list
is fixed by your configuration — you can code against it and it will not shift
underneath you.

---

## 3. The response

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

### Rules

- **`user_id` is required** on every record and must match an ID we sent. It is
  compared as a string; a JSON number `42` matches the ID `"42"`, but anything
  else leaves that recipient unresolved.
- **Omit users you cannot resolve.** Do not return `null` placeholders. A
  missing ID is recorded as `user_not_found`, that recipient is skipped, and the
  rest of the campaign still sends.
- **Omit fields you do not have.** The dispatcher uses that variable's fallback.
- **`email` is required to address anyone.** A record without a non-empty
  `email` is dropped, exactly as it would be from a database lookup.
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

  const { user_ids, fields } = req.body;
  const rows = await db.query(
    `SELECT external_id, email_address, mobile_number, given_name
       FROM customers
      WHERE external_id = ANY($1) AND marketing_consent = true`,
    [user_ids]
  );

  // Only what was asked for; omit anyone not found.
  const users = rows.map((r) => ({
    user_id: r.external_id,
    ...(fields.includes("email") && { email: r.email_address }),
    ...(fields.includes("phone") && { phone: r.mobile_number }),
    ...(fields.includes("first_name") && { first_name: r.given_name }),
  }));

  res.json({ users });
});
```

Consent filtering belongs here, in your query — the dispatcher sends to whoever
you return.

---

## 6. Checklist

- [ ] Rejects a request with a missing or wrong bearer token — `401`
- [ ] Returns only `user_id` plus the requested fields
- [ ] Omits unresolvable IDs instead of returning nulls
- [ ] Handles the full `max_ids_per_query` batch (default 500–1000 IDs)
- [ ] Responds within `timeout_ms`
- [ ] Returns `5xx` only for genuine faults, never for one unknown ID
- [ ] Filters out anyone who has not consented

---

## 7. What changes in network mode

**`source: query` variables stop being available.** They run SQL against your
database, and in network mode the dispatcher has no connection. It refuses to
create them, the ScaleMargin platform hides the option, and any that already
exist are kept but inactive — their fallback is used until you switch back.

Everything else is unchanged: `field`, `computed`, `constant` and `api`
variables all work, and `field` variables resolve against the names in your
`fields:` map.

---

## 8. What we never send you

No message content, no campaign copy, no ScaleMargin credentials, and no data
about your other recipients. Only the opaque IDs for the batch being sent and
the list of field names.
