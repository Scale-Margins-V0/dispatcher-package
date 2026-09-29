# Sending a click event to the dispatcher

How to tell the dispatcher that a recipient clicked a WhatsApp message it sent.

## Request

```http
POST https://<dispatcher>/api/scalemargin/freshchat-events
Content-Type: application/json
Authorization: Bearer <webhook_secret>
```

`<webhook_secret>` is the `webhook_secret` of your Freshchat sender in `.env.yaml`.

```json
{
  "request_id": "cda23519-7124-4ebf-9c2c-c8eab0756bee",
  "status": "CLICKED",
  "timestamp": "2026-09-29T10:15:00Z"
}
```

| Field | Required | Value |
| --- | --- | --- |
| `request_id` | yes | The `request_id` Freshchat returned when it accepted the message. It is `provider_message_id` in the dispatcher's `provider_message_ids` table |
| `status` | yes | `CLICKED` |
| `timestamp` | no | When the click happened, ISO 8601. Default: when the request arrives |

To send several clicks at once, send an array of these objects.

## Response

| Code | Meaning |
| --- | --- |
| `200 {"received": true, "count": 0, "receipts": 1}` | Accepted and sent on to ScaleMargin |
| `401 {"error": "invalid signature"}` | Wrong or missing secret |
| `400 {"error": "invalid webhook payload"}` | The body is not JSON |

If `delivered` or `read` was never reported for that message, the dispatcher reports them first, so the click is never counted without them. A click already reported for the message is not sent again.

## Example

```bash
curl -X POST "https://<dispatcher>/api/scalemargin/freshchat-events" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FRESHCHAT_WEBHOOK_SECRET" \
  -d '{"request_id":"cda23519-7124-4ebf-9c2c-c8eab0756bee","status":"CLICKED","timestamp":"2026-09-29T10:15:00Z"}'
```

Use the Freshchat `request_id`, not the WhatsApp message id (`wamid…`). A click sent with only a `wamid` is not matched to a message and never reaches ScaleMargin.
