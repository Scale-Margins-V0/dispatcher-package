---
"scalemargin-dispatch-handler": minor
---

Merge **Delivery activity, Dispatches, Failures and Webhooks into one campaign console** (`/admin#campaigns`), built on a new per-recipient event store.

**New storage.** `campaign_events` records every PII-stripped lifecycle event (dispatched → delivered → opened/read → clicked, plus bounced/complained/unsubscribed/failed) with a unique `dedupe_key`, so provider webhook replays are idempotent. Events are captured at two choke points: `emitEvent` (both dispatch paths) and the inbound webhook handler, which now standardizes and persists **before** the callback-URL gate — correlated provider events with no registered callback are recorded for the console instead of being dropped. A one-shot startup backfill copies surviving `event_outbox` envelopes so existing deployments see their history immediately. Retention sweeps the table (90d, `DISPATCHER_CAMPAIGN_EVENTS_RETENTION_DAYS`) with a row cap (`DISPATCHER_CAMPAIGN_EVENTS_MAX_ROWS`, default 500k).

**Programs, not sends.** ScaleMargin addresses a drip step as `drip_{enrollmentId}_{stepId}` — unique per (sequence × lead × step) — so the wire `campaign_id` names a single *send*, not a campaign. Grouping on it would list one "campaign" per recipient per step (a 240-lead × 4-step drip becomes 678 rows). The dispatcher now captures the `dispatch_kind` / `drip_sequence_id` / `step_id` metadata ScaleMargin already sends, resolves every send to its **program** (the sequence for drips, the campaign id for blasts) via a new `dispatch_programs` map, and groups the console by program with a per-step breakdown. Inbound webhooks carry only the wire id, so they resolve through that map.

**Per-channel stages.** `read` is no longer folded into `opened`: an email open is a tracking pixel (inflated by Apple Mail privacy protection, suppressed by blocked images) while a WhatsApp read is a receipt the recipient can disable, and SMS reports no view signal at all. Each channel's funnel tile speaks its own vocabulary — "Opened" for email/push, "Read" for WhatsApp, nothing for SMS — and a multi-channel drip shows both side by side rather than averaging them.

The console groups a recipient's whole journey across steps and channels, with an inline event timeline, provider metadata, send-time failure detail, per-campaign forwarding state and logs. Old `#activity` / `#dispatches` / `#failures` / `#webhooks` hashes redirect to `#campaigns`.

Also fixes a latent pagination bug in `listDispatchRuns`: the cursor interpolated a `Date` through a raw `sql` template, which skips the column encoder and throws on SQLite.
