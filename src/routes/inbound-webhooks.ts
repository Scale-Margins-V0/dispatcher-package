import type { Express } from "express";
import express from "express";
import {
  createInboundWebhookHandler,
  getInboundAdapter,
  isProviderEnabled,
} from "../events/index.js";
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import { verifySnsMessage } from "../events/sns-verify.js";

/**
 * Log the raw inbound Gupshup webhook payload (headers + body) for inspection.
 * Always called, independent of whether forwarding to the backend is enabled.
 */
const log = componentLogger(LogComponent.eventsInbound);

/**
 * Header names only, never values.
 *
 * The previous version serialized the whole header map into app_logs, which put
 * the provider's `apikey` and `authorization` in a table the /logs API serves.
 * Knowing *which* headers arrived is the useful part of debugging a webhook;
 * their values are credentials.
 */
function headerNames(req: express.Request): string[] {
  return Object.keys(req.headers).sort();
}

function logGupshupPayload(req: express.Request): void {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf-8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body ?? {});

  log.info(
    { provider: "gupshup", header_names: headerNames(req), body_bytes: rawBody.length },
    "Inbound webhook received"
  );
  log.debug({ provider: "gupshup", body: rawBody }, "Inbound webhook payload");
}

function logFreshchatPayload(req: express.Request): void {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf-8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body ?? {});

  log.info(
    { provider: "freshchat", header_names: headerNames(req), body_bytes: rawBody.length },
    "Inbound webhook received"
  );
  log.debug({ provider: "freshchat", body: rawBody }, "Inbound webhook payload");
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
              log.info({ provider: "ses", host: parsed.hostname }, "Confirming SNS subscription");
              await fetch(subscribeUrl);
              log.info({ provider: "ses", host: parsed.hostname }, "SNS subscription confirmed");
            } else {
              log.warn(
                { provider: "ses", host: parsed.hostname },
                "Rejected SNS SubscribeURL — host is not an AWS domain"
              );
            }
          } catch {
            log.warn({ provider: "ses" }, "Rejected SNS SubscribeURL — not a valid URL");
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
      // Forwarding to the backend event caller is ON by default. Disable (log only)
      // via EVENT_PROVIDERS_DISABLED=gupshup. GUPSHUP_WEBHOOK_SECRET, when set, adds
      // HMAC signature verification on top of forwarding.
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

  let freshchatWebhookHandler:
    | ReturnType<typeof createInboundWebhookHandler>
    | undefined;
  const handleFreshchatWebhook: express.RequestHandler = async (req, res, next) => {
    // Always log the raw payload for inspection.
    logFreshchatPayload(req);
    // Forwarding to the backend event caller is ON by default. Disable (log only)
    // via EVENT_PROVIDERS_DISABLED=freshchat. FRESHCHAT_WEBHOOK_SECRET, when set, adds
    // HMAC/bearer signature verification on top of forwarding.
    if (!isProviderEnabled("freshchat")) {
      res.status(200).json({ received: true, forwarded: false });
      return;
    }
    if (!freshchatWebhookHandler) {
      freshchatWebhookHandler = createInboundWebhookHandler(
        getInboundAdapter("freshchat"),
        true
      );
    }
    await freshchatWebhookHandler(req, res, next);
  };

  app.post(
    "/api/scalemargin/freshchat-events",
    express.text({ type: () => true, limit: "1mb" }),
    handleFreshchatWebhook
  );
  app.post(
    "/api/scalemargin/freshchat-notifications",
    express.text({ type: () => true, limit: "1mb" }),
    handleFreshchatWebhook
  );
}
