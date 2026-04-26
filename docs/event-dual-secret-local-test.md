# Local dual-secret + SendGrid event test

SendGrid dashboard and env overview: **[`sendgrid.readme.md`](sendgrid.readme.md)**. This document focuses on the **dual-secret + ngrok + CSV** flow.

This flow exercises **two different HMAC secrets** on the same running server:

1. **`SCALEMARGIN_DISPATCH_SECRET`** — verifies `POST /api/scalemargin/dispatch` (`X-ScaleMargin-Signature` over the raw JSON body).
2. **`SCALEMARGIN_ANALYTICS_SECRET`** — signs outbound analytics POSTs from the event pipeline, and verifies **`POST /api/webhooks/campaign-analytics/capture`** when you enable CSV capture for local testing.

## Same ngrok host (“double proxy”): webhooks, analytics, and unsubscribe links

Use **one** public HTTPS origin for everything SendGrid and the browser must reach:

| Path | Role |
| ---- | ---- |
| `/api/scalemargin/sendgrid-events` | SendGrid Event Webhook (signed POST, raw provider JSON → PII strip → signed analytics POST) |
| `/api/webhooks/campaign-analytics/capture` | Dev CSV capture (or your main ScaleMargin analytics URL in production) |
| `/api/unsubscribe` | Optional **GET** unsubscribe link target (client-facing path; no `/scalemargin/`). Records **`unsubscribed`** with **no email in the URL** (only `uid`, `campaign_id`, `organization_id` query params from the mail template) and POSTs the **same** signed analytics shape as the event pipeline when **`UNSUBSCRIBE_LINK_ANALYTICS_URL`** is set |

With **`pnpm run dev:event-test`**, the child process defaults **`UNSUBSCRIBE_URL_BASE`** to `<EVENT_TEST_PUBLIC_BASE_URL>/api/unsubscribe` and **`UNSUBSCRIBE_LINK_ANALYTICS_URL`** to the same capture URL as dispatch’s `metadata.analytics_callback_url`, so link clicks and SendGrid webhooks both produce CSV rows without sending raw PII to ScaleMargin. SendGrid may still emit a separate **`unsubscribe`** webhook after subscription tracking — you may see two rows (link vs webhook); `metadata.source` distinguishes **`unsubscribe_link_click`** from provider-forwarded events.

## Configure ngrok and test

1. **Install** [ngrok](https://ngrok.com/download) and run `ngrok config add-authtoken <token>` once (token from the ngrok dashboard).

2. **Start the handler** on a fixed port (default **3100**), e.g. `pnpm run dev:event-test` or `pnpm run dev` with the same env vars you use in production tests.

3. **Expose the port** (replace `3100` if you changed `PORT`):

   ```bash
   ngrok http 3100
   ```

4. Copy the **HTTPS** forwarding URL from the ngrok UI or terminal (e.g. `https://a1b2c3d4.ngrok-free.app`). Do **not** use the `http://127.0.0.1:4040` link — that is only the ngrok **inspector** UI.

5. **Point your app at the public origin** so generated URLs are reachable from SendGrid’s servers:

   ```bash
   export EVENT_TEST_PUBLIC_BASE_URL=https://a1b2c3d4.ngrok-free.app
   ```

   Then restart the server (or run `pnpm run dev:event-test` with that variable in `.env`). The printed `analytics_callback_url` must use this host so **signed analytics POSTs** hit your tunnel, not `127.0.0.1`.

6. **SendGrid → Event Webhook** (Mail Settings → Event Webhook, or Messaging → Event Webhook depending on UI):

   - **HTTP POST URL**: `https://a1b2c3d4.ngrok-free.app/api/scalemargin/sendgrid-events`
   - Turn on **signed** verification and paste the **ECDSA public key** that matches `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` in your `.env`.
   - In the SendGrid UI, select which **raw event types** to send (e.g. Delivered, Bounce). Our server then applies its own **allowlist** (see below); subscribing to extra types in SendGrid is fine if you use `["*"]` or add them to `inbound_event_types`.
   - **Note:** SendGrid’s **“Test Integration”** button usually POSTs sample events **without** `custom_args`; the server logs one summary line (`Dropped N webhook event(s) — missing correlation`). That is expected. With **`pnpm run dev:event-test`**, a **real** signed dispatch is auto-posted by default so outbound mail includes `customArgs` and delivery webhooks correlate (set `EVENT_TEST_AUTO_DISPATCH=0` to skip and use the printed `curl` only).

7. **Trigger mail**: run the **curl** printed by `dev:event-test` (or your Atlas dispatch) so SendGrid sends messages and posts events to ngrok.

8. **Verify**: ngrok inspector at [http://127.0.0.1:4040](http://127.0.0.1:4040) shows inbound requests. Your CSV file (if `EVENT_TEST_CSV_PATH` is set) should gain rows for `dispatched` (from dispatch) and `delivered` / etc. (from SendGrid), each analytics POST using **`SCALEMARGIN_ANALYTICS_SECRET`**.

**Alternatives to ngrok**: Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3100`), localtunnel, or any HTTPS reverse proxy you control.

---

## Quick start (summary)

1. Put in `.env` at least: `SENDGRID_API_KEY`, `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`, `SCALEMARGIN_DISPATCH_SECRET`, `SCALEMARGIN_ANALYTICS_SECRET`, `FROM_EMAIL` (verified sender in SendGrid).

2. Set test inboxes in `.env`, for example:
   `EVENT_TEST_RECIPIENTS=preethamsathyamurthy@gmail.com,preetham@velantris.ai`
   (comma-separated; must match addresses you can receive on for this test).

3. Run:

   ```bash
   pnpm run dev:event-test
   ```

   The script generates a tiny SQLite user DB, `events.yaml` (SendGrid inbound on, `EVENT_FORWARD_MODE=sync`), sets `EVENT_TEST_CSV_PATH`, spawns the real `src/index.ts` server, writes **`data/event-test-dispatch-payload.json`**, and (by default) **auto-posts** a signed dispatch to `http://127.0.0.1:PORT` after `/health` is OK so real emails go out with `customArgs`. It also prints a **curl** (via your public base URL) for manual retries. Set **`EVENT_TEST_AUTO_DISPATCH=0`** to skip the auto POST.

4. Follow **Configure ngrok and test** above for tunnel + SendGrid Event Webhook URL.

5. Set **`EVENT_TEST_PUBLIC_BASE_URL`** to your tunnel origin **before** `pnpm run dev:event-test` so `metadata.analytics_callback_url` in the printed dispatch points at **`…/api/webhooks/campaign-analytics/capture`** on the public host.

6. Run the printed `curl` (after the server is up). Emails go out; SendGrid posts events back; the pipeline forwards signed analytics to the capture URL; rows append to **`data/event-test-capture.csv`** (or whatever `EVENT_TEST_CSV_PATH` you set).

### Engagement events (opened, clicked)

**Tracking vs webhook (two different SendGrid screens)**  
**Settings → Tracking** (Open Tracking = Enabled, like your screenshot) only controls whether SendGrid **records** opens and **injects** the pixel. It does **not** by itself POST `open` events to your HTTP URL.

You also need **Mail Settings → Event Webhook** (or **Messaging → Event Webhook**, depending on product): the URL you gave SendGrid must have **Open** (and **Click**, if needed) **checked in the list of event types** to send. If only *Processed* / *Delivered* are checked, you will see **delivered** in your app but **never** `open`, even with Tracking enabled.

**Then this app must allow the `open` wire** — two things must be true:

1. **SendGrid** — Event Webhook: enable **Open** / **Click** so SendGrid POSTs those payloads to your tunnel.
2. **This app** — Default `config/events.yaml` (or no `EVENT_SENDGRID_INBOUND_EVENTS`) uses a **minimal** inbound allowlist that **drops** `open` and `click` before correlation. Fix one of:
   - **`pnpm run dev:event-test`** — child sets **`EVENT_SENDGRID_INBOUND_EVENTS=*`** unless you override it in `.env`; or
   - **`EVENT_SENDGRID_INBOUND_EVENTS=*`** (or `open,click`) in `.env`, or
   - **`config/events.yaml`**: `providers.sendgrid.inbound_event_types: ["*"]` or include `open` / `click`.

If opens are still missing after that, check **ngrok** (`http://127.0.0.1:4040`) for POST bodies containing `"event":"open"`. No such requests → SendGrid or the client; requests present but no CSV rows → signature, correlation, or allowlist (server log will say).

You must **open the HTML email** in a client that **loads remote images** (SendGrid open tracking uses a tracking pixel). “Ask before loading images”, many mobile clients, and some corporate scanners either block the pixel or prefetch it once, so you may see **no** or **weird** open counts. Prefer a desktop client with images allowed, or use **SendGrid → Activity** / **Email Testing** to confirm the message has the pixel. Outbound sends from this repo set **per-message** open/click tracking on HTML mail (`tracking_settings` in the Mail Send API). The SendGrid provider also injects the **`%open-track%`** substitution token into HTML when it is absent so SendGrid can replace it with the tracking pixel (required when `substitution_tag` is set).

**Event Webhook subscription:** In the same SendGrid screen where you set the POST URL, ensure **Open** (and **Click** if you test links) are checked so SendGrid actually emits those event types to your URL.

## SendGrid: few events by default (extensible)

- If you **do not** configure SendGrid’s Event Webhook, **no** SendGrid delivery events reach this app. You still get **`dispatched`** (and **`failed`** if send fails) from the **dispatch** path, signed with the analytics secret when forwarded.
- If you **do** configure the webhook, this repo **defaults** to forwarding a **small set** of SendGrid wire `event` values: `processed`, `delivered`, `bounce`, `dropped`, `deferred`, `spamreport`, `unsubscribe`, `group_unsubscribe` — lifecycle, deliverability, abuse, and **unsubscribe** (mapped to analytics `unsubscribed`). **`open` / `click`** still require opt-in unless you use `["*"]` or `EVENT_SENDGRID_INBOUND_EVENTS=*`.

Unsubscribe webhooks are PII-stripped like other events; the server also prints **`[Events][PreferenceSimulation]`** (correlation + scrubbed metadata) as a stub for a future suppression webhook — disable with **`EVENT_PREFERENCE_SIMULATION_LOG=0`**. Enable **Unsubscribed** / **Group Unsubscribed** in SendGrid’s Event Webhook checklist.

Override in **`config/events.yaml`**:

```yaml
providers:
  sendgrid:
    enabled: true
    inbound_event_types: [delivered, bounce, open, click]  # explicit list
    # or: inbound_event_types: ["*"]   # every type we can map in adapters/sendgrid.ts
```

Or env: **`EVENT_SENDGRID_INBOUND_EVENTS`** — `default` (or empty), `*` / `all`, or comma-separated wires (`delivered,open`).

To support a **new** SendGrid type: add a row in `mapSendGridEventType` in `src/events/adapters/sendgrid.ts`, then include that wire name in your YAML list (or use `["*"]`).

## CSV columns

`received_at`, `campaign_id`, `organization_id`, `user_id`, `event`, `channel`, `idempotency_key`, `metadata_json`

## Same server as normal dev

You can instead run `pnpm run dev` or `pnpm run dev:local` and export the same variables (`EVENT_TEST_CSV_PATH`, `EVENTS_CONFIG_PATH`, etc.) yourself; the capture route is registered whenever `EVENT_TEST_CSV_PATH` is non-empty.
