/**
 * Public onsite endpoints (browser-facing), per the ScaleMargin contract:
 *   POST /api/onsite/redeem   — bind the visitor nonce, mint a session, return
 *                               the envelope. 404 unknown, 409 nonce conflict,
 *                               410 expired.
 *   GET  /api/onsite/session  — envelope for the active session; 204 if none.
 *   POST /api/onsite/receipt  — record an impression/click/dismiss receipt.
 *
 * When onsite is unconfigured every route 404s. The session cookie is
 * __Host-sm_as (Secure, HttpOnly, SameSite=Lax, Path=/), re-emitted on each
 * successful call to slide the 30m idle window.
 */

import express, { type Express, type Request } from "express";
import { z } from "zod";
import { isOnsiteConfigured } from "./config.js";
import { readSessionCookie, serializeSessionCookie } from "./http.js";
import {
  getOnsiteSession,
  recordOnsiteReceipt,
  redeemActivation,
} from "./service.js";
import { ONSITE_RECEIPT_TYPES } from "./types.js";
import { componentLogger } from "../logging/logger.js";
import { telemetry } from "../telemetry/posthog.js";

const log = componentLogger("onsite");

const redeemBodySchema = z
  .object({
    activation_token: z.string().min(32).max(512),
    visitor_nonce: z.string().min(16).max(128),
    page_key: z.string().min(1).max(120),
    consent_version: z.string().min(1).max(120),
  })
  .strict();

const receiptBodySchema = z
  .object({
    activation_id: z.string().min(1).max(64),
    receipt_id: z.string().min(1).max(191),
    type: z.enum(ONSITE_RECEIPT_TYPES),
    occurred_at: z.string().datetime({ offset: true }),
  })
  .strict();

function pageKeyFromQuery(req: Request): string | null {
  const q = req.query.page_key;
  if (typeof q === "string" && q.trim()) return q.trim();
  return null;
}

export function registerOnsiteRoutes(app: Express): void {
  const router = express.Router();

  // Every onsite route is absent unless the subsystem is configured.
  router.use((_req, res, next) => {
    if (!isOnsiteConfigured()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  });

  router.use(express.json({ limit: "64kb" }));

  router.post("/redeem", async (req, res) => {
    const parsed = redeemBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error:
            "activation_token, visitor_nonce, page_key and consent_version are required",
        });
      return;
    }
    try {
      const result = await redeemActivation(parsed.data);
      if (!result.ok) {
        telemetry.capture("onsite_redeem_rejected", { status: result.status });
        res.status(result.status).json({ error: result.error });
        return;
      }
      telemetry.capture("onsite_redeem_succeeded", {
        placement: result.render.placement,
      });
      res.setHeader(
        "Set-Cookie",
        serializeSessionCookie(result.sessionSecret, result.idleMaxAgeSeconds)
      );
      res.json(result.render);
    } catch (error) {
      telemetry.captureException(error, { component: "onsite_redeem" });
      log.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        "Onsite redeem failed"
      );
      res.status(500).json({ error: "Onsite redeem failed" });
    }
  });

  router.get("/session", async (req, res) => {
    const pageKey = pageKeyFromQuery(req);
    if (!pageKey) {
      res.status(400).json({ error: "page_key is required" });
      return;
    }
    try {
      const cookieValue = readSessionCookie(req);
      const result = await getOnsiteSession(cookieValue, pageKey);
      if (!result.ok) {
        res.status(204).end();
        return;
      }
      // Slide the idle window: re-emit the same cookie value with a fresh Max-Age.
      if (cookieValue)
        res.setHeader("Set-Cookie", serializeSessionCookie(cookieValue));
      res.json(result.render);
    } catch (error) {
      telemetry.captureException(error, { component: "onsite_session" });
      res.status(500).json({ error: "Onsite session lookup failed" });
    }
  });

  router.post("/receipt", async (req, res) => {
    const parsed = receiptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "activation_id, receipt_id, type and occurred_at are required",
        });
      return;
    }
    try {
      const result = await recordOnsiteReceipt(
        readSessionCookie(req),
        parsed.data
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      telemetry.capture("onsite_receipt_recorded", { type: parsed.data.type });
      res.status(201).json({ ok: true, receipt_id: result.receipt_id });
    } catch (error) {
      telemetry.captureException(error, { component: "onsite_receipt" });
      res.status(500).json({ error: "Onsite receipt failed" });
    }
  });

  app.use("/api/onsite", router);
}
