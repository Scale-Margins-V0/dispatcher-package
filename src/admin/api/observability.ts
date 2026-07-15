/**
 * Admin settings for observability: the GET /logs bearer token and the log
 * webhook. Mounted under requireSession in registerAdminRoutes.
 */

import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { generateLogsToken, getLogsTokenStatus } from "../../logging/logs-token.js";
import {
  getLogWebhookConfig,
  saveLogWebhookConfig,
  type LogWebhookConfig,
} from "../../logging/webhook-config.js";
import { deliverLogWebhook, payloadFromLine } from "../../logging/webhook-sink.js";
import { asyncHandler } from "./variables.js";

/** Secret is redacted to this in responses; sending it back means "keep existing". */
const SECRET_MASK = "••••••••";

const webhookSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(2000),
  min_level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  secret: z.string().max(200).optional(),
});

function serializeWebhook(cfg: LogWebhookConfig) {
  return {
    enabled: cfg.enabled,
    url: cfg.url,
    min_level: cfg.min_level,
    has_secret: Boolean(cfg.secret),
    secret: cfg.secret ? SECRET_MASK : "",
  };
}

export const registerObservabilityRoutes = (app: Express): void => {
  const json = express.json({ limit: "16kb" });

  // --- GET /logs bearer token ---
  app.get(
    "/admin/api/settings/logs-token",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await getLogsTokenStatus());
    })
  );
  app.post(
    "/admin/api/settings/logs-token",
    json,
    asyncHandler(async (_req: Request, res: Response) => {
      const token = await generateLogsToken();
      res.status(201).json({ token });
    })
  );

  // --- Log webhook ---
  app.get(
    "/admin/api/settings/log-webhook",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ webhook: serializeWebhook(getLogWebhookConfig()) });
    })
  );

  app.put(
    "/admin/api/settings/log-webhook",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = webhookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid webhook config",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
        return;
      }
      if (parsed.data.enabled && !/^https?:\/\//i.test(parsed.data.url)) {
        res.status(400).json({ error: "url must start with http(s):// when enabled" });
        return;
      }
      const existing = getLogWebhookConfig();
      // Masked secret ⇒ keep the stored one; empty string ⇒ clear it.
      const secret =
        parsed.data.secret === SECRET_MASK
          ? existing.secret
          : parsed.data.secret
            ? parsed.data.secret
            : undefined;
      const next: LogWebhookConfig = {
        enabled: parsed.data.enabled,
        url: parsed.data.url.trim(),
        min_level: parsed.data.min_level,
        ...(secret ? { secret } : {}),
      };
      await saveLogWebhookConfig(next);
      res.json({ webhook: serializeWebhook(next) });
    })
  );

  app.post(
    "/admin/api/settings/log-webhook/test",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = webhookSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: "Invalid webhook config" });
        return;
      }
      const existing = getLogWebhookConfig();
      const secret =
        parsed.data.secret === SECRET_MASK ? existing.secret : parsed.data.secret || undefined;
      const cfg: LogWebhookConfig = {
        enabled: true,
        url: parsed.data.url.trim(),
        min_level: parsed.data.min_level,
        ...(secret ? { secret } : {}),
      };
      const payload = payloadFromLine({
        level: 40,
        time: Date.now(),
        component: "logging.webhook",
        msg: "ScaleMargin dispatcher — log webhook test event",
      });
      res.json(await deliverLogWebhook(cfg, payload));
    })
  );
};
