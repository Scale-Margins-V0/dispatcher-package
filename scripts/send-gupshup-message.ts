/**
 * Manual end-to-end Gupshup GatewayAPI send.
 *
 * Reads credentials + endpoint from `.env` (or the shell environment) via
 * `resolveGupshupConfig()`, builds a real `GupshupWhatsAppMessage`, prints the
 * exact POST body that goes on the wire (password masked), then sends it through
 * the same `sendGupshupWhatsApp()` code path production uses.
 *
 * Prereqs in `.env` (repo root):
 *   GUPSHUP_USER_ID=2000xxxxxx
 *   GUPSHUP_PASSWORD=********
 *   # optional — defaults to https://mediaapi.smsgupshup.com/GatewayAPI/rest
 *   GUPSHUP_MEDIA_API_URL=...
 *
 * Recipient / content come from CLI flags first, then env fallbacks:
 *   --to=919815235665            | GUPSHUP_EVENT_TEST_RECIPIENTS (first entry)
 *   --caption="Dear Vivek,\n\n…" | GUPSHUP_EVENT_TEST_CAPTION
 *   --media=https://…/image.png  | GUPSHUP_EVENT_TEST_MEDIA_URL  (omit → text send)
 *   --type=IMAGE                 | GUPSHUP_MEDIA_MSG_TYPE         (IMAGE/DOCUMENT/VIDEO)
 *
 * Usage (from dispatcher-package/):
 *   # preview only, no network call:
 *   pnpm tsx scripts/send-gupshup-message.ts --to=9198... --caption="Hi\n\nthere" --dry-run
 *
 *   # actually send a text message:
 *   pnpm tsx scripts/send-gupshup-message.ts --to=9198... --caption="Hi\n\nthere"
 *
 *   # actually send a media (image) message:
 *   pnpm tsx scripts/send-gupshup-message.ts --to=9198... --media=https://…/a.png --caption="Hi"
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoDotEnv } from "../src/load-repo-dotenv.js";
import {
  normalizePlainCaption,
  normalizePlainMediaUrl,
  previewGupshupSendRequest,
  resolveDevTestRecipient,
  resolveGupshupConfig,
  sendGupshupWhatsApp,
  stripPhonePlus,
  type GupshupWhatsAppMessage,
} from "../src/providers/gupshup-whatsapp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
loadRepoDotEnv(repoRoot);

/** Parse `--key=value` / `--flag` CLI args into a map. */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function maskPassword(wireBody: string): string {
  return wireBody.replace(/password=[^&]*/i, "password=%2A%2A%2A%2A");
}

/**
 * Default caption — real newlines (each line break goes out as "%0A").
 * Override with --caption="..." or GUPSHUP_EVENT_TEST_CAPTION if needed.
 */
const DEFAULT_CAPTION = `Dear Vivek, 

The  Financial Service Ltd.  is now open for subscription on GoldenPi.

Don’t miss this opportunity to explore fixed income options offering:

 📈 Returns of up to 10% p.a.
🚀 Multiple tenure choices to suit your investment needs.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  const config = resolveGupshupConfig();
  if (!config) {
    console.error(
      "✗ No Gupshup credentials found. Set GUPSHUP_USER_ID + GUPSHUP_PASSWORD " +
        "(or GUPSHUP_API_KEY) in .env or the environment."
    );
    process.exit(1);
  }
  if (!config.userId || !config.password) {
    console.error(
      "✗ GatewayAPI send needs GUPSHUP_USER_ID and GUPSHUP_PASSWORD " +
        `(current mode: ${config.mode}).`
    );
    process.exit(1);
  }

  const to =
    (typeof args.to === "string" && stripPhonePlus(args.to)) ||
    resolveDevTestRecipient();
  if (!to) {
    console.error(
      "✗ No recipient. Pass --to=9198... or set GUPSHUP_EVENT_TEST_RECIPIENTS in .env."
    );
    process.exit(1);
  }

  // The hardcoded DEFAULT_CAPTION wins over env; only an explicit --caption overrides it.
  const rawCaption =
    (typeof args.caption === "string" && args.caption) || DEFAULT_CAPTION;
  if (!rawCaption.trim()) {
    console.error(
      "✗ No caption/message text. Pass --caption=\"...\" or set GUPSHUP_EVENT_TEST_CAPTION."
    );
    process.exit(1);
  }
  // Same normalization production uses: escaped "\n" → real newline (→ %0A).
  const caption = normalizePlainCaption(rawCaption);

  const rawMedia =
    (typeof args.media === "string" && args.media) ||
    process.env.GUPSHUP_EVENT_TEST_MEDIA_URL ||
    "";
  const mediaUrl = rawMedia.trim()
    ? normalizePlainMediaUrl(rawMedia)
    : undefined;
  const mediaMsgType =
    (typeof args.type === "string" && args.type) || undefined;

  const message: GupshupWhatsAppMessage = {
    to,
    caption,
    ...(mediaUrl ? { mediaUrl, mediaMsgType } : {}),
  };

  const preview = previewGupshupSendRequest(message, config);
  console.log("──────────────────────────────────────────────");
  console.log(`mode        : ${preview.mode}`);
  console.log(`httpMethod  : ${preview.httpMethod}`);
  console.log(`url         : ${preview.url}`);
  console.log(`recipient   : ${to}`);
  console.log(`caption     : ${JSON.stringify(caption)}`);
  if (mediaUrl) console.log(`media_url   : ${mediaUrl}`);
  console.log("wire body   :");
  console.log(`  ${maskPassword(preview.wireBody)}`);
  console.log("──────────────────────────────────────────────");

  if (dryRun) {
    console.log("✓ --dry-run set: not sending. Remove the flag to send for real.");
    return;
  }

  console.log("→ Sending via Gupshup GatewayAPI…");
  const result = await sendGupshupWhatsApp(message, config);
  if (result.success) {
    console.log("✓ Sent.", JSON.stringify(result, null, 2));
  } else {
    console.error("✗ Send failed:", JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ Unexpected error:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
