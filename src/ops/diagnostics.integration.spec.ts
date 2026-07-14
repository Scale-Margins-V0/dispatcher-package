import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function sign(raw: string): string {
  return (
    "sha256=" +
    createHmac("sha256", process.env.SCALEMARGIN_DISPATCH_SECRET || "")
      .update(raw)
      .digest("hex")
  );
}

describe("operations endpoints", () => {
  let app: import("express").Express;
  let workDir: string;

  beforeAll(async () => {
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
    process.env.SCALEMARGIN_DISPATCH_SECRET = "dispatch-secret";
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
    process.env.EMAIL_PROVIDER = "sendgrid";
    process.env.SENDGRID_API_KEY = "SG.secret-value";

    workDir = mkdtempSync(join(tmpdir(), "dispatcher-ops-"));
    const dbPath = join(workDir, "profiles.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        phone TEXT
      );
    `);
    db.prepare(
      "INSERT INTO users (user_id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)"
    ).run("u1", "Ada", "Lovelace", "ada@example.com", "919876543210");
    db.close();

    const yamlPath = join(workDir, "dispatch.yaml");
    writeFileSync(
      yamlPath,
      `
user_lookup:
  backend: sqlite
  sqlite:
    file: ${JSON.stringify(dbPath)}
  source:
    kind: table
    name: users
    id_column: user_id
    id_type: string
  fields:
    first_name: first_name
    last_name: last_name
    email: email
    phone: phone
placeholders:
  first_name: { source: field, field: first_name, fallback: "there" }
  email: { source: field, field: email, fallback: "" }
`
    );

    process.env.USER_LOOKUP_CONFIG_PATH = yamlPath;
    const mod = await import("../index.js");
    app = mod.app;
  });

  afterAll(async () => {
    const { shutdownEventPipeline, resetEventPipelineForTests } = await import(
      "../events/index.js"
    );
    const { resetDispatchConfigForTests } = await import("../user-lookup/config.js");
    const { resetLookupAdapterForTests } = await import("../user-lookup/index.js");

    shutdownEventPipeline();
    resetEventPipelineForTests();
    resetDispatchConfigForTests();
    resetLookupAdapterForTests();
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.USER_LOOKUP_CONFIG_PATH;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.DISPATCHER_ADMIN_USER;
    delete process.env.DISPATCHER_ADMIN_PASSWORD;
  });

  it("keeps admin routes disabled when credentials are not configured", async () => {
    delete process.env.DISPATCHER_ADMIN_USER;
    delete process.env.DISPATCHER_ADMIN_PASSWORD;

    const res = await request(app).get("/admin/api/overview");

    expect(res.status).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects invalid admin credentials", async () => {
    process.env.DISPATCHER_ADMIN_USER = "operator";
    process.env.DISPATCHER_ADMIN_PASSWORD = "correct-horse-battery-staple";

    const res = await request(app)
      .post("/admin/api/login")
      .send({ username: "operator", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("returns a protected and redacted admin overview", async () => {
    process.env.DISPATCHER_ADMIN_USER = "operator";
    process.env.DISPATCHER_ADMIN_PASSWORD = "correct-horse-battery-staple";

    const admin = request.agent(app);
    const login = await admin
      .post("/admin/api/login")
      .send({ username: "operator", password: "correct-horse-battery-staple" });
    const res = await admin.get("/admin/api/overview");

    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const cookies = (Array.isArray(setCookie) ? setCookie.join(";") : setCookie ?? "").toLowerCase();
    expect(cookies).toContain("httponly");
    expect(cookies).toContain("samesite=strict");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.body.status.status).toBe("ok");
    expect(res.body.config.user_lookup_backend).toBe("sqlite");
    expect(res.body.config.dispatch_config_path).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("SG.secret-value");
    expect(JSON.stringify(res.body)).not.toContain("ada@example.com");
    expect(JSON.stringify(res.body)).not.toContain("919876543210");
  });

  it("returns public health, version, and status", async () => {
    const health = await request(app).get("/health");
    const version = await request(app).get("/version");
    const status = await request(app).get("/status");

    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(version.status).toBe(200);
    expect(version.body.name).toBe("scalemargin-dispatch-handler");
    expect(version.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("ok");
  });

  it("rejects unsigned diagnostics requests", async () => {
    const res = await request(app)
      .post("/api/scalemargin/diagnostics")
      .set("Content-Type", "application/json")
      .send("{}");

    expect(res.status).toBe(401);
  });

  it("accepts a signed empty diagnostics request", async () => {
    const raw = "{}";

    const res = await request(app)
      .post("/api/scalemargin/diagnostics")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.status.status).toBe("ok");
    expect(res.body.checks).toBeUndefined();
  });

  it("returns a redacted signed diagnostics report", async () => {
    const raw = JSON.stringify({
      checks: ["user_lookup"],
      sample_user_ids: ["u1"],
    });

    const res = await request(app)
      .post("/api/scalemargin/diagnostics")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.status.status).toBe("ok");
    expect(res.body.env.required.SCALEMARGIN_DISPATCH_SECRET).toBe(true);
    expect(res.body.env.provider.SENDGRID_API_KEY).toBe(true);
    expect(res.body.config.user_lookup_backend).toBe("sqlite");
    expect(res.body.config.placeholder_names).toEqual(["first_name", "email"]);
    expect(res.body.checks.user_lookup).toMatchObject({
      pii_conversion_ok: true,
      requested_count: 1,
      found_count: 1,
      missing_user_ids: [],
      email_available_count: 1,
    });
    expect(res.body.checks.user_lookup.resolved_field_names).toContain("email");
    expect(JSON.stringify(res.body)).not.toContain("SG.secret-value");
    expect(JSON.stringify(res.body)).not.toContain("ada@example.com");
    expect(JSON.stringify(res.body)).not.toContain("919876543210");
  });
});
