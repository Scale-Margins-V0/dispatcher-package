# PII guarantees (event pipeline)

## What ScaleMargin is guaranteed not to receive

For every forwarded analytics POST:

1. **Adapter `stripPii`** removes provider-known PII fields (cloned object, explicit key deletes), e.g.:
   - **SendGrid**: `email`, `ip`, `useragent`, and similar fields from the raw event before standardization.
   - **SES**: `mail.destination`, `mail.source`, recipient lists on bounce/complaint/delivery, open/click IP and user agent, etc.
   - **Gupshup**: phone-heavy fields per adapter implementation.

2. **Generic `scrubber`** runs on **`metadata`** (and merged passthrough) on the standardized payload: regex redaction for email addresses, E.164-like phones, IPv4/IPv6, and related patterns (see `src/events/scrubber.ts` and `scrubber.spec.ts` regression fixtures).

Together, unit tests require that **after both layers**, `JSON.stringify` of the outbound event does not leak planted PII in unexpected nested keys.

## What the dispatch send path may still log

Operational logs (e.g. `[Dispatch]`, provider SDK responses) may include **sender** or configuration hints. Do not log full recipient payloads in production; this reference app avoids logging full webhook bodies at info level.

For **`unsubscribed`** / **`complained`**, the event pipeline may emit **`[Events][PreferenceSimulation]`** with correlation ids and **scrubbed** `metadata` only (no raw provider body). Turn off with **`EVENT_PREFERENCE_SIMULATION_LOG=0`**.

## Auditing a new adapter

1. List every field the provider can send on webhooks; classify PII vs operational.
2. Implement **`stripPii`** as **deep clone + delete**, not shallow spread (nested objects matter).
3. Add a **scrubber regression** fixture: hide an email/phone in a weird nested key and assert the forwarded JSON is clean.
4. Grep integration test assertions for forbidden substrings (`@`, `+1`, etc.) where appropriate.

## SES vs SendGrid correlation note

SES **message tags** cannot hold a long `analytics_callback_url`. The server keeps an in-memory **campaign callback registry** at dispatch time (`registerCampaignCallback`) so SES events can still resolve the ScaleMargin URL **without** echoing it in SNS payloads. That registry must not be logged with full PII-bearing provider payloads.
