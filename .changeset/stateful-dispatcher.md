---
"scalemargin-dispatch-handler": minor
---

Make the dispatcher stateful with its own Drizzle-backed SQL database (SQLite/MySQL/Postgres, attached via `DISPATCHER_DB_*`, migrations auto-run at startup). Dynamic variables (placeholders) are now stored in the DB and editable at runtime from the admin GUI/API with no redeploy; dispatch activity, per-recipient failures (with real error text and stack traces), structured application logs, the campaign→callback registry, and a durable analytics event outbox all persist across restarts. Adds a docker-compose stack and admin Variables/Logs pages.
