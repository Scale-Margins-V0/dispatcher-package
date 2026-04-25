import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHmacSignature } from "./hmac.js";

describe("verifyHmacSignature", () => {
  afterEach(() => {
    delete process.env.SCALEMARGIN_DISPATCH_SECRET;
  });

  it("accepts valid sha256 signature and parses JSON", async () => {
    process.env.SCALEMARGIN_DISPATCH_SECRET = "dispatch-secret";
    const app = express();
    app.post(
      "/dispatch",
      express.text({ type: "application/json" }),
      verifyHmacSignature,
      (req, res) => {
        res.json({ ok: true, body: req.body });
      }
    );
    const raw = JSON.stringify({ campaign_id: "c1", user_ids: ["u1"] });
    const sig =
      "sha256=" +
      createHmac("sha256", "dispatch-secret").update(raw).digest("hex");
    const res = await request(app)
      .post("/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      body: { campaign_id: "c1", user_ids: ["u1"] },
    });
  });

  it("uses current process.env secret at request time", async () => {
    const app = express();
    app.post(
      "/dispatch",
      express.text({ type: "application/json" }),
      verifyHmacSignature,
      (_req, res) => {
        res.json({ ok: true });
      }
    );

    const raw = JSON.stringify({ campaign_id: "c2" });

    process.env.SCALEMARGIN_DISPATCH_SECRET = "first-secret";
    const firstSig =
      "sha256=" + createHmac("sha256", "first-secret").update(raw).digest("hex");
    const first = await request(app)
      .post("/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", firstSig)
      .send(raw);
    expect(first.status).toBe(200);

    process.env.SCALEMARGIN_DISPATCH_SECRET = "second-secret";
    const secondSig =
      "sha256=" + createHmac("sha256", "second-secret").update(raw).digest("hex");
    const second = await request(app)
      .post("/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", secondSig)
      .send(raw);
    expect(second.status).toBe(200);
  });

  it("rejects invalid JSON body after signature verification", async () => {
    process.env.SCALEMARGIN_DISPATCH_SECRET = "dispatch-secret";
    const app = express();
    app.post(
      "/dispatch",
      express.text({ type: "application/json" }),
      verifyHmacSignature,
      (_req, res) => res.json({ ok: true })
    );
    const invalidJson = '{"campaign_id":';
    const sig =
      "sha256=" +
      createHmac("sha256", "dispatch-secret").update(invalidJson).digest("hex");

    const res = await request(app)
      .post("/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(invalidJson);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON body" });
  });
});
