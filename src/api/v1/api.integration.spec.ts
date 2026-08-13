/**
 * Contract tests for the external/internal API routers. The external tree is a
 * frozen contract Atlas depends on, so these assert the promises the plan makes:
 * key auth (including revocation), null-not-zero placeholders, no secrets in
 * responses, and graceful degradation.
 */

import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import type { DispatcherDb } from "../../db/client.js";
import { ATLAS_KEY_ENV } from "./atlas-key.js";
import { CORS_ORIGINS_ENV } from "./cors.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "./router.js";

const key = "test-atlas-key-0123456789abcdefghijklmnop";

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env[ATLAS_KEY_ENV];
  process.env[ATLAS_KEY_ENV] = key;
  dbx = await createTestDb();
  app = express();
  registerApiV1Routes(app);
});

afterAll(() => {
  if (savedKey === undefined) delete process.env[ATLAS_KEY_ENV];
  else process.env[ATLAS_KEY_ENV] = savedKey;
  destroyTestDb(dbx);
});

const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

describe("external router auth", () => {
  it("rejects a request with no key", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/build");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized", message: "Valid API key required" });
  });

  it("rejects a malformed key", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/build").set(auth("not-a-key"));
    expect(res.status).toBe(401);
  });

  it("rejects an unknown key", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/build").set(auth("a-completely-different-key-value-here"));
    expect(res.status).toBe(401);
  });

  it("rejects a key that differs only in its last character", async () => {
    resetApiRateLimitForTests();
    const nearMiss = `${key.slice(0, -1)}X`;
    const res = await request(app).get("/api/v1/data-plane/build").set(auth(nearMiss));
    expect(res.status).toBe(401);
  });

  it("gives the same message for every rejection reason", async () => {
    resetApiRateLimitForTests();
    const none = await request(app).get("/api/v1/data-plane/build");
    const bad = await request(app).get("/api/v1/data-plane/build").set(auth("wrong"));
    expect(bad.body).toEqual(none.body);
  });

  it("fails CLOSED when the key is not configured — never falls open", async () => {
    resetApiRateLimitForTests();
    delete process.env[ATLAS_KEY_ENV];
    const withKey = await request(app).get("/api/v1/data-plane/build").set(auth(key));
    const without = await request(app).get("/api/v1/data-plane/build");
    process.env[ATLAS_KEY_ENV] = key;
    expect(withKey.status).toBe(503);
    expect(without.status).toBe(503);
    expect(withKey.body.error).toBe("unavailable");
  });

  it("accepts a valid key", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/build").set(auth(key));
    expect(res.status).toBe(200);
  });

  it("404s an unknown data-plane path with the shared envelope", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/nope").set(auth(key));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("GET /api/v1/data-plane/build", () => {
  it("returns identity, runtime and database dialect", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/build").set(auth(key));
    expect(res.status).toBe(200);
    expect(res.body.service.api_version).toBe("v1");
    expect(res.body.service.version).toBeTruthy();
    expect(res.body.runtime.node_version).toBe(process.version);
    expect(res.body.database.dialect).toBe("sqlite");
    expect(res.body.database.reachable).toBe(true);
  });

  it("never leaks a connection string, host, user or password", async () => {
    resetApiRateLimitForTests();
    process.env.DISPATCHER_DB_PASSWORD = "super-secret-value";
    const res = await request(app).get("/api/v1/data-plane/build").set(auth(key));
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("DISPATCHER_DB_URL");
    expect(serialized).not.toMatch(/password/i);
    delete process.env.DISPATCHER_DB_PASSWORD;
  });
});

describe("GET /api/v1/data-plane/state", () => {
  it("reports a fixed 30-day window and real counters", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/state").set(auth(key));
    expect(res.status).toBe(200);
    expect(res.body.dispatch.window_days).toBe(30);
    expect(res.body.dispatch.dispatched).toBe(0);
    expect(res.body.status.checks.state_database.ok).toBe(true);
  });

  it("returns null — not 0 — for metrics that are not measured yet", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/state").set(auth(key));
    // A zero here would read as "no fallbacks ever", which is a false
    // reassurance rather than a missing measurement. See plan §8.
    expect(res.body.resolution.fallback_rate).toBeNull();
    expect(res.body.catalog.last_published_at).toBeNull();
  });

  it("never leaks recipient identifiers", async () => {
    resetApiRateLimitForTests();
    const res = await request(app).get("/api/v1/data-plane/state").set(auth(key));
    expect(JSON.stringify(res.body)).not.toContain("@");
  });
});

describe("internal router", () => {
  it("serves liveness without a key", async () => {
    const res = await request(app).get("/api/v1/internal/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("serves readiness with per-dependency detail", async () => {
    const res = await request(app).get("/api/v1/internal/ready");
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks.state_database).toBe(true);
  });
});

describe("CORS", () => {
  const ORIGIN = "https://atlas.scalemargin.com";
  const setOrigins = (value: string | undefined) => {
    if (value === undefined) delete process.env[CORS_ORIGINS_ENV];
    else process.env[CORS_ORIGINS_ENV] = value;
  };
  afterEach(() => setOrigins(undefined));

  it("answers preflight WITHOUT auth — a preflight never carries credentials", async () => {
    resetApiRateLimitForTests();
    setOrigins(ORIGIN);
    const res = await request(app)
      .options("/api/v1/data-plane/build")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-headers"]).toContain("authorization");
    expect(res.headers.vary).toBe("Origin");
  });

  it("still answers preflight when CORS is disabled, rather than 401", async () => {
    resetApiRateLimitForTests();
    setOrigins(undefined);
    const res = await request(app)
      .options("/api/v1/data-plane/build")
      .set("Origin", ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends no CORS headers by default", async () => {
    resetApiRateLimitForTests();
    setOrigins(undefined);
    const res = await request(app)
      .get("/api/v1/data-plane/build")
      .set("Origin", ORIGIN)
      .set(auth(key));
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("echoes only an allowlisted origin", async () => {
    resetApiRateLimitForTests();
    setOrigins(ORIGIN);
    const allowed = await request(app).get("/api/v1/data-plane/build").set("Origin", ORIGIN).set(auth(key));
    const denied = await request(app).get("/api/v1/data-plane/build").set("Origin", "https://evil.example").set(auth(key));
    expect(allowed.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.status).toBe(200);
  });

  it("normalizes configured entries to origins and ignores junk", async () => {
    resetApiRateLimitForTests();
    setOrigins(`${ORIGIN}/dashboard/, not-a-url , https://second.example`);
    const res = await request(app).get("/api/v1/data-plane/build").set("Origin", ORIGIN).set(auth(key));
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("never sends Allow-Credentials — auth is a bearer header, not a cookie", async () => {
    resetApiRateLimitForTests();
    setOrigins(ORIGIN);
    const res = await request(app).get("/api/v1/data-plane/build").set("Origin", ORIGIN).set(auth(key));
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("rate limiting", () => {
  it("returns 429 once the window is exhausted", async () => {
    resetApiRateLimitForTests();
    let last = 200;
    for (let i = 0; i < 62 && last !== 429; i++) {
      last = (await request(app).get("/api/v1/data-plane/build").set(auth(key))).status;
    }
    expect(last).toBe(429);
    resetApiRateLimitForTests();
  });
});
