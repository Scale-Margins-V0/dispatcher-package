---
"scalemargin-dispatch-handler": minor
---

Add a public **`GET /logs`** query API — bearer-token (or admin-session) authenticated, with rich filters (`from`/`to`/`since`, `level`/`min_level`, `component`, `campaign_id`, `request_id`, message search, keyset pagination up to 1000/page) for external log tooling. Add a **log webhook** configured under Settings → Observability: each log at or above a configurable minimum level (default `warn`) is POSTed to an endpoint as JSON, optionally HMAC-signed, fire-and-forget with a concurrency cap and drop-on-overflow so a slow/dead endpoint never blocks the app. The bearer token is stored hashed and the webhook signing secret is redacted in API responses.
