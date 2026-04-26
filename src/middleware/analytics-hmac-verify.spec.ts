import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAnalyticsHmacSignature } from "./analytics-hmac-verify.js";

describe("verifyAnalyticsHmacSignature", () => {
  afterEach(() => {
    delete process.env.SCALEMARGIN_ANALYTICS_SECRET;
    vi.unstubAllGlobals();
  });

  it("accepts valid sha256 signature", async () => {
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "s3cret";
    const app = express();
    app.post(
      "/c",
      express.text({ type: "application/json" }),
      verifyAnalyticsHmacSignature,
      (req, res) => {
        res.json({ ok: true, body: req.body });
      }
    );
    const raw = JSON.stringify({ campaign_id: "c", organization_id: "o", events: [] });
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(raw).digest("hex");
    const res = await request(app)
      .post("/c")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects bad signature", async () => {
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "s3cret";
    const app = express();
    app.post(
      "/c",
      express.text({ type: "application/json" }),
      verifyAnalyticsHmacSignature,
      (_req, res) => res.json({ ok: true })
    );
    const raw = JSON.stringify({ x: 1 });
    const res = await request(app)
      .post("/c")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", "sha256=deadbeef")
      .send(raw);
    expect(res.status).toBe(401);
  });
});
