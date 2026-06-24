import type { Express } from "express";
import express from "express";
import {
  createInboundWebhookHandler,
  getInboundAdapter,
  isProviderEnabled,
} from "../events/index.js";
import { warnUnlessVitest, logUnlessVitest } from "../logging.js";
import { verifySnsMessage } from "../events/sns-verify.js";

/**
 * Log the raw inbound Gupshup webhook payload (headers + body) for inspection.
 * Always called, independent of whether forwarding to the backend is enabled.
 */
function logGupshupPayload(req: express.Request): void {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf-8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body ?? {});
  logUnlessVitest(
    "[Gupshup] inbound webhook received:\n" +
      `[Gupshup] headers: ${JSON.stringify(req.headers)}\n` +
      `[Gupshup] body: ${rawBody}`
  );
}

export function registerInboundWebhookRoutes(app: Express): void {
  app.post(
    "/api/scalemargin/ses-notifications",
    express.text({ type: () => true, limit: "1mb" }),
    async (req, res, next) => {
      const rawBody = Buffer.from(
        typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}),
        "utf-8"
      );
      let sns: Record<string, unknown>;
      try {
        sns = JSON.parse(rawBody.toString("utf-8").trimEnd()) as Record<
          string,
          unknown
        >;
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      if (!(await verifySnsMessage(sns))) {
        res.status(401).json({ error: "invalid SNS signature" });
        return;
      }

      if (sns.Type === "SubscriptionConfirmation") {
        const subscribeUrl = sns.SubscribeURL as string | undefined;
        if (subscribeUrl && typeof subscribeUrl === "string") {
          try {
            const parsed = new URL(subscribeUrl);
            if (parsed.hostname.endsWith(".amazonaws.com")) {
              logUnlessVitest("[SES-SNS] Confirming subscription...");
              await fetch(subscribeUrl);
              logUnlessVitest("[SES-SNS] Subscription confirmed");
            } else {
              warnUnlessVitest(
                `[SES-SNS] Rejected non-AWS SubscribeURL: ${parsed.hostname}`
              );
            }
          } catch {
            warnUnlessVitest("[SES-SNS] Invalid SubscribeURL, skipping");
          }
        }
        res.status(200).json({ confirmed: true });
        return;
      }

      const sesHandler = createInboundWebhookHandler(
        getInboundAdapter("ses"),
        isProviderEnabled("ses")
      );
      await sesHandler(req, res, next);
    }
  );

  let sendGridWebhookHandler:
    | ReturnType<typeof createInboundWebhookHandler>
    | undefined;
  app.post(
    "/api/scalemargin/sendgrid-events",
    express.text({ type: () => true, limit: "6mb" }),
    async (req, res, next) => {
      if (!isProviderEnabled("sendgrid")) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (!sendGridWebhookHandler) {
        sendGridWebhookHandler = createInboundWebhookHandler(
          getInboundAdapter("sendgrid"),
          true
        );
      }
      await sendGridWebhookHandler(req, res, next);
    }
  );

  let gupshupWebhookHandler:
    | ReturnType<typeof createInboundWebhookHandler>
    | undefined;
  app.post(
    "/api/scalemargin/gupshup-events",
    express.text({ type: () => true, limit: "1mb" }),
    async (req, res, next) => {
      // Always log the raw payload for inspection.
      logGupshupPayload(req);
      // Forwarding to the backend event caller is OFF by default — log only.
      // Enable later via GUPSHUP_WEBHOOK_SECRET or EVENT_PROVIDERS_ENABLED=gupshup.
      if (!isProviderEnabled("gupshup")) {
        res.status(200).json({ received: true, forwarded: false });
        return;
      }
      if (!gupshupWebhookHandler) {
        gupshupWebhookHandler = createInboundWebhookHandler(
          getInboundAdapter("gupshup"),
          true
        );
      }
      await gupshupWebhookHandler(req, res, next);
    }
  );
}
