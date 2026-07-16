import type { RequestHandler } from "express";

/**
 * Security headers for the admin surface. Authentication itself is handled by
 * Better Auth (see src/auth/); this only sets the response hardening headers.
 * The CSP is same-origin only, which the Better Auth fetch client satisfies.
 *
 * `style-src` allows 'unsafe-inline' because the UI component library (sonner /
 * Radix) injects its stylesheet at runtime, which a strict style-src blocks.
 * This permits CSS injection on an authenticated admin-only page; `script-src`
 * stays 'self', so the XSS-critical directive is unchanged.
 */
export const adminSecurityHeaders: RequestHandler = (_req, res, next): void => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
};
