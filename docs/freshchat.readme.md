# Freshchat WhatsApp — Configure, Test, and Multi-Sender Routing

This guide covers **outbound WhatsApp messaging** via the Freshchat (Freshworks) Outbound Messages API for this dispatcher, including multi-sender configuration, Rendezvous (HRW) routing, and gated failovers.

---

## What the app uses Freshchat for

| Flow | Route / behavior |
|------|------------------|
| **Multi-sender WhatsApp routing** | Configured in `.env.yaml` with `provider: freshchat`. Supports weighted HRW recipient hashing, synchronous pin validation, in-memory circuit breakers, and automatic failovers. |
| **Back-compat single-sender mode** | If `WHATSAPP_PROVIDER=freshchat` is set without `.env.yaml`, the dispatcher synthesizes a default Freshchat sender from `FRESHCHAT_*` env variables. |
| **Pipeline events** | Automatically emits `dispatched` or `failed` events through the ScaleMargin analytics event pipeline upon message send, capturing `provider: "freshchat"`, `sender_id`, and `provider_message_id` (`request_id`). |

Code touchpoints: `src/providers/freshchat-whatsapp.ts`, `src/providers/senders.ts`, `src/dispatch/whatsapp.ts`, `src/env-yaml.ts`.

---

## Multi-sender `.env.yaml` configuration

Define one or more Freshchat senders in `.env.yaml`:

```yaml
version: 1

routing:
  failover:
    max_attempts: 2
    breaker:
      failure_threshold: 5
      cooldown_ms: 60000

senders:
  - id: freshchat-primary
    channel: whatsapp
    provider: freshchat
    organizations: ["*"]
    from: "+919876543210"
    weight: 2
    enabled: true
    freshchat:
      api_key_env: FRESHCHAT_API_KEY
      api_endpoint_env: FRESHCHAT_OUTBOUND_MESSAGES_URL
      namespace_env: FRESHCHAT_NAMESPACE
      from_number_env: FRESHCHAT_FROM_NUMBER
      default_template: study_abroad_enquiry

  - id: gupshup-backup
    channel: whatsapp
    provider: gupshup
    organizations: ["*"]
    weight: 1
    enabled: true
    gupshup:
      mode: api_key
      api_key_env: GUPSHUP_API_KEY
      default_template: study_abroad_enquiry
```

---

## Environment variables

Set these in `.env` (see also [`.env.example`](../.env.example)).

| Variable | When | Purpose |
|----------|------|---------|
| `WHATSAPP_PROVIDER` | Back-compat mode | Set to `freshchat` to use Freshchat for default WhatsApp dispatches. |
| `FRESHCHAT_API_KEY` | Required for Freshchat | Bearer token / API key authorized to send outbound WhatsApp messages. |
| `FRESHCHAT_OUTBOUND_MESSAGES_URL` | Required for Freshchat | API endpoint URL (e.g. `https://api.freshchat.com/v2/outbound-messages/whatsapp` or regional account endpoint). |
| `FRESHCHAT_NAMESPACE` | Required for Freshchat | WhatsApp message template namespace from Freshchat / Meta account. |
| `FRESHCHAT_FROM_NUMBER` | Required for Freshchat | Sender phone number configured in Freshchat WhatsApp Business account (e.g. `+919876543210`). |
| `FRESHCHAT_DEFAULT_TEMPLATE` | Optional fallback | Fallback template name or JSON template spec if not provided in campaign payload. |
| `FRESHCHAT_EVENT_TEST_RECIPIENTS` | Optional dev test | Comma-separated test phone numbers. When set, all recipients in a dispatch are rerouted to this number for safe testing. |
| `SCALEMARGIN_DISPATCH_SECRET` | Dispatch | Verifies `POST /api/scalemargin/dispatch`. |
| `SCALEMARGIN_ANALYTICS_SECRET` | Analytics POSTs | Signs outbound analytics event payload. |

---

## Dispatch payload format

When dispatching WhatsApp campaigns with Freshchat, ScaleMargin sends:

```json
{
  "campaign_id": "camp_freshchat_promo_01",
  "channel": "whatsapp",
  "user_ids": ["usr_123", "usr_456"],
  "content": {
    "template_id": "winter_discount_offer",
    "caption": "Hello {{first_name}}, get {{discount}}% off with code {{coupon_code}}!",
    "media_url": "https://cdn.example.com/assets/promo-banner.png"
  },
  "metadata": {
    "sender_id": "freshchat-primary",
    "organization_id": "org_abc",
    "analytics_callback_url": "https://api.scalemargin.com/api/webhooks/analytics"
  }
}
```

---

## Testing and verification

### 1. Run unit tests
```bash
npx vitest run src/providers/freshchat-whatsapp.spec.ts
```

### 2. Run multi-sender test suite
```bash
npx vitest run src/env-yaml.spec.ts src/providers/senders.spec.ts src/providers/multi-sender-integration.spec.ts
```
