/**
 * ScaleMargin Dispatch Handler — Reference Implementation
 *
 * This server receives campaign dispatch webhooks from ScaleMargin,
 * maps user_ids to PII, personalizes content, sends via your
 * configured provider (AWS SES or SendGrid), and reports analytics back.
 *
 * SETUP:
 *   1. Set environment variables (see .env.example)
 *   2. Replace user-lookup.ts with your actual database queries
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
 */

import express from "express";
import { verifyHmacSignature } from "./middleware/hmac.js";
import { getProvider } from "./providers/index.js";
import { lookupUsers } from "./user-lookup.js";
import { personalize } from "./personalize.js";
import { reportAnalytics, buildBatchPayload } from "./analytics-reporter.js";
import { processImages, type ImageMapping } from "./image-handler.js";
import { rewriteImageUrls } from "./image-rewriter.js";
import type { EmailMessage } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Startup validation — fail fast on missing config
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ["SCALEMARGIN_DISPATCH_SECRET", "SCALEMARGIN_ANALYTICS_SECRET"];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
  console.error("See .env.example for all required variables.");
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@example.com";

if (FROM_EMAIL === "noreply@example.com") {
  console.warn("[WARN] FROM_EMAIL not set — using default noreply@example.com. Emails will likely bounce.");
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Parse body as text first (needed for HMAC verification), then as JSON
// Limit raised to 10MB to accommodate base64-encoded campaign images
app.use("/api/scalemargin/dispatch", express.text({ type: "application/json", limit: "10mb" }));

// Serve locally-stored campaign images (for IMAGE_STORAGE_PROVIDER=local)
if (process.env.IMAGE_STORAGE_PROVIDER === "local") {
  const imgDir = process.env.IMAGE_LOCAL_DIR || "./public/images";
  app.use("/images", express.static(imgDir));
}

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    provider: process.env.EMAIL_PROVIDER || "ses",
    image_storage: process.env.IMAGE_STORAGE_PROVIDER || "none",
  });
});

// ---------------------------------------------------------------------------
// POST /api/scalemargin/dispatch — Campaign Dispatch Handler
// ---------------------------------------------------------------------------

app.post(
  "/api/scalemargin/dispatch",
  verifyHmacSignature,
  async (req, res) => {
    const payload = req.body;

    console.log(
      `[Dispatch] Received campaign ${payload.campaign_id} — ` +
      `${payload.user_ids?.length || 0} recipients, channel: ${payload.channel}`
    );

    // Acknowledge immediately
    res.status(202).json({
      accepted: true,
      message: "Campaign dispatch received",
    });

    // Process asynchronously
    processDispatch(payload).catch((error) => {
      console.error(`[Dispatch] Campaign ${payload.campaign_id} failed:`, error);
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/scalemargin/ses-notifications — SES Delivery Notifications (SNS)
// ---------------------------------------------------------------------------

app.post(
  "/api/scalemargin/ses-notifications",
  express.json(),
  async (req, res) => {
    // Handle SNS subscription confirmation
    if (req.headers["x-amz-sns-message-type"] === "SubscriptionConfirmation") {
      const subscribeUrl = req.body.SubscribeURL;
      // Validate URL belongs to AWS SNS before confirming
      if (subscribeUrl && typeof subscribeUrl === "string") {
        try {
          const parsed = new URL(subscribeUrl);
          if (parsed.hostname.endsWith(".amazonaws.com")) {
            console.log("[SES-SNS] Confirming subscription...");
            await fetch(subscribeUrl);
            console.log("[SES-SNS] Subscription confirmed");
          } else {
            console.warn(`[SES-SNS] Rejected non-AWS SubscribeURL: ${parsed.hostname}`);
          }
        } catch {
          console.warn("[SES-SNS] Invalid SubscribeURL, skipping");
        }
      }
      res.status(200).json({ confirmed: true });
      return;
    }

    // Handle notification
    if (req.headers["x-amz-sns-message-type"] === "Notification") {
      try {
        const message = JSON.parse(req.body.Message);
        console.log(
          `[SES-SNS] Event: ${message.eventType || message.notificationType}`
        );
        // Store/queue for batch reporting — see analytics-reporter.ts
        // In production, you'd aggregate these and batch-report to ScaleMargin
      } catch (error) {
        console.error("[SES-SNS] Failed to parse notification:", error);
      }
    }

    res.status(200).json({ received: true });
  }
);

// ---------------------------------------------------------------------------
// POST /api/scalemargin/sendgrid-events — SendGrid Event Webhook
// ---------------------------------------------------------------------------

app.post(
  "/api/scalemargin/sendgrid-events",
  express.json(),
  async (req, res) => {
    const events = req.body;
    if (!Array.isArray(events)) {
      res.status(400).json({ error: "Expected array of events" });
      return;
    }

    console.log(`[SendGrid-Events] Received ${events.length} events`);

    // Map SendGrid event types to ScaleMargin event types
    // In production, aggregate and batch-report to ScaleMargin
    for (const event of events) {
      const eventType = mapSendGridEvent(event.event);
      if (eventType) {
        console.log(
          `[SendGrid-Events] ${event.email}: ${event.event} → ${eventType}`
        );
      }
    }

    res.status(200).json({ received: true, count: events.length });
  }
);

// ---------------------------------------------------------------------------
// Dispatch Processing (async, after 202 response)
// ---------------------------------------------------------------------------

async function processDispatch(payload: {
  campaign_id: string;
  channel: string;
  user_ids: string[];
  content: {
    subject?: string;
    html_body?: string;
    text_body?: string;
  };
  personalization_fields?: string[];
  images?: Array<{
    placeholder: string;
    url: string;        // Decoded URL for downloading
    raw_url: string;    // URL as it appears in HTML — use for replaceAll
    content_type: string;
    alt_text?: string;
    base64_data?: string;
  }>;
  metadata: {
    organization_id: string;
    analytics_callback_url: string;
  };
}): Promise<void> {
  const {
    campaign_id,
    user_ids,
    content,
    metadata,
  } = payload;

  console.log(
    `[Dispatch] Processing campaign ${campaign_id}: ${user_ids.length} users`
  );

  // 1. Look up users from your database
  const users = await lookupUsers(user_ids);

  // 2. Process images: download from ScaleMargin, upload to our storage
  let imageMappings: ImageMapping[] = [];
  if (payload.images && payload.images.length > 0) {
    imageMappings = await processImages(payload.images, campaign_id);
  }

  // 3. Get the email provider
  const provider = getProvider();

  // 4. Build personalized messages
  // DEV_RECIPIENT_EMAIL: override all recipients to a single test address (local/staging)
  const devRecipient = process.env.DEV_RECIPIENT_EMAIL;
  const messages: Array<{ userId: string; message: EmailMessage }> = [];

  for (const userId of user_ids) {
    const user = users.get(userId);
    if (!user) {
      console.warn(`[Dispatch] User ${userId} not found in database, skipping`);
      continue;
    }

    const subject = content.subject
      ? personalize(content.subject, user)
      : "No Subject";
    let html = content.html_body
      ? personalize(content.html_body, user)
      : "";

    // Rewrite image URLs to customer-hosted versions
    if (imageMappings.length > 0) {
      html = rewriteImageUrls(html, imageMappings);
    }

    const recipientEmail = devRecipient || user.email;

    messages.push({
      userId,
      message: {
        to: recipientEmail,
        from: FROM_EMAIL,
        subject,
        html,
        ...(content.text_body && {
          text: personalize(content.text_body, user),
        }),
      },
    });

    // In dev mode, send only ONE email (to the test recipient), not N duplicates
    if (devRecipient) {
      console.log(
        `[Dispatch] DEV mode — routing all ${user_ids.length} recipients to ${devRecipient}`
      );
      break;
    }
  }

  console.log(
    `[Dispatch] Sending ${messages.length} emails via ${provider.name}`
  );

  // 4. Send all emails
  const sendResults: Array<{
    userId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }> = [];

  for (const { userId, message } of messages) {
    const result = await provider.send(message);
    sendResults.push({
      userId,
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    });
  }

  const sent = sendResults.filter((r) => r.success).length;
  const failed = sendResults.filter((r) => !r.success).length;

  console.log(
    `[Dispatch] Campaign ${campaign_id}: ${sent} sent, ${failed} failed`
  );

  // 5. Report analytics back to ScaleMargin
  const analyticsPayload = buildBatchPayload({
    campaignId: campaign_id,
    organizationId: metadata.organization_id,
    results: sendResults,
  });

  const analyticsResult = await reportAnalytics(
    metadata.analytics_callback_url,
    analyticsPayload
  );

  if (analyticsResult.success) {
    console.log(`[Dispatch] Analytics reported successfully for ${campaign_id}`);
  } else {
    console.error(
      `[Dispatch] Failed to report analytics for ${campaign_id}: ${analyticsResult.error}`
    );
  }
}

// ---------------------------------------------------------------------------
// SendGrid event type mapping
// ---------------------------------------------------------------------------

function mapSendGridEvent(
  sgEvent: string
): string | null {
  const mapping: Record<string, string> = {
    delivered: "delivered",
    open: "opened",
    click: "clicked",
    bounce: "bounced",
    dropped: "bounced",
    spamreport: "complained",
    unsubscribe: "unsubscribed",
  };
  return mapping[sgEvent] || null;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Server] ScaleMargin Dispatch Handler running on port ${PORT}`);
  console.log(`[Server] Email provider: ${process.env.EMAIL_PROVIDER || "ses"}`);
  console.log(`[Server] Dispatch endpoint: POST /api/scalemargin/dispatch`);
  console.log(`[Server] SES notifications: POST /api/scalemargin/ses-notifications`);
  console.log(`[Server] SendGrid events: POST /api/scalemargin/sendgrid-events`);
  console.log(`[Server] Health check: GET /health`);
});

export default app;
