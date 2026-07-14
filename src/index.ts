/**
 * ScaleMargin Dispatch Handler — Reference Implementation
 *
 * This server receives campaign dispatch webhooks from ScaleMargin,
 * maps user_ids to PII, personalizes content, sends via your
 * configured provider (AWS SES or SendGrid), and reports analytics back.
 *
 * SETUP:
 *   1. Set environment variables (see .env.example), or `pnpm run dev:local` for insecure local placeholders
 *   2. Optional: add config/dispatch.yaml for user lookup + placeholders (see config/dispatch.example.yaml)
 *   3. Deploy to your cloud (AWS Lambda, Cloud Run, Docker, etc.)
 *   4. Configure the webhook URL in ScaleMargin Atlas
 *
 * ENV VARS:
 *   PORT                          - Server port (default: 3100)
 *   EMAIL_PROVIDER                - "ses" or "sendgrid"
 *   FROM_EMAIL                    - Sender email address
 *   SCALEMARGIN_DISPATCH_SECRET   - HMAC secret for verifying inbound dispatches
 *   SCALEMARGIN_ANALYTICS_SECRET  - HMAC secret for signing outbound analytics
 *
 *   For SES:
 *     AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or IAM role)
 *
 *   For SendGrid:
 *     SENDGRID_API_KEY
 *
 *   Local-only (never production):
 *     LOCAL_DEV=1 — if SCALEMARGIN_* secrets are unset, uses insecure placeholders so you can run `pnpm run dev:local` without Atlas secrets (e.g. HTTP profile mock testing).
 *
 *   `pnpm dev` / `pnpm start`: repo-root `.env` is loaded automatically (unless `VITEST=true`).
 */

import express, { type Express } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { processDispatch, type DispatchPayload } from "./dispatch/processor.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { recordDispatchActivity } from "./admin/activity.js";
import { initializeEventPipeline } from "./events/index.js";
import { loadRepoDotEnv } from "./load-repo-dotenv.js";
import { logUnlessVitest } from "./logging.js";
import { registerInboundWebhookRoutes } from "./routes/inbound-webhooks.js";
import { startServer } from "./server-start.js";

if (process.env.VITEST !== "true") {
  loadRepoDotEnv(join(dirname(fileURLToPath(import.meta.url)), ".."));
}
import { createEventTestCsvCaptureHandler } from "./devtools/event-test-csv-capture.js";
import { verifyAnalyticsHmacSignature } from "./middleware/analytics-hmac-verify.js";
import { verifyHmacSignature } from "./middleware/hmac.js";
import { getBuildInfo } from "./ops/build-info.js";
import { buildDiagnosticsReport, getRuntimeStatus } from "./ops/diagnostics.js";
import {
  createPreferencesGetHandler,
  createPreferencesPostHandler,
} from "./preferences/link.js";
import { createUnsubscribeLinkGetHandler } from "./unsubscribe/link.js";
import { telemetry } from "./telemetry/posthog.js";
import { lookupUsers } from "./user-lookup.js";
import { ensureDispatchConfigLoaded } from "./user-lookup/config.js";

// ---------------------------------------------------------------------------
// Startup validation — fail fast on missing config
// ---------------------------------------------------------------------------

const localDev =
  process.env.LOCAL_DEV === "1" || process.env.LOCAL_DEV === "true";
if (
  localDev &&
  process.env.NODE_ENV !== "production" &&
  (!process.env.SCALEMARGIN_DISPATCH_SECRET ||
    !process.env.SCALEMARGIN_ANALYTICS_SECRET)
) {
  process.env.SCALEMARGIN_DISPATCH_SECRET ??=
    "local-dev-placeholder-dispatch-secret";
  process.env.SCALEMARGIN_ANALYTICS_SECRET ??=
    "local-dev-placeholder-analytics-secret";
  if (process.env.VITEST !== "true") {
    console.warn(
      "[LOCAL_DEV] Placeholder SCALEMARGIN_* secrets in use — set real values for Atlas HMAC. Not for production."
    );
  }
}

const REQUIRED_ENV = [
  "SCALEMARGIN_DISPATCH_SECRET",
  "SCALEMARGIN_ANALYTICS_SECRET",
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  telemetry.capture("dispatcher_startup_config_failed", {
    component: "required_env",
    missing_env_count: missing.length,
  });
  console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
  console.error("See .env.example for all required variables.");
  process.exit(1);
}

try {
  ensureDispatchConfigLoaded();
} catch (error) {
  telemetry.captureException(error, { component: "dispatch_config" });
  console.error("[FATAL] Dispatch configuration invalid:", error);
  process.exit(1);
}

if (process.env.VITEST !== "true") {
  try {
    initializeEventPipeline();
  } catch (error) {
    telemetry.captureException(error, { component: "event_pipeline_config" });
    console.error("[FATAL] Event pipeline configuration invalid:", error);
    process.exit(1);
  }
}

const app: Express = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "3100", 10);
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@example.com";

registerAdminRoutes(app);

if (FROM_EMAIL === "noreply@example.com" && process.env.VITEST !== "true") {
  console.warn(
    "[WARN] FROM_EMAIL not set — using default noreply@example.com. Emails will likely bounce."
  );
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Parse body as text first (needed for HMAC verification), then as JSON
// Limit raised to 10MB to accommodate base64-encoded campaign images
app.use(
  "/api/scalemargin/dispatch",
  express.text({ type: "application/json", limit: "10mb" })
);
app.use(
  "/api/scalemargin/validate-pii",
  express.text({ type: "application/json", limit: "1mb" })
);
app.use(
  "/api/scalemargin/diagnostics",
  express.text({ type: "application/json", limit: "1mb" })
);

// Serve locally-stored campaign images (for IMAGE_STORAGE_PROVIDER=local)
if (process.env.IMAGE_STORAGE_PROVIDER === "local") {
  const imgDir = process.env.IMAGE_LOCAL_DIR || "./public/images";
  app.use("/images", express.static(imgDir));
}

// GET /api/unsubscribe — public unsubscribe link (no /scalemargin/ in client-facing URLs); PII-free analytics POST
app.get("/api/unsubscribe", createUnsubscribeLinkGetHandler());

// GET/POST /api/preferences — public email-preferences screen (per-category opt-out, or unsubscribe from all)
app.use("/api/preferences", express.urlencoded({ extended: false }));
app.get("/api/preferences", createPreferencesGetHandler());
app.post("/api/preferences", createPreferencesPostHandler());

// Health check
app.get("/health", (_req, res) => {
  telemetry.capture("dispatcher_health_checked");
  res.json({
    status: "ok",
    provider: process.env.EMAIL_PROVIDER || "ses",
    image_storage: process.env.IMAGE_STORAGE_PROVIDER || "none",
    event_test_csv_capture: Boolean(process.env.EVENT_TEST_CSV_PATH),
  });
});

// Public build identity for support and client-hosted rollout checks.
app.get("/version", (_req, res) => {
  telemetry.capture("dispatcher_version_checked");
  res.json(getBuildInfo());
});

// Public readiness-style status. This does not probe client DB/provider credentials.
app.get("/status", (_req, res) => {
  const status = getRuntimeStatus();
  telemetry.capture("dispatcher_status_checked", { status: status.status });
  res.json(status);
});

// Signed support report. Returns config shape and dependency modes, never secrets or PII values.
app.post(
  "/api/scalemargin/diagnostics",
  verifyHmacSignature,
  async (req, res) => {
    telemetry.capture("dispatcher_diagnostics_requested", {
      user_lookup_check_requested:
        Array.isArray(req.body?.sample_user_ids) ||
        req.body?.checks?.includes("user_lookup"),
    });
    const report = await buildDiagnosticsReport(req.body ?? {});
    res.json(report);
  }
);

// Signed lookup smoke test for Atlas. Returns counts and field names only.
app.post(
  "/api/scalemargin/validate-pii",
  verifyHmacSignature,
  async (req, res) => {
    const userIds: string[] = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.filter(
          (value: unknown): value is string => typeof value === "string"
        )
      : [];

    if (userIds.length === 0 || userIds.length > 25) {
      res.status(400).json({
        error: "Provide 1-25 user_ids",
        pii_conversion_ok: false,
      });
      return;
    }

    try {
      const users = await lookupUsers(userIds);
      const missing = userIds.filter((userId) => !users.has(userId));
      const fieldNames = new Set<string>();
      let emailAvailableCount = 0;

      for (const user of users.values()) {
        if (user.email) {
          emailAvailableCount += 1;
        }
        for (const fieldName of Object.keys(user.fields)) {
          fieldNames.add(fieldName);
        }
      }

      res.json({
        pii_conversion_ok:
          missing.length === 0 && emailAvailableCount === userIds.length,
        requested_count: userIds.length,
        found_count: users.size,
        missing_user_ids: missing,
        email_available_count: emailAvailableCount,
        resolved_field_names: [...fieldNames],
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "User lookup failed",
        pii_conversion_ok: false,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Dev: capture signed analytics POSTs to CSV (dual-secret / pipeline smoke test)
// Enable with EVENT_TEST_CSV_PATH=./data/event-test-capture.csv
// Dispatch metadata.analytics_callback_url must point here, e.g.
// http://127.0.0.1:3100/api/webhooks/campaign-analytics/capture (or your ngrok URL).
// ---------------------------------------------------------------------------

if (process.env.EVENT_TEST_CSV_PATH) {
  const csvHandler = createEventTestCsvCaptureHandler(
    process.env.EVENT_TEST_CSV_PATH
  );
  app.post(
    "/api/webhooks/campaign-analytics/capture",
    express.text({ type: "application/json", limit: "10mb" }),
    verifyAnalyticsHmacSignature,
    csvHandler
  );
  if (process.env.VITEST !== "true") {
    console.log(
      `[EventTest] CSV capture enabled → ${process.env.EVENT_TEST_CSV_PATH} (POST /api/webhooks/campaign-analytics/capture)`
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/scalemargin/dispatch — Campaign Dispatch Handler
// ---------------------------------------------------------------------------

app.post("/api/scalemargin/dispatch", verifyHmacSignature, async (req, res) => {
  const payload = req.body as DispatchPayload;
  const activityId = crypto.randomUUID();
  const startedAt = performance.now();

  logUnlessVitest(
    `[Dispatch] Received campaign ${payload.campaign_id} — ` +
      `${payload.user_ids?.length || 0} recipients, channel: ${payload.channel}`
  );

  // Acknowledge immediately
  telemetry.capture("dispatcher_dispatch_accepted", {
    channel: payload.channel,
    recipient_count: Array.isArray(payload.user_ids) ? payload.user_ids.length : 0,
    has_images: Boolean(payload.images?.length),
  });
  recordDispatchActivity({
    id: activityId,
    campaign_id: String(payload.campaign_id ?? "unknown"),
    channel: String(payload.channel ?? "unknown"),
    provider: payload.channel === "whatsapp" ? "gupshup" : (process.env.EMAIL_PROVIDER || "ses"),
    status: "accepted",
    recipient_count: Array.isArray(payload.user_ids) ? payload.user_ids.length : 0,
    occurred_at: new Date().toISOString(),
  });
  res.status(202).json({
    accepted: true,
    message: "Campaign dispatch received",
  });

  // Process asynchronously
  processDispatch(payload, FROM_EMAIL).then((result) => {
    recordDispatchActivity({
      id: activityId,
      campaign_id: String(payload.campaign_id ?? "unknown"),
      channel: String(payload.channel ?? "unknown"),
      provider: payload.channel === "whatsapp" ? "gupshup" : (process.env.EMAIL_PROVIDER || "ses"),
      status: "completed",
      recipient_count: Array.isArray(payload.user_ids) ? payload.user_ids.length : 0,
      sent_count: result?.sent,
      failed_count: result?.failed,
      duration_ms: Math.round(performance.now() - startedAt),
      occurred_at: new Date().toISOString(),
    });
  }).catch((error) => {
    recordDispatchActivity({
      id: activityId,
      campaign_id: String(payload.campaign_id ?? "unknown"),
      channel: String(payload.channel ?? "unknown"),
      provider: payload.channel === "whatsapp" ? "gupshup" : (process.env.EMAIL_PROVIDER || "ses"),
      status: "failed",
      recipient_count: Array.isArray(payload.user_ids) ? payload.user_ids.length : 0,
      duration_ms: Math.round(performance.now() - startedAt),
      occurred_at: new Date().toISOString(),
      error_category: error instanceof Error ? error.name : "processing_error",
    });
    telemetry.captureException(error, {
      component: "dispatch_processor",
      channel: payload.channel,
    });
    console.error(`[Dispatch] Campaign ${payload.campaign_id} failed:`, error);
  });
});
registerInboundWebhookRoutes(app);

if (process.env.VITEST !== "true") {
  startServer(app, PORT);
}

export default app;
export { app };
