/**
 * HMAC Signature Verification Middleware
 *
 * Verifies the X-ScaleMargin-Signature header on incoming dispatch requests.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const DISPATCH_SECRET = process.env.SCALEMARGIN_DISPATCH_SECRET || "";

export function verifyHmacSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signature = req.headers["x-scalemargin-signature"] as string;
  if (!signature || !signature.startsWith("sha256=")) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (!DISPATCH_SECRET) {
    console.error("[HMAC] SCALEMARGIN_DISPATCH_SECRET not configured");
    res.status(500).json({ error: "Server misconfigured: missing dispatch secret" });
    return;
  }

  // req.body should already be the raw string from express.text() middleware
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  const expected = createHmac("sha256", DISPATCH_SECRET)
    .update(rawBody)
    .digest("hex");
  const provided = signature.slice("sha256=".length);

  if (expected.length !== provided.length) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
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
