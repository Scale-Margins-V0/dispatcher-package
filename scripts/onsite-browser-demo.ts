/**
 * Colleague-ready browser demo for the onsite activation loop.
 *
 * One process:
 *   - in-memory dispatcher DB + /api/onsite/* routes
 *   - same-origin /_sm facade (what a client website would proxy)
 *   - mock ScaleMargin public config + event ingest
 *   - control room + customer landing page + SDK assets
 *
 * Run from dispatcher-package-internal:
 *   pnpm exec tsx scripts/onsite-browser-demo.ts
 *
 * Then open http://localhost:5198
 */

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createTestDb, destroyTestDb } from "../src/db/test-utils.js";
import { prepareOnsite } from "../src/onsite/issue.js";
import { registerOnsiteRoutes } from "../src/onsite/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SDK_DIST = join(
  ROOT,
  "..",
  "scalemargin",
  "packages",
  "webpage",
  "dist"
);

const PORT = Number(process.env.ONSITE_DEMO_PORT ?? 5198);
// Default HTTP so colleagues can open without a self-signed cert warning.
// Set ONSITE_DEMO_HTTPS=1 for Secure __Host- cookie parity with production.
const USE_HTTPS = process.env.ONSITE_DEMO_HTTPS === "1";
const SITE_KEY = `onsite_pk_${"a".repeat(32)}`;
const ORG_ID = "org_demo_scalemargin";
const SITE_ID = "site_demo_offer";

process.env.ONSITE_STATE_ENCRYPTION_KEY =
  process.env.ONSITE_STATE_ENCRYPTION_KEY ??
  "onsite-browser-demo-encryption-key-32b";

type EventRow = {
  at: string;
  kind: string;
  detail: string;
};

const events: EventRow[] = [];
const maxEvents = 80;

function pushEvent(kind: string, detail: string) {
  events.unshift({ at: new Date().toISOString(), kind, detail });
  if (events.length > maxEvents) events.length = maxEvents;
}

function requireSdkAssets() {
  for (const name of ["loader.js", "runtime.js", "runtime.css"]) {
    const path = join(SDK_DIST, name);
    if (!existsSync(path)) {
      throw new Error(
        `Missing SDK asset ${path}. Run: cd ../scalemargin/packages/webpage && bun run build`
      );
    }
  }
}

async function makeTlsOptions(): Promise<{ key: Buffer; cert: Buffer }> {
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync(join(os.tmpdir(), "onsite-demo-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function controlPageHtml(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ScaleMargin Onsite — Demo Control Room</title>
  <style>
    :root {
      --ink: #12202e;
      --paper: #f4efe6;
      --accent: #0f766e;
      --accent-2: #b45309;
      --line: #d6cfc3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 10%, #fff8ea 0%, transparent 42%),
        radial-gradient(circle at 88% 0%, #d9efe9 0%, transparent 36%),
        linear-gradient(160deg, #f7f2ea, #ebe4d8 55%, #e4eee9);
    }
    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    .brand {
      font-size: clamp(2.4rem, 6vw, 4.2rem);
      line-height: 0.95;
      letter-spacing: -0.03em;
      margin: 0 0 12px;
    }
    .lede {
      font-size: 1.15rem;
      max-width: 40rem;
      line-height: 1.5;
      margin: 0 0 28px;
      opacity: 0.9;
    }
    .steps {
      display: grid;
      gap: 10px;
      margin: 0 0 28px;
      padding: 0;
      list-style: none;
      counter-reset: step;
    }
    .steps li {
      position: relative;
      padding: 14px 16px 14px 52px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.55);
    }
    .steps li::before {
      counter-increment: step;
      content: counter(step);
      position: absolute;
      left: 14px;
      top: 14px;
      width: 26px;
      height: 26px;
      border-radius: 999px;
      background: var(--ink);
      color: #fff;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 12px;
      font-weight: 700;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 28px;
    }
    button, a.button {
      appearance: none;
      border: 0;
      cursor: pointer;
      text-decoration: none;
      font: inherit;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-weight: 700;
      font-size: 15px;
      padding: 14px 18px;
      background: var(--accent);
      color: #fff;
    }
    button.secondary, a.secondary {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--ink);
    }
    .panel {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.72);
      padding: 18px;
    }
    .panel h2 {
      margin: 0 0 10px;
      font-size: 1.1rem;
      font-family: ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #linkBox {
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
      min-height: 3.2em;
      padding: 12px;
      background: #12202e;
      color: #d7f6ef;
      margin-bottom: 12px;
    }
    #log {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 320px;
      overflow: auto;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
    }
    #log li {
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }
    #log .kind { color: var(--accent-2); font-weight: 700; }
    .hint { font-size: 0.95rem; opacity: 0.8; margin-top: 18px; }
  </style>
</head>
<body>
  <main>
    <p style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px;opacity:.7">ScaleMargin · live browser demo</p>
    <h1 class="brand">Onsite activation loop</h1>
    <p class="lede">
      Simulate a drip email click: ScaleMargin issues a signed activation,
      the customer site redeems it through the dispatcher façade, and the
      Web SDK renders a personalized popup in this browser.
    </p>
    <ol class="steps">
      <li>Issue a one-time activation token (stands in for email/WhatsApp dispatch).</li>
      <li>Open the landing URL — fragment carries <code>#sm_t</code>, never sent to the server.</li>
      <li>Consent → redeem via <code>/_sm</code> → Shadow DOM popup → impression receipt.</li>
    </ol>
    <div class="actions">
      <button id="issue" type="button">1. Issue campaign link</button>
      <a class="button secondary" id="openLink" href="#" target="_blank" rel="noopener">2. Open as customer</a>
      <button class="secondary" id="refresh" type="button">Refresh event log</button>
    </div>
    <div class="panel" style="margin-bottom:18px">
      <h2>Issued customer URL</h2>
      <div id="linkBox">Click “Issue campaign link” to mint a fresh #sm_t token.</div>
    </div>
    <div class="panel">
      <h2>Live event log</h2>
      <ul id="log"><li><span class="kind">idle</span><span>Waiting for demo actions…</span></li></ul>
    </div>
    <p class="hint">Origin: ${origin} · Site key: ${SITE_KEY}</p>
  </main>
  <script>
    const linkBox = document.getElementById("linkBox");
    const openLink = document.getElementById("openLink");
    const logEl = document.getElementById("log");

    async function refreshLog() {
      const res = await fetch("/demo/events");
      const rows = await res.json();
      if (!rows.length) return;
      logEl.innerHTML = rows.map((row) =>
        \`<li><span class="kind">\${row.kind}</span><span>\${row.detail}<br><small>\${row.at}</small></span></li>\`
      ).join("");
    }

    document.getElementById("issue").addEventListener("click", async () => {
      const res = await fetch("/demo/issue", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        linkBox.textContent = data.error || "Issue failed";
        return;
      }
      linkBox.textContent = data.url;
      openLink.href = data.url;
      await refreshLog();
    });
    document.getElementById("refresh").addEventListener("click", () => refreshLog());
    setInterval(refreshLog, 2000);
  </script>
</body>
</html>`;
}

function offerPageHtml(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acme Bank — Complete your KYC offer</title>
  <style>
    :root { --ink:#102033; --sand:#f6f1e8; --teal:#0f766e; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        linear-gradient(135deg, rgba(15,118,110,.12), transparent 42%),
        linear-gradient(180deg, #f8f4ec, #ebe4d7);
      min-height: 100vh;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 28px;
      border-bottom: 1px solid rgba(16,32,51,.12);
      background: rgba(255,255,255,.55);
      backdrop-filter: blur(8px);
    }
    .logo { font-weight: 800; letter-spacing: -0.03em; font-size: 1.2rem; }
    main { max-width: 760px; margin: 0 auto; padding: 56px 24px 120px; }
    h1 { font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.05; letter-spacing: -0.04em; margin: 0 0 14px; }
    p { font-size: 1.05rem; line-height: 1.55; max-width: 36rem; }
    .card {
      margin-top: 28px;
      padding: 22px;
      background: rgba(255,255,255,.7);
      border: 1px solid rgba(16,32,51,.1);
    }
    .status {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--teal);
    }
    #consentBar {
      position: fixed; left: 16px; right: 16px; bottom: 16px;
      display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: #102033; color: #fff;
      z-index: 10;
    }
    #consentBar button {
      border: 0; cursor: pointer; font: inherit; font-weight: 700;
      padding: 10px 14px; background: #14b8a6; color: #06241f;
    }
    #consentBar button.ghost { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.35); }
  </style>
  <script>
    window.sm_onsite = window.sm_onsite || function () {
      (window.sm_onsite.q = window.sm_onsite.q || []).push(arguments);
    };
  </script>
  <script
    async
    src="/sdk/loader.js"
    data-api-base-url="${origin}"
    data-runtime-url="/sdk/runtime.js"
    data-style-url="/sdk/runtime.css"
    data-site-key="${SITE_KEY}"
    data-redeem-base="/_sm"
    data-consent="pending"
  ></script>
</head>
<body>
  <header>
    <div class="logo">Acme Bank</div>
    <div class="status" id="sdkStatus">SDK loading…</div>
  </header>
  <main>
    <h1>Finish KYC and unlock your rate.</h1>
    <p>
      You arrived from a ScaleMargin drip. After consent, the onsite SDK
      redeems the one-time token through the client <code>/_sm</code> façade
      and shows a personalized offer — private fields resolved only in the
      dispatcher.
    </p>
    <div class="card">
      <strong>Demo page key:</strong> <code>kyc_offer</code><br />
      <strong>Expected popup:</strong> corner placement with Ada’s frozen offer.
    </div>
  </main>
  <div id="consentBar">
    <span>This site uses ScaleMargin onsite messaging. Grant consent to continue the demo.</span>
    <span>
      <button type="button" id="accept">Accept analytics + personalization</button>
      <button class="ghost" type="button" id="reject">Reject</button>
    </span>
  </div>
  <script>
    const status = document.getElementById("sdkStatus");
    const bar = document.getElementById("consentBar");
    document.getElementById("accept").addEventListener("click", () => {
      window.sm_onsite("consent", {
        analytics: true,
        personalization: true,
        version: "demo-cmp-v1",
      });
      status.textContent = "Consent granted — redeeming…";
      bar.remove();
      fetch("/demo/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "consent",
          detail: "Visitor granted analytics + personalization",
        }),
      });
    });
    document.getElementById("reject").addEventListener("click", () => {
      window.sm_onsite("consent", {
        analytics: false,
        personalization: false,
        version: "demo-cmp-v1",
      });
      status.textContent = "Consent rejected";
      bar.remove();
    });
    setTimeout(() => {
      status.textContent = "SDK ready — waiting for consent";
    }, 700);
  </script>
</body>
</html>`;
}

async function issueDemoLink(origin: string): Promise<string> {
  const decisionId = `osd_${randomBytes(8).toString("hex")}`;
  const analyticsToken = `osa_${randomBytes(32).toString("base64url")}`;
  const issuer = await prepareOnsite({
    campaign_id: "cmp_demo_kyc_drip",
    dispatch_ids: { usr_ada: `touch_${randomBytes(4).toString("hex")}` },
    content: {
      subject: "Complete KYC",
      html_body: '<a href="{{onsite_url}}">Open your offer</a>',
    },
    metadata: {
      organization_id: ORG_ID,
      onsite: {
        schema_version: 1,
        site_key: SITE_KEY,
        landing_url: `${origin}/offer`,
        template_id: "tpl_kyc_corner",
        template_revision: 3,
        placement: "corner",
        offer_fields: ["first_name", "offer_price"],
        attribution: {
          source: "scalemargin",
          medium: "email",
          campaign: "kyc_drip",
          content: "touch_demo",
        },
        template: {
          content: {
            eyebrow: "Limited offer",
            title: "Hi {{first_name}}, your KYC bonus is ready",
            body: "Finish verification today and keep your personalized rate.",
            offer_text: "{{offer_price}} cashback when you complete KYC",
            cta: { label: "Claim offer", url: "/deals" },
            dismiss_label: "Dismiss",
          },
          theme: {
            preset: "light",
            accent: "#0f766e",
            surface: "#ffffff",
            text: "#12202e",
            radius: "md",
          },
        },
        assignments: {
          usr_ada: {
            decision_id: decisionId,
            offer_ref: "kyc-complete",
            offer_version: "2026-07",
            analytics_token: analyticsToken,
            starts_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        },
      },
    },
  });

  if (!issuer) {
    throw new Error("prepareOnsite returned null — check encryption key");
  }

  const url = await issuer.issue({
    userId: "usr_ada",
    channel: "email",
    now: new Date(),
    personalizeString: (input) =>
      input
        .replaceAll("{{first_name}}", "Ada")
        .replaceAll("{{offer_price}}", "₹2,500"),
  });
  await issuer.flush();
  if (!url) throw new Error("issuer returned no URL");
  return url;
}

async function main() {
  requireSdkAssets();
  const dbx = await createTestDb();

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  registerOnsiteRoutes(app, "/api/onsite");
  // Same-origin client façade path used by the Web SDK in production.
  registerOnsiteRoutes(app, "/_sm");

  // Mock ScaleMargin public config (SDK refuses to redeem without this).
  app.get("/onsite/v1/sites/:siteKey/config", (req, res) => {
    if (req.params.siteKey !== SITE_KEY) {
      res.status(404).json({ error: "unknown site" });
      return;
    }
    res.json({
      publicKey: SITE_KEY,
      orgId: ORG_ID,
      siteId: SITE_ID,
      version: 3,
      enabled: true,
      consentMode: "required",
      campaigns: [],
      pageRules: [
        { key: "kyc_offer", path: "/offer", operator: "equals" },
        { key: "home", path: "/", operator: "equals" },
      ],
    });
    pushEvent("config", "SDK fetched public site config");
  });

  app.options("/onsite/v1/events", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.sendStatus(204);
  });

  app.post("/onsite/v1/events", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const batch = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const event of batch) {
      pushEvent(
        "analytics",
        `${event?.name ?? event?.event_name ?? "event"} · page_key=${event?.page_key ?? "?"}`
      );
    }
    res.status(202).json({ accepted: batch.length });
  });

  app.use("/sdk", express.static(SDK_DIST, { fallthrough: false, maxAge: 0 }));

  app.get("/", (_req, res) => {
    const origin = `${_req.protocol}://${_req.get("host")}`;
    res.type("html").send(controlPageHtml(origin));
  });

  app.get("/offer", (_req, res) => {
    const origin = `${_req.protocol}://${_req.get("host")}`;
    res.type("html").send(offerPageHtml(origin));
  });

  app.get("/deals", (_req, res) => {
    res.type("html").send(`<!doctype html><html><body style="font-family:system-ui;padding:48px">
      <h1>Deal claimed</h1>
      <p>CTA from the onsite popup landed here.</p>
      <p><a href="/">Back to control room</a></p>
    </body></html>`);
  });

  app.get("/demo/events", (_req, res) => {
    res.json(events);
  });

  app.post("/demo/log", (req, res) => {
    const kind = String(req.body?.kind ?? "note");
    const detail = String(req.body?.detail ?? "");
    pushEvent(kind, detail);
    res.json({ ok: true });
  });

  app.post("/demo/issue", async (req, res) => {
    try {
      const origin = `${req.protocol}://${req.get("host")}`;
      const url = await issueDemoLink(origin);
      pushEvent("issue", `Minted activation link for Ada`);
      res.json({ url });
    } catch (error) {
      const message = error instanceof Error ? error.message : "issue failed";
      pushEvent("error", message);
      res.status(500).json({ error: message });
    }
  });

  const onListen = () => {
    const scheme = USE_HTTPS ? "https" : "http";
    const url = `${scheme}://localhost:${PORT}`;
    console.log("");
    console.log("ScaleMargin onsite browser demo");
    console.log("================================");
    console.log(`Control room:  ${url}`);
    console.log(`Customer page: ${url}/offer`);
    console.log("");
    console.log("Demo script:");
    console.log("  1. Open the control room");
    console.log("  2. Click “Issue campaign link”");
    console.log("  3. Click “Open as customer”");
    console.log("  4. Accept consent → personalized popup appears");
    console.log("");
    if (USE_HTTPS) {
      console.log("Note: self-signed cert — click through the browser warning once.");
    }
    pushEvent("boot", `Demo server listening on ${url}`);
  };

  if (USE_HTTPS) {
    const tls = await makeTlsOptions();
    createHttpsServer(tls, app).listen(PORT, "127.0.0.1", onListen);
  } else {
    createHttpServer(app).listen(PORT, "127.0.0.1", onListen);
  }

  const shutdown = () => {
    destroyTestDb(dbx);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
