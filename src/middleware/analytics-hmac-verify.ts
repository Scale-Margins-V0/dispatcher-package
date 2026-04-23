/**
 * Verifies HMAC on inbound analytics-style webhooks (same algorithm as outbound
 * `postAnalyticsWithRetry` in src/events/forwarder.ts).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function verifyAnalyticsHmacSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
  const signature = req.headers["x-scalemargin-signature"] as string;
  if (!signature || !signature.startsWith("sha256=")) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (!secret) {
    console.error("[AnalyticsHMAC] SCALEMARGIN_ANALYTICS_SECRET not configured");
    res.status(500).json({ error: "Server misconfigured: missing analytics secret" });
    return;
  }

  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.slice("sha256=".length);

  if (expected.length !== provided.length) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (typeof req.body === "string") {
    try {
      req.body = JSON.parse(req.body) as unknown;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
  }

  next();
}
