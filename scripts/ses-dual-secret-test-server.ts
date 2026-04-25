/**
 * Local “dual secret” smoke test for **AWS SES** (mirror of `event-dual-secret-test-server.ts` for SendGrid):
 * - Provisions a tiny SQLite user DB + dispatch.yaml for recipients in EVENT_TEST_RECIPIENTS
 * - Enables SES inbound events via generated events.yaml (SendGrid off)
 * - Starts the real Express app with EVENT_TEST_CSV_PATH so signed analytics land in CSV
 *
 * Prereqs in .env: SCALEMARGIN_DISPATCH_SECRET, SCALEMARGIN_ANALYTICS_SECRET, FROM_EMAIL (verified in SES),
 * SES_EVENT_CONFIG_SET (must match your SES Configuration Set name),
 * AWS credentials or instance role (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY as usual).
 *
 * AWS: Configuration Set → Event destination → Amazon SNS → subscribe your **HTTPS** endpoint
 * `https://<tunnel>/api/scalemargin/ses-notifications` to that topic (SNS sends SubscriptionConfirmation first;
 * this app auto-confirms when SubscribeURL is on amazonaws.com).
 *
 * Recipients: EVENT_TEST_RECIPIENTS (comma-separated). In SES **sandbox**, each address must be verified in SES.
 *
 * Set EVENT_TEST_PUBLIC_BASE_URL to your ngrok/tunnel origin so analytics_callback_url is public.
 *
 * By default auto-POSTs signed dispatch to localhost after /health. EVENT_TEST_AUTO_DISPATCH=0 to print curl only.
 */

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoDotEnv } from "../src/load-repo-dotenv.js";

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

loadRepoDotEnv(repoRoot);

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
requireEnv("SCALEMARGIN_ANALYTICS_SECRET");
requireEnv("SES_EVENT_CONFIG_SET");
if (!process.env.AWS_REGION?.trim()) {
  console.error("Set AWS_REGION in .env (e.g. us-east-1).");
  process.exit(1);
}

const portNum = parseInt(process.env.PORT || "3100", 10);
const port = String(portNum);
const publicBase = (process.env.EVENT_TEST_PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(
  /\/$/,
  ""
);
const captureUrl = `${publicBase}/api/webhooks/campaign-analytics/capture`;

const workDir = join(tmpdir(), `ses-dual-secret-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const dbPath = join(workDir, "ses-event-test-users.sqlite");
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
  const uid = `ses_event_test_u${idx + 1}`;
  const phone = idx === 0 ? "+1-555-0100" : null;
  ins.run(uid, "Test", `User${idx + 1}`, email, "SES event test co", phone);
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
    expr: "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id"
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
      enabled: true
      configuration_set_env: SES_EVENT_CONFIG_SET
    gupshup:
      enabled: false
`
);

const csvRel = process.env.SES_EVENT_TEST_CSV_PATH || "./data/ses-event-test-capture.csv";
const csvAbs = join(repoRoot, csvRel);
mkdirSync(dirname(csvAbs), { recursive: true });

const fromEmail = requireEnv("FROM_EMAIL");
const userIds = recipients.map((_, i) => `ses_event_test_u${i + 1}`);
const campaignId = `ses_evt_local_${Date.now()}`;
const dispatchBody = {
  campaign_id: campaignId,
  channel: "email",
  user_ids: userIds,
  personalization_fields: ["first_name", "last_name", "email", "company_name", "phone"],
  content: {
    subject: "[ses-event-test] {{company_name}} — Hi {{first_name}}",
    html_body: `<p>Hi {{first_name}} {{last_name}},</p>
<p>This is a <strong>dual-secret SES</strong> test (real SES send + SNS event publishing).</p>
<ul>
  <li>Company: {{company_name}}</li>
  <li>On-file email: {{email}}</li>
  <li>Phone: {{phone}}</li>
</ul>
<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
    text_body:
      "Hi {{first_name}} — SES pipeline test for {{company_name}}. Email: {{email}}. Unsubscribe: {{unsubscribe_url}}",
  },
  metadata: {
    organization_id: "org_ses_event_test",
    analytics_callback_url: captureUrl,
  },
};
const dispatchRaw = JSON.stringify(dispatchBody);
const dispatchSig = "sha256=" + createHmac("sha256", dispatchSecret).update(dispatchRaw).digest("hex");
const dispatchPayloadPath = join(workDir, "dispatch-payload.json");
writeFileSync(dispatchPayloadPath, dispatchRaw, "utf8");

const stablePayloadPath = join(repoRoot, "data", "ses-event-test-dispatch-payload.json");
mkdirSync(dirname(stablePayloadPath), { recursive: true });
writeFileSync(stablePayloadPath, dispatchRaw, "utf8");

const autoDispatch =
  process.env.EVENT_TEST_AUTO_DISPATCH !== "0" &&
  process.env.EVENT_TEST_AUTO_DISPATCH !== "false";

const configSet = process.env.SES_EVENT_CONFIG_SET!;

console.log(`
=== SES dual-secret local test ===
Work dir: ${workDir}
Configuration set (must match SES console): ${configSet}
Campaign id: ${campaignId}
Dispatch body (ephemeral): ${dispatchPayloadPath}
Dispatch body (stable copy): ${stablePayloadPath}
CSV file: ${csvAbs}
Capture URL (analytics_callback_url): ${captureUrl}
Auto-dispatch: ${autoDispatch ? "yes (POST to localhost after /health)" : "no (EVENT_TEST_AUTO_DISPATCH=0)"}

1) Amazon SNS + SES event publishing
   - In SES: Configuration sets → select "${configSet}" → Event destinations → Add destination.
   - Event types: enable at least **Send**, **Delivery**, and (for unsubscribes) **Subscriptions**; add **Opens** / **Clicks** / **Bounces** / **Complaints** as needed.
   - Destination: **Amazon SNS** → create or pick an SNS topic in the same account/region.
   - In SNS: create a **subscription** on that topic, protocol **HTTPS**, endpoint:
       ${publicBase}/api/scalemargin/ses-notifications
     Confirm it (first POST may be SubscriptionConfirmation; this server auto-confirms AWS SubscribeURL).

2) Outbound mail must use that configuration set — this app sets ConfigurationSetName from env SES_EVENT_CONFIG_SET on each send.

3) Dispatch (${recipients.length} recipient(s) with message tags for correlation):
   ${autoDispatch ? "Runs automatically to http://127.0.0.1:" + port + " once the server is healthy." : "Run manually:"}

curl -sS -X POST ${publicBase}/api/scalemargin/dispatch \\
  -H "Content-Type: application/json" \\
  -H "X-ScaleMargin-Signature: ${dispatchSig}" \\
  --data-binary @${stablePayloadPath}

4) Watch ${csvAbs} — rows for dispatched (send path), delivered, Subscription → unsubscribed, etc.

5) Sandbox: verify every recipient in EVENT_TEST_RECIPIENTS in the SES console or use production access.

Full AWS walkthrough: docs/ses.readme.md
Set EVENT_TEST_PUBLIC_BASE_URL to your tunnel origin.
CSV path override: SES_EVENT_TEST_CSV_PATH (default ./data/ses-event-test-capture.csv)
`);

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: port,
  USER_LOOKUP_CONFIG_PATH: dispatchYamlPath,
  EVENTS_CONFIG_PATH: eventsYamlPath,
  EVENT_TEST_CSV_PATH: csvRel,
  EVENT_TEST_PUBLIC_BASE_URL: publicBase,
  EMAIL_PROVIDER: "ses",
  EVENT_FORWARD_MODE: "sync",
  EVENT_DELIVERY_MODE: "best_effort",
  UNSUBSCRIBE_URL_BASE:
    process.env.UNSUBSCRIBE_URL_BASE || `${publicBase}/api/unsubscribe`,
  UNSUBSCRIBE_LINK_ANALYTICS_URL: process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL || captureUrl,
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
        `\n[ses-event-test] Auto-posted dispatch (${res.status}) → ${recipients.length} SES send(s). ` +
          `Watch CSV + SNS → ${publicBase}/api/scalemargin/ses-notifications.\n`
      );
    } catch (e) {
      console.error(
        "\n[ses-event-test] Auto-dispatch failed — use the curl above once the server is listening:\n",
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
    console.log(`[ses-event-test] Kept work dir (EVENT_TEST_KEEP_WORKDIR=1): ${workDir}`);
  }
  process.exit(code ?? 0);
});
