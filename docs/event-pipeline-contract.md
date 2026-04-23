# Event pipeline contract

This document describes the dual-webhook flow: provider delivery webhooks → **standardized events** → ScaleMargin `analytics_callback_url` (HMAC-signed batch POST, same secret as legacy `SCALEMARGIN_ANALYTICS_SECRET`).

## `StandardizedEvent` shape

Defined in `src/events/types.ts` (extends correlation fields):

| Field | Description |
| ----- | ----------- |
| `campaign_id`, `user_id`, `organization_id` | Required correlation (from provider metadata or SES tags + campaign registry). |
| `analytics_callback_url` | Resolved before forward; may come from SendGrid `custom_args`, Gupshup `tag`, or **campaign callback registry** for SES. |
| `channel` | `email` \| `whatsapp` \| `sms` |
| `event` | Analytics type: `dispatched`, `delivered`, `opened`, `clicked`, `bounced`, `complained`, `failed`, `sent`, `read`, `deferred`, `expired`, … (see `AnalyticsEventType` in `src/providers/types.ts`). |
| `provider` | `sendgrid` \| `ses` \| `gupshup` |
| `provider_message_id` | Provider-native message id. |
| `occurred_at` | ISO-8601 timestamp. |
| `idempotency_key` | Present when `delivery.mode` is `at_least_once` (hash of provider + message id + event + time). |
| `metadata` | Optional structured extras; **scrubbed** for PII before POST (see `docs/pii-guarantees.md`). Each outbound analytics event also includes **`campaign_id`**, **`organization_id`**, **`provider`**, and **`provider_message_id`** inside `metadata` so payloads are self-contained per event. |

## Channel semantics

- **SendGrid / SES**: `channel: "email"`.
- **Gupshup**: `channel: "whatsapp"` (inbound-only in this reference implementation).

## Adapter interface (`InboundEventAdapter`)

Each provider implements:

1. **`verifySignature`** — SendGrid ECDSA headers + raw body; SES outer SNS JSON (verified in `src/index.ts` before handler); Gupshup HMAC.
2. **`parseEvents`** — Raw body → one or more logical events (SendGrid: JSON array; SES: inner `Message` JSON; Gupshup: parsed body).
3. **`extractCorrelation`** — Map to `Correlation` (campaign / user / org / optional callback URL). SES merges **campaign registry** when tags cannot hold the full URL.
4. **`stripPii`** — Provider-specific deletes on raw-ish structures before standardization.
5. **`toStandardEvent`** — Build `StandardizedEvent` + map provider event names to `AnalyticsEventType`.

Outbound tagging (`OutboundTaggingAdapter`) attaches the same correlation to outbound sends so webhooks can echo it back.

## SendGrid inbound event allowlist

SendGrid’s Event Webhook can emit many wire `event` values (`delivered`, `open`, `click`, …). To stay extensible without turning every engagement signal into an analytics POST by default:

- **Omit** `providers.sendgrid.inbound_event_types` (or set env `EVENT_SENDGRID_INBOUND_EVENTS=default`) → a **minimal default** set is used: `processed`, `delivered`, `bounce`, `dropped`, `deferred`, `spamreport` (see `src/events/sendgrid-inbound-filter.ts`).
- **`["*"]`** in YAML or **`EVENT_SENDGRID_INBOUND_EVENTS=*`** → forward every wire value we know how to map in `mapSendGridEventType` (`src/events/adapters/sendgrid.ts`).
- **Explicit list** → only those wires; add new names after extending `mapSendGridEventType`.

If SendGrid’s webhook is **not** configured at all, nothing is POSTed to `/api/scalemargin/sendgrid-events`; dispatch still emits **`dispatched`** / **`failed`** from the send path.

## Delivery / forwarding matrix

| `delivery.mode` | Behavior |
| --------------- | -------- |
| `at_least_once` | Adds `idempotency_key`; failures in batched mode retain items in buffer for retry. |
| `best_effort` | No idempotency key; final forward failure drops event (counter). |

| `forward.mode` | Behavior |
| ---------------- | -------- |
| `sync` | Handler awaits `flushEnvelopesSync` before responding `200` to the provider webhook. |
| `batched` | Envelopes pushed to buffer; background flusher drains by `batch_size` / `batch_interval_ms`. |

Env overrides: `EVENT_DELIVERY_MODE`, `EVENT_FORWARD_MODE`, `EVENT_BATCH_SIZE`, `EVENT_BATCH_INTERVAL_MS`, `EVENT_BUFFER_DIR`, `EVENT_SENDGRID_INBOUND_EVENTS` (see `mergeEventsEnvOverrides` in `src/events/config.ts`).

## Add a new provider (4 steps)

1. **`src/events/adapters/<name>.ts`** — Implement `InboundEventAdapter` (verify, parse, correlate, strip PII, map types).
2. **`src/events/outbound/<name>-tagger.ts`** — Implement `OutboundTaggingAdapter` for your provider message type.
3. **`src/events/index.ts`** — Register factory in `getInboundAdapter` / outbound tagger wiring + extend `InboundProviderName` / Zod `providers` if needed.
4. **`config/events.example.yaml`** + **`src/index.ts`** — Add `events.providers.<name>` and an Express route using `createInboundWebhookHandler`.

Core pieces (`scrubber`, `forwarder`, `buffer`, `types`) stay unchanged if correlation flows through the adapter contract.

## Related

- **PII**: `docs/pii-guarantees.md`
- **Config**: `config/events.example.yaml`, `.env.example`
