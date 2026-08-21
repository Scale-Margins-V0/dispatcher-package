/**
 * HMAC Signature Verification Middleware
 *
 * Verifies the X-ScaleMargin-Signature header on incoming dispatch requests.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { componentLogger } from "../logging/logger.js";

const log = componentLogger("middleware.hmac");

export function verifyHmacSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const dispatchSecret = process.env.SCALEMARGIN_DISPATCH_SECRET || "";
  const signature =
    (req.headers["x-scalemargin-signature"] || req.headers["x-dispatch-signature"]) as string | undefined;
  if (!signature || !signature.startsWith("sha256=")) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (!dispatchSecret) {
    log.error("[HMAC] SCALEMARGIN_DISPATCH_SECRET not configured");
    res.status(500).json({ error: "Server misconfigured: missing dispatch secret" });
    return;
  }

  // req.body should already be the raw string from express.text() middleware
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const provided = signature.slice("sha256=".length);

  const timestamp = (req.headers["x-dispatch-timestamp"] || req.headers["x-scalemargin-timestamp"]) as string | undefined;

  const expectedStandard = createHmac("sha256", dispatchSecret)
    .update(rawBody)
    .digest("hex");

  let isValid =
    expectedStandard.length === provided.length &&
    timingSafeEqual(Buffer.from(expectedStandard), Buffer.from(provided));

  if (!isValid && timestamp) {
    const expectedWithTimestamp = createHmac("sha256", dispatchSecret)
      .update(`${timestamp}.${rawBody}`, "utf8")
      .digest("hex");
    isValid =
      expectedWithTimestamp.length === provided.length &&
      timingSafeEqual(Buffer.from(expectedWithTimestamp), Buffer.from(provided));
  }

  if (!isValid) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Parse body if it was received as text
  if (typeof req.body === "string") {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
  }

  next();
}
