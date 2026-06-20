/**
 * Send a signed dispatch to the local handler for manual testing.
 *
 * Usage:
 *   pnpm exec tsx scripts/send-dispatch.ts [path/to/payload.json] [url]
 *
 * Defaults:
 *   payload -> scripts/sample-dispatch.json
 *   url     -> http://localhost:${PORT||3100}/api/scalemargin/dispatch
 *
 * Loads repo-root .env so SCALEMARGIN_DISPATCH_SECRET matches the server.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRepoDotEnv } from "../src/load-repo-dotenv.js";

loadRepoDotEnv(join(dirname(fileURLToPath(import.meta.url)), ".."));

const payloadPath = resolve(
  process.argv[2] ??
    join(dirname(fileURLToPath(import.meta.url)), "sample-dispatch.json")
);
const port = process.env.PORT || "3100";
const url =
  process.argv[3] ?? `http://localhost:${port}/api/scalemargin/dispatch`;

const secret = process.env.SCALEMARGIN_DISPATCH_SECRET;
if (!secret) {
  console.error("[FATAL] SCALEMARGIN_DISPATCH_SECRET is not set");
  process.exit(1);
}

// Read the file and re-serialize so the bytes we sign === the bytes we send.
const rawBody = JSON.stringify(JSON.parse(readFileSync(payloadPath, "utf8")));
const signature =
  "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

console.log(`POST ${url}`);
console.log(`payload: ${payloadPath}`);

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-ScaleMargin-Signature": signature,
  },
  body: rawBody,
});

console.log(`HTTP ${res.status}`);
console.log(await res.text());
