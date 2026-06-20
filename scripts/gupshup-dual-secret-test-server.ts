/**
 * Local “dual secret” smoke test for **Gupshup WhatsApp** (mirror of `event-dual-secret-test-server.ts` / `ses-dual-secret-test-server.ts`):
 * - Provisions a tiny SQLite user DB + dispatch.yaml for phone numbers in GUPSHUP_EVENT_TEST_RECIPIENTS
 * - Enables Gupshup inbound events via generated events.yaml (SendGrid + SES off)
 * - Starts the real Express app with EVENT_TEST_CSV_PATH so signed analytics land in CSV
 * - After /health, POSTs one template message per recipient to Gupshup’s template API (optional `tag` for correlation)
 *
 * Prereqs in .env:
 *   SCALEMARGIN_DISPATCH_SECRET, SCALEMARGIN_ANALYTICS_SECRET (same as other event tests — required by the server)
 *   GUPSHUP_WEBHOOK_SECRET — optional; when set, enables inbound webhook HMAC at /api/scalemargin/gupshup-events
 *   GUPSHUP_API_KEY — app API key from Gupshup (io template API; optional if USER_ID+PASSWORD set)
 *   GUPSHUP_USER_ID + GUPSHUP_PASSWORD — enterprise SendMessage API at https://smsgupshup.com (HSM)
 *   GUPSHUP_MESSAGE_TYPE — default HSM (enterprise)
 *   GUPSHUP_EVENT_TEST_SRC_NAME — Gupshup app name (src.name) — required for API key mode
 *   GUPSHUP_EVENT_TEST_TEMPLATE — JSON for the template object, e.g. {"id":"<uuid>","params":["a","b"]}
 *   GUPSHUP_EVENT_TEST_RECIPIENTS — comma-separated destination numbers (digits only, country code included, e.g. 919876543210)
 *
 * Optional:
 *   GUPSHUP_EVENT_TEST_SOURCE — WABA sender number (digits only). Defaults to GUPSHUP_EVENT_TEST_DEFAULT_SOURCE or first recipient (set explicitly to your WABA)
 *   GUPSHUP_EVENT_TEST_API_URL — default https://api.gupshup.io/wa/api/v1/template/msg
 *   EVENT_TEST_PUBLIC_BASE_URL — ngrok/tunnel origin so analytics_callback_url inside tag is reachable
 *   GUPSHUP_EVENT_TEST_SKIP_SEND=1 — do not call Gupshup send API after startup (webhook-only manual testing)
 *   EVENT_TEST_AUTO_DISPATCH=0 — alias skip: no auto-send (same env name as other scripts)
 *
 * Gupshup console: set callback URL to https://<tunnel>/api/scalemargin/gupshup-events and enable signing with the same secret as GUPSHUP_WEBHOOK_SECRET.
 *
 * Correlation: outbound `tag` is a JSON string with campaign_id, user_id, organization_id, analytics_callback_url.
 * If your Gupshup account echoes `tag` on message-event webhooks, rows appear in the CSV automatically.
 * If webhooks arrive without `tag`, configure Gupshup to pass metadata or extend the reference app (e.g. message-id registry).
 */

import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoDotEnv } from "../src/load-repo-dotenv.js";
import {
  buildWhatsAppMediaMessageForUser,
  buildWhatsAppMessageForUser,
  parseWhatsAppMediaSpec,
  parseWhatsAppTemplateSpec,
  resolveGupshupConfig,
  sendGupshupWhatsApp,
} from "../src/providers/gupshup-whatsapp.js";
import type { UserRecord } from "../src/user-lookup/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function waitForServerHealth(portNum: number, timeoutMs: number): Promise<void> {
  const base = `http://127.0.0.1:${portNum}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* ECONNREFUSED until child listens */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${base}/health did not return OK within ${timeoutMs}ms`);
}

loadRepoDotEnv(repoRoot);

const recipientsRaw = process.env.GUPSHUP_EVENT_TEST_RECIPIENTS?.trim();
if (!recipientsRaw) {
  console.error(
    "Set GUPSHUP_EVENT_TEST_RECIPIENTS in .env (comma-separated WhatsApp numbers, digits only, e.g. 919876543210,9188...)"
  );
  process.exit(1);
}
const recipients = recipientsRaw
  .split(",")
  .map((s) => s.trim().replace(/^\+/, ""))
  .filter(Boolean);
if (recipients.length < 1) {
  console.error("GUPSHUP_EVENT_TEST_RECIPIENTS must list at least one phone number.");
  process.exit(1);
}

requireEnv("SCALEMARGIN_DISPATCH_SECRET");
requireEnv("SCALEMARGIN_ANALYTICS_SECRET");

const gupshupWebhookSecret = process.env.GUPSHUP_WEBHOOK_SECRET?.trim();
if (!gupshupWebhookSecret) {
  console.warn(
    "[gupshup-event-test] GUPSHUP_WEBHOOK_SECRET not set — outbound send still runs; " +
      "inbound Gupshup webhooks (/api/scalemargin/gupshup-events) stay disabled until you set it."
  );
}

const gupshupConfig = resolveGupshupConfig();
if (!gupshupConfig) {
  console.error(
    "Set GUPSHUP_API_KEY or GUPSHUP_USER_ID + GUPSHUP_PASSWORD in .env for outbound WhatsApp send."
  );
  process.exit(1);
}

const mediaSpec = parseWhatsAppMediaSpec(undefined);
const templateSpec = mediaSpec
  ? null
  : parseWhatsAppTemplateSpec(
      undefined,
      process.env.GUPSHUP_EVENT_TEST_TEMPLATE?.trim()
    );

if (!mediaSpec && !templateSpec) {
  console.error(
    "Set GUPSHUP_EVENT_TEST_CAPTION + GUPSHUP_EVENT_TEST_MEDIA_URL for media send, " +
      "or GUPSHUP_EVENT_TEST_TEMPLATE for HSM template send."
  );
  process.exit(1);
}

if (mediaSpec) {
  console.log(
    "[gupshup-event-test] Resolved env media spec:\n" +
      JSON.stringify(mediaSpec, null, 2)
  );
} else if (templateSpec) {
  console.log(
    "[gupshup-event-test] Resolved env template spec:\n" +
      JSON.stringify(templateSpec, null, 2)
  );
}

const srcName =
  process.env.GUPSHUP_EVENT_TEST_SRC_NAME?.trim() ||
  process.env.GUPSHUP_SRC_NAME?.trim() ||
  "";
if (gupshupConfig.mode === "apikey" && !srcName) {
  requireEnv("GUPSHUP_EVENT_TEST_SRC_NAME");
}

const portNum = parseInt(process.env.PORT || "3100", 10);
const port = String(portNum);
const publicBase = (process.env.EVENT_TEST_PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(
  /\/$/,
  ""
);
const captureUrl = `${publicBase}/api/webhooks/campaign-analytics/capture`;

const sourceRaw =
  process.env.GUPSHUP_EVENT_TEST_SOURCE?.trim() ||
  process.env.GUPSHUP_EVENT_TEST_DEFAULT_SOURCE?.trim() ||
  process.env.GUPSHUP_SOURCE?.trim();
if (gupshupConfig.mode === "apikey" && !sourceRaw) {
  console.error(
    "Set GUPSHUP_EVENT_TEST_SOURCE to your WABA sender number (digits only, e.g. 918971741003), " +
      "or set GUPSHUP_EVENT_TEST_DEFAULT_SOURCE / GUPSHUP_SOURCE in .env."
  );
  process.exit(1);
}
const source = sourceRaw?.replace(/^\+/, "") ?? "";

const apiUrl = mediaSpec
  ? gupshupConfig.mediaApiUrl
  : gupshupConfig.mode === "apikey"
    ? gupshupConfig.templateApiUrl
    : gupshupConfig.enterpriseApiUrl;

const workDir = join(tmpdir(), `gupshup-dual-secret-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const dbPath = join(workDir, "gupshup-event-test-users.sqlite");
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE users_internal (
    user_id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    company_name TEXT,
    phone_no TEXT
  );
  CREATE VIEW users AS
    SELECT user_id, first_name, last_name, email, company_name, phone_no
    FROM users_internal;
`);
const ins = db.prepare(
  `INSERT INTO users_internal (user_id, first_name, last_name, email, company_name, phone_no)
   VALUES (?, ?, ?, ?, ?, ?)`
);
recipients.forEach((phone, idx) => {
  const uid = `gup_evt_u${idx + 1}`;
  ins.run(uid, "WA", `Test${idx + 1}`, `${uid}@gupshup-event-test.invalid`, "Gupshup event test", phone);
});
db.close();

const dispatchYamlPath = join(workDir, "dispatch.yaml");
const sqliteJson = JSON.stringify(dbPath);
writeFileSync(
  dispatchYamlPath,
  `
user_lookup:
  backend: sqlite
  sqlite:
    file: ${sqliteJson}
  source:
    kind: view
    name: users
    id_column: user_id
    id_type: string
  fields:
    first_name: first_name
    last_name: last_name
    email: email
    company_name: company_name
    phone: phone_no
placeholders:
  first_name: { source: field, field: first_name, fallback: "there" }
  last_name: { source: field, field: last_name, fallback: "" }
  full_name: { source: computed, expr: "first_name + ' ' + last_name", fallback: "there" }
  company_name: { source: field, field: company_name, fallback: "" }
  email: { source: field, field: email, fallback: "" }
  phone: { source: field, field: phone, fallback: "" }
`
);

const eventsYamlPath = join(workDir, "events.yaml");
writeFileSync(
  eventsYamlPath,
  `events:
  forward:
    mode: sync
    batch_size: 50
    batch_interval_ms: 2000
  delivery:
    mode: best_effort
    buffer:
      kind: memory
      max_events_memory: 10000
  providers:
    sendgrid:
      enabled: false
    ses:
      enabled: false
    gupshup:
      enabled: ${gupshupWebhookSecret ? "true" : "false"}
      secret_env: GUPSHUP_WEBHOOK_SECRET
`
);

const csvRel = process.env.GUPSHUP_EVENT_TEST_CSV_PATH || "./data/gupshup-event-test-capture.csv";
const csvAbs = join(repoRoot, csvRel);
mkdirSync(dirname(csvAbs), { recursive: true });

const campaignId = `gup_evt_local_${Date.now()}`;
const organizationId = "org_gupshup_event_test";

const autoSend =
  process.env.GUPSHUP_EVENT_TEST_SKIP_SEND !== "1" &&
  process.env.GUPSHUP_EVENT_TEST_SKIP_SEND !== "true" &&
  process.env.EVENT_TEST_AUTO_DISPATCH !== "0" &&
  process.env.EVENT_TEST_AUTO_DISPATCH !== "false";

console.log(`
=== Gupshup WhatsApp dual-secret local test ===
Work dir: ${workDir}
Campaign id: ${campaignId}
CSV file: ${csvAbs}
Capture URL (inside outbound tag): ${captureUrl}
Gupshup auth: ${gupshupConfig.mode === "apikey" ? "API key (io template API)" : "userid/password (enterprise)"}
Send mode: ${mediaSpec ? "SENDMEDIAMESSAGE (caption + image)" : "template (HSM / io)"}
Gupshup send API: ${apiUrl}
Source (WABA): ${source || "(enterprise — not required)"}
Auto template send: ${autoSend ? "yes (after /health)" : "no (GUPSHUP_EVENT_TEST_SKIP_SEND=1 or EVENT_TEST_AUTO_DISPATCH=0)"}

1) Gupshup inbound webhooks: ${gupshupWebhookSecret ? "enabled" : "disabled (set GUPSHUP_WEBHOOK_SECRET to enable)"}
   Callback URL (HTTPS): ${publicBase}/api/scalemargin/gupshup-events
   ${gupshupWebhookSecret ? "HMAC secret: GUPSHUP_WEBHOOK_SECRET (x-gupshup-signature = hex HMAC-SHA256 of raw JSON body)." : "Skipped until GUPSHUP_WEBHOOK_SECRET is configured in Gupshup + .env."}

2) Recipients (${recipients.length}): ${recipients.join(", ")}

3) Template JSON (from GUPSHUP_EVENT_TEST_TEMPLATE) must match an approved template in your Gupshup app.

4) Watch ${csvAbs} after Gupshup POSTs message-event webhooks (enqueued → dispatched, delivered, read, …).

5) Credentials: API key + src.name + WABA for io API, or GUPSHUP_USER_ID + GUPSHUP_PASSWORD for enterprise HSM at smsgupshup.com.

Set EVENT_TEST_PUBLIC_BASE_URL to your tunnel so analytics_callback_url in each tag is publicly reachable.
CSV path override: GUPSHUP_EVENT_TEST_CSV_PATH (default ./data/gupshup-event-test-capture.csv)
`);

async function postTemplateToGupshup(
  destination: string,
  userId: string,
  user: UserRecord
): Promise<{ ok: boolean; status: number; text: string }> {
  const message = mediaSpec
    ? buildWhatsAppMediaMessageForUser(
        mediaSpec,
        user,
        destination,
        { campaign_id: campaignId, organization_id: organizationId },
        {
          campaign_id: campaignId,
          user_id: userId,
          organization_id: organizationId,
          analytics_callback_url: captureUrl,
        }
      )
    : buildWhatsAppMessageForUser(
        templateSpec!,
        user,
        destination,
        { campaign_id: campaignId, organization_id: organizationId },
        {
          campaign_id: campaignId,
          user_id: userId,
          organization_id: organizationId,
          analytics_callback_url: captureUrl,
        }
      );

  const omitTag =
    process.env.GUPSHUP_EVENT_TEST_OMIT_TAG === "1" ||
    process.env.GUPSHUP_EVENT_TEST_OMIT_TAG === "true";
  if (omitTag) {
    delete message.context;
  }

  const cfg = {
    ...gupshupConfig,
    ...(gupshupConfig.mode === "apikey"
      ? { srcName, source }
      : {}),
  };
  const result = await sendGupshupWhatsApp(message, cfg);
  return {
    ok: result.success,
    status: result.success ? 200 : 502,
    text: result.error ?? result.messageId ?? "",
  };
}

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: port,
  USER_LOOKUP_CONFIG_PATH: dispatchYamlPath,
  EVENTS_CONFIG_PATH: eventsYamlPath,
  EVENT_TEST_CSV_PATH: csvRel,
  EVENT_TEST_PUBLIC_BASE_URL: publicBase,
  /** Avoid SendGrid constructor errors if dispatch is hit accidentally. */
  EMAIL_PROVIDER: "ses",
  EVENT_FORWARD_MODE: "sync",
  EVENT_DELIVERY_MODE: "best_effort",
  FROM_EMAIL: process.env.FROM_EMAIL || "noreply@example.com",
};

const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: repoRoot,
  env: childEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (autoSend) {
  void (async () => {
    try {
      await waitForServerHealth(portNum, 60_000);
      let okCount = 0;
      for (let i = 0; i < recipients.length; i++) {
        const dest = recipients[i]!;
        const userId = `gup_evt_u${i + 1}`;
        const user: UserRecord = {
          user_id: userId,
          email: `${userId}@gupshup-event-test.invalid`,
          fields: {
            first_name: "WA",
            last_name: `Test${i + 1}`,
            phone: dest,
          },
        };
        const r = await postTemplateToGupshup(dest, userId, user);
        if (r.ok) {
          okCount++;
          console.log(`\n[gupshup-event-test] Template API ${r.status} → ${dest} (user ${userId})\n${r.text.slice(0, 500)}`);
        } else {
          console.error(
            `\n[gupshup-event-test] Template API failed (${r.status}) → ${dest}\n${r.text}\n` +
              "Fix template id/params or credentials; webhook test can still proceed if you send from Gupshup UI."
          );
        }
      }
      console.log(
        `\n[gupshup-event-test] Sent ${okCount}/${recipients.length} template request(s). ` +
          `Watch CSV + Gupshup callbacks → ${publicBase}/api/scalemargin/gupshup-events\n`
      );
    } catch (e) {
      console.error("\n[gupshup-event-test] Auto-send failed:\n", e);
    }
  })();
}

const cleanupWorkdir = () => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

process.on("SIGINT", () => {
  child.kill("SIGINT");
  cleanupWorkdir();
  process.exit(0);
});

child.on("exit", (code) => {
  if (process.env.EVENT_TEST_KEEP_WORKDIR !== "1") {
    cleanupWorkdir();
  } else {
    console.log(`[gupshup-event-test] Kept work dir (EVENT_TEST_KEEP_WORKDIR=1): ${workDir}`);
  }
  process.exit(code ?? 0);
});
