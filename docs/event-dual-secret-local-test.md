# Local dual-secret + SendGrid event test

This flow exercises **two different HMAC secrets** on the same running server:

1. **`SCALEMARGIN_DISPATCH_SECRET`** — verifies `POST /api/scalemargin/dispatch` (`X-ScaleMargin-Signature` over the raw JSON body).
2. **`SCALEMARGIN_ANALYTICS_SECRET`** — signs outbound analytics POSTs from the event pipeline, and verifies **`POST /api/webhooks/campaign-analytics/capture`** when you enable CSV capture for local testing.

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

Two things must be true:

1. **SendGrid** — In Event Webhook configuration, enable the event types you want (e.g. **Open**, **Click**). Otherwise SendGrid never POSTs them.
2. **This app** — Default `config/events.yaml` uses a **minimal** inbound allowlist (no open/click). For `pnpm run dev:event-test`, the child process sets **`EVENT_SENDGRID_INBOUND_EVENTS=*`** unless you set it in `.env` (use `default` for the minimal set, or a comma-separated wire list).

You must **open the HTML email** (or load tracking pixels) and **click a link** in a real client for open/click events to fire.

## SendGrid: few events by default (extensible)

- If you **do not** configure SendGrid’s Event Webhook, **no** SendGrid delivery events reach this app. You still get **`dispatched`** (and **`failed`** if send fails) from the **dispatch** path, signed with the analytics secret when forwarded.
- If you **do** configure the webhook, this repo **defaults** to forwarding only a **small set** of SendGrid wire `event` values: `processed`, `delivered`, `bounce`, `dropped`, `deferred`, `spamreport` — lifecycle and deliverability, **not** `open` / `click` / `unsubscribe` unless you opt in.

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
