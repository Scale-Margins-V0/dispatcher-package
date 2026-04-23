/**
 * Local “dual secret” smoke test:
 * - Provisions a tiny SQLite user DB + dispatch.yaml for two recipients
 * - Enables SendGrid event pipeline (sync forward) via generated events.yaml
 * - Starts the real Express app with EVENT_TEST_CSV_PATH so signed analytics land in CSV
 *
 * Prereqs in .env (or environment): SENDGRID_API_KEY, SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
 * SCALEMARGIN_DISPATCH_SECRET, SCALEMARGIN_ANALYTICS_SECRET, FROM_EMAIL (verified sender).
 *
 * Recipients: set EVENT_TEST_RECIPIENTS in .env (comma-separated, e.g. two inboxes you control).
 *
 * SendGrid Event Webhook must hit your public URL → /api/scalemargin/sendgrid-events
 * (use ngrok / Cloudflare Tunnel). Set EVENT_TEST_PUBLIC_BASE_URL to that origin for the printed curl.
 *
 * If you see EADDRINUSE on PORT (default 3100), stop the other server (`pnpm dev`, old ngrok target, etc.)
 * or set PORT=3101 in .env and run `ngrok http 3101` to match.
 *
 * By default the parent process waits for /health then POSTs a signed dispatch to localhost so real
 * emails go out with customArgs (complete pipeline). Set EVENT_TEST_AUTO_DISPATCH=0 to only print curl.
 */

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function loadDotEnv(): void {
  const p = join(repoRoot, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

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

async function postSignedDispatch(
  portNum: number,
  raw: string,
  sig: string
): Promise<Response> {
  return fetch(`http://127.0.0.1:${portNum}/api/scalemargin/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ScaleMargin-Signature": sig,
    },
    body: raw,
  });
}

loadDotEnv();

const recipientsRaw = process.env.EVENT_TEST_RECIPIENTS?.trim();
if (!recipientsRaw) {
  console.error(
    "Set EVENT_TEST_RECIPIENTS in .env (comma-separated), e.g.\n" +
      "  EVENT_TEST_RECIPIENTS=you@gmail.com,colleague@company.com"
  );
  process.exit(1);
}
const recipients = recipientsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (recipients.length < 1) {
  console.error("EVENT_TEST_RECIPIENTS must list at least one email.");
  process.exit(1);
}

const dispatchSecret = requireEnv("SCALEMARGIN_DISPATCH_SECRET");
const analyticsSecret = requireEnv("SCALEMARGIN_ANALYTICS_SECRET");
requireEnv("SENDGRID_API_KEY");
requireEnv("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY");
const fromEmail = requireEnv("FROM_EMAIL");

const portNum = parseInt(process.env.PORT || "3100", 10);
const port = String(portNum);
const publicBase = (process.env.EVENT_TEST_PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(
  /\/$/,
  ""
);
const captureUrl = `${publicBase}/api/webhooks/campaign-analytics/capture`;

const workDir = join(tmpdir(), `event-dual-secret-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const dbPath = join(workDir, "event-test-users.sqlite");
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
recipients.forEach((email, idx) => {
  const uid = `event_test_u${idx + 1}`;
  const phone = idx === 0 ? "+1-555-0100" : null;
  ins.run(uid, "Test", `User${idx + 1}`, email, "Event test co", phone);
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
  unsubscribe_url:
    source: computed
    expr: "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id"
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
      enabled: true
      signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
    ses:
      enabled: false
    gupshup:
      enabled: false
`
);

const csvRel = process.env.EVENT_TEST_CSV_PATH || "./data/event-test-capture.csv";
const csvAbs = join(repoRoot, csvRel);
mkdirSync(dirname(csvAbs), { recursive: true });

const userIds = recipients.map((_, i) => `event_test_u${i + 1}`);
const campaignId = `evt_local_${Date.now()}`;
const dispatchBody = {
  campaign_id: campaignId,
  channel: "email",
  user_ids: userIds,
  personalization_fields: ["first_name", "last_name", "email", "company_name", "phone"],
  content: {
    subject: "[event-test] {{company_name}} — Hi {{first_name}}",
    html_body: `<p>Hi {{first_name}} {{last_name}},</p>
<p>This is a <strong>dual-secret pipeline</strong> test email (real SendGrid send + Event Webhook).</p>
<ul>
  <li>Company: {{company_name}}</li>
  <li>On-file email: {{email}}</li>
  <li>Phone: {{phone}}</li>
</ul>
<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
    text_body:
      "Hi {{first_name}} — pipeline test for {{company_name}}. Email: {{email}}. Unsubscribe: {{unsubscribe_url}}",
  },
  metadata: {
    organization_id: "org_event_test",
    analytics_callback_url: captureUrl,
  },
};
const dispatchRaw = JSON.stringify(dispatchBody);
const dispatchSig = "sha256=" + createHmac("sha256", dispatchSecret).update(dispatchRaw).digest("hex");
const dispatchPayloadPath = join(workDir, "dispatch-payload.json");
writeFileSync(dispatchPayloadPath, dispatchRaw, "utf8");

const stablePayloadPath = join(repoRoot, "data", "event-test-dispatch-payload.json");
mkdirSync(dirname(stablePayloadPath), { recursive: true });
writeFileSync(stablePayloadPath, dispatchRaw, "utf8");

const autoDispatch =
  process.env.EVENT_TEST_AUTO_DISPATCH !== "0" &&
  process.env.EVENT_TEST_AUTO_DISPATCH !== "false";

console.log(`
=== Event dual-secret local test ===
Work dir: ${workDir}
Campaign id: ${campaignId}
Dispatch body (ephemeral): ${dispatchPayloadPath}
Dispatch body (stable copy): ${stablePayloadPath}
CSV file: ${csvAbs}
Capture URL (analytics_callback_url): ${captureUrl}
Auto-dispatch: ${autoDispatch ? "yes (POST to localhost after /health)" : "no (EVENT_TEST_AUTO_DISPATCH=0)"}

1) SendGrid Event Webhook (HTTP POST, full JSON):
   Path: /api/scalemargin/sendgrid-events
   Full URL: <your public origin>/api/scalemargin/sendgrid-events
   Example: ngrok http ${port}  →  https://<subdomain>.ngrok-free.app/api/scalemargin/sendgrid-events
   Enable signed webhooks in SendGrid; public key must match SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY.

2) Dispatch (real sends — ${recipients.length} recipient(s) with personalization + customArgs):
   ${autoDispatch ? "Runs automatically to http://127.0.0.1:" + port + " once the server is healthy." : "Run manually:"}

curl -sS -X POST ${publicBase}/api/scalemargin/dispatch \\
  -H "Content-Type: application/json" \\
  -H "X-ScaleMargin-Signature: ${dispatchSig}" \\
  --data-binary @${stablePayloadPath}

3) Watch ${csvAbs} — each event’s metadata_json includes campaign_id + organization_id. Rows: dispatched, then delivered/processed, and opens/clicks if you enable them in SendGrid (see below).

4) Opens / clicks: In SendGrid Event Webhook settings, enable **Open** and **Click** (and any other types you want). This script sets EVENT_SENDGRID_INBOUND_EVENTS=* on the child process unless you override it in .env (use default or a comma list to reduce noise).

SendGrid UI "Test Integration" events lack custom_args and are dropped in one summary log line — ignore those.

Set EVENT_TEST_PUBLIC_BASE_URL to your ngrok/tunnel origin so analytics_callback_url is public.
Override recipients: EVENT_TEST_RECIPIENTS="a@x.com,b@y.com"
`);

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: port,
  USER_LOOKUP_CONFIG_PATH: dispatchYamlPath,
  EVENTS_CONFIG_PATH: eventsYamlPath,
  EVENT_TEST_CSV_PATH: csvRel,
  EVENT_TEST_PUBLIC_BASE_URL: publicBase,
  EMAIL_PROVIDER: "sendgrid",
  EVENT_FORWARD_MODE: "sync",
  EVENT_DELIVERY_MODE: "best_effort",
  /** Forward all mapped SendGrid wires (open, click, …) unless overridden in .env. */
  EVENT_SENDGRID_INBOUND_EVENTS: process.env.EVENT_SENDGRID_INBOUND_EVENTS ?? "*",
  UNSUBSCRIBE_URL_BASE: process.env.UNSUBSCRIBE_URL_BASE || "https://example.com/unsub",
  FROM_EMAIL: fromEmail,
};

const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: repoRoot,
  env: childEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (autoDispatch) {
  void (async () => {
    try {
      await waitForServerHealth(portNum, 60_000);
      const res = await postSignedDispatch(portNum, dispatchRaw, dispatchSig);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      console.log(
        `\n[event-test] Auto-posted dispatch (${res.status}) → ${recipients.length} real send(s) with metadata/customArgs. ` +
          `Watch CSV + SendGrid webhook for dispatched + delivered.\n`
      );
    } catch (e) {
      console.error(
        "\n[event-test] Auto-dispatch failed — use the curl above (stable payload file) once the server is listening:\n",
        e
      );
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
    console.log(`[event-test] Kept work dir (EVENT_TEST_KEEP_WORKDIR=1): ${workDir}`);
  }
  process.exit(code ?? 0);
});
