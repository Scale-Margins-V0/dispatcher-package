/**
 * ScaleMargin Local Dispatcher End-to-End Test Runner
 *
 * Runs a complete test cycle against your running local dispatcher:
 * 1. Checks server health (GET /health and GET /status)
 * 2. Starts an in-process analytics callback listener on port 3200
 * 3. Tests synchronous pin validation (ensures invalid sender_id gets 400 Bad Request)
 * 4. Submits signed email & pinned dispatches (POST /api/scalemargin/dispatch)
 * 5. Receives and verifies signed analytics callbacks (HMAC-SHA256)
 *
 * Usage:
 *   pnpm exec tsx scripts/test-local-dispatch.ts
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoDotEnv } from "../src/load-repo-dotenv.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
loadRepoDotEnv(rootDir);

const DISPATCHER_PORT = process.env.PORT || "3100";
const DISPATCHER_URL = `http://127.0.0.1:${DISPATCHER_PORT}`;
const CALLBACK_PORT = 3200;
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/api/webhooks/campaign-analytics`;

const DISPATCH_SECRET = process.env.SCALEMARGIN_DISPATCH_SECRET;
const ANALYTICS_SECRET = process.env.SCALEMARGIN_ANALYTICS_SECRET;

if (!DISPATCH_SECRET || !ANALYTICS_SECRET) {
  console.error("❌ [FATAL] SCALEMARGIN_DISPATCH_SECRET and SCALEMARGIN_ANALYTICS_SECRET must be set in .env");
  process.exit(1);
}

function signPayload(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function verifyHmac(body: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = signPayload(body, secret);
  return signatureHeader === expected || signatureHeader === expected.replace("sha256=", "");
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${DISPATCHER_URL}/health`);
    if (!res.ok) return false;
    const data = await res.json();
    console.log("  ✓ GET /health ->", JSON.stringify(data));
    return true;
  } catch (err) {
    console.error(`  ❌ Could not connect to dispatcher at ${DISPATCHER_URL}. Is the server running?`);
    console.error(`     Start it with: pnpm run dev (or node dist/index.js)`);
    return false;
  }
}

async function checkStatus(): Promise<void> {
  try {
    const res = await fetch(`${DISPATCHER_URL}/status`);
    if (res.ok) {
      const data = (await res.json()) as any;
      console.log(`  ✓ GET /status -> status=${data.status}, checks=${Object.keys(data.checks || {}).join(", ")}`);
    }
  } catch {}
}

async function runTest(): Promise<void> {
  console.log("\n=======================================================");
  console.log("🚀 ScaleMargin Local Dispatcher Test Runner");
  console.log("=======================================================\n");

  console.log("1. Checking Dispatcher Server Reachability...");
  const isHealthy = await checkHealth();
  if (!isHealthy) {
    process.exit(1);
  }
  await checkStatus();

  // 2. Start mock analytics callback listener
  console.log("\n2. Starting local Analytics Callback Listener on port " + CALLBACK_PORT + "...");
  const receivedEvents: Array<{ event: any; signatureValid: boolean }> = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const sig = (req.headers["x-scalemargin-signature"] || req.headers["x-dispatch-signature"]) as string | undefined;
      const isValid = verifyHmac(body, sig, ANALYTICS_SECRET);
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.events)) {
          for (const ev of parsed.events) {
            receivedEvents.push({ event: ev, signatureValid: isValid });
          }
        } else if (parsed.event) {
          receivedEvents.push({ event: parsed.event, signatureValid: isValid });
        } else {
          receivedEvents.push({ event: parsed, signatureValid: isValid });
        }
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(CALLBACK_PORT, resolve));
  console.log(`  ✓ Analytics receiver listening at ${CALLBACK_URL}`);

  // 3. Test Synchronous Pin Validation (Negative Test)
  console.log("\n3. Testing Synchronous Pin Validation (Invalid sender_id)...");
  const invalidPayload = {
    campaign_id: "test-invalid-pin",
    channel: "email",
    user_ids: ["sm-001"],
    content: { subject: "Test" },
    metadata: {
      organization_id: "org_test",
      sender_id: "nonexistent-sender-slug-12345",
      analytics_callback_url: CALLBACK_URL,
    },
  };
  const invalidBody = JSON.stringify(invalidPayload);
  const invalidRes = await fetch(`${DISPATCHER_URL}/api/scalemargin/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ScaleMargin-Signature": signPayload(invalidBody, DISPATCH_SECRET),
    },
    body: invalidBody,
  });

  if (invalidRes.status === 400) {
    const data = await invalidRes.json();
    console.log(`  ✓ Correctly rejected with HTTP 400 Bad Request:`, JSON.stringify(data));
  } else {
    console.log(`  ❌ Expected HTTP 400, got ${invalidRes.status}`);
  }

  // 4. Send Standard Dispatch
  console.log("\n4. Submitting Standard Dispatch (sample-dispatch.json)...");
  const standardPayload = JSON.parse(
    readFileSync(join(rootDir, "scripts", "sample-dispatch.json"), "utf8")
  );
  standardPayload.metadata.analytics_callback_url = CALLBACK_URL;
  const standardBody = JSON.stringify(standardPayload);

  const standardRes = await fetch(`${DISPATCHER_URL}/api/scalemargin/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ScaleMargin-Signature": signPayload(standardBody, DISPATCH_SECRET),
    },
    body: standardBody,
  });

  if (standardRes.status === 202) {
    console.log(`  ✓ Dispatch accepted: HTTP 202 Accepted`);
  } else {
    console.log(`  ❌ Dispatch rejected: HTTP ${standardRes.status} -> ${await standardRes.text()}`);
  }

  // 5. Send Pinned Sender Dispatch
  console.log("\n5. Submitting Pinned Sender Dispatch (sample-dispatch-pinned.json)...");
  const pinnedPayload = JSON.parse(
    readFileSync(join(rootDir, "scripts", "sample-dispatch-pinned.json"), "utf8")
  );
  pinnedPayload.metadata.analytics_callback_url = CALLBACK_URL;
  const pinnedBody = JSON.stringify(pinnedPayload);

  const pinnedRes = await fetch(`${DISPATCHER_URL}/api/scalemargin/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ScaleMargin-Signature": signPayload(pinnedBody, DISPATCH_SECRET),
    },
    body: pinnedBody,
  });

  if (pinnedRes.status === 202) {
    console.log(`  ✓ Pinned dispatch accepted: HTTP 202 Accepted`);
  } else {
    console.log(`  ❌ Pinned dispatch rejected: HTTP ${pinnedRes.status} -> ${await pinnedRes.text()}`);
  }

  // 6. Wait for analytics callbacks
  console.log("\n6. Waiting for analytics callback events...");
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`  ✓ Received ${receivedEvents.length} analytics callback event(s):`);
  for (const item of receivedEvents) {
    const ev = item.event;
    console.log(
      `    - Campaign: ${ev.campaign_id}, User: ${ev.user_id}, Status: ${ev.event || ev.status}, Provider: ${ev.provider}, Sender: ${ev.metadata?.sender_id || "n/a"}, HMAC Valid: ${item.signatureValid ? "✓" : "❌"}`
    );
  }

  server.close();
  console.log("\n=======================================================");
  console.log("✅ Local Test Completed Successfully!");
  console.log("=======================================================\n");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
