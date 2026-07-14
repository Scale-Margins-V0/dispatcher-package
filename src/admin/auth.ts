import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import cookieSession from "cookie-session";

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

const secureCompare = (provided: string, expected: string): boolean => {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

const configuredCredentials = () => {
  const username = process.env.DISPATCHER_ADMIN_USER;
  const password = process.env.DISPATCHER_ADMIN_PASSWORD;
  return username && password && password.length >= 16 ? { username, password } : undefined;
};

export const adminSession = (): RequestHandler => {
  const password = process.env.DISPATCHER_ADMIN_PASSWORD ?? "admin-not-configured";
  const key = process.env.DISPATCHER_ADMIN_SESSION_SECRET ??
    createHash("sha256").update(`dispatcher-admin-session:${password}`).digest("hex");
  const secure = process.env.DISPATCHER_ADMIN_COOKIE_SECURE === "true" ||
    (process.env.NODE_ENV === "production" && process.env.DISPATCHER_ADMIN_COOKIE_SECURE !== "false");
  return cookieSession({
    name: "dispatcher_admin",
    keys: [key],
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/admin",
    maxAge: SESSION_MAX_AGE_MS,
  });
};

export const adminSecurityHeaders: RequestHandler = (_req, res, next): void => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
};

const allowLoginAttempt = (req: Request): boolean => {
  const now = Date.now();
  const key = req.ip || "unknown";
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  current.count += 1;
  return current.count <= 10;
};

export const loginAdmin: RequestHandler = (req, res): void => {
  const expected = configuredCredentials();
  if (!expected) {
    res.status(503).json({ error: "Dispatcher admin access is not configured" });
    return;
  }
  if (!allowLoginAttempt(req)) {
    res.setHeader("Retry-After", "900");
    res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    return;
  }
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!secureCompare(username, expected.username) || !secureCompare(password, expected.password)) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  if (!req.session) {
    res.status(500).json({ error: "Unable to create admin session" });
    return;
  }
  req.session.adminAuthenticated = true;
  req.session.expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  res.json({ authenticated: true });
};

export const verifyAdminAccess: RequestHandler = (req, res, next): void => {
  if (!configuredCredentials()) {
    res.status(503).json({ error: "Dispatcher admin access is not configured" });
    return;
  }
  if (!req.session?.adminAuthenticated || !req.session.expiresAt || req.session.expiresAt <= Date.now()) {
    req.session = null;
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
};

export const logoutAdmin: RequestHandler = (req, res): void => {
  if (req.header("x-dispatcher-admin") !== "1") {
    res.status(403).json({ error: "Invalid request" });
    return;
  }
  req.session = null;
  res.json({ authenticated: false });
};
