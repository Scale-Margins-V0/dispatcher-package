/**
 * Dispatch -> emit dispatched -> SendGrid webhook -> emit delivered (fetch mock).
 */
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventWebhook } from "@sendgrid/eventwebhook";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  initializeEventPipeline,
  resetEventPipelineForTests,
  setEventsConfigForTests,
  shutdownEventPipeline,
} from "../index.js";
import { loadEventsConfigFromYaml } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const sendMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, messageId: "sg-msg-e2e" })
);

vi.mock("../../providers/index.js", () => ({
  getProvider: () => ({
    name: "sendgrid",
    send: sendMock,
  }),
}));

const eventsYaml = `
events:
  forward:
    mode: sync
    batch_size: 10
    batch_interval_ms: 1000
  delivery:
    mode: best_effort
    buffer:
      kind: memory
      max_events_memory: 100
  providers:
    sendgrid:
      enabled: true
      signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
    ses:
      enabled: false
    gupshup:
      enabled: false
`;

describe("dispatch + SendGrid event pipeline (integration)", () => {
  let app: import("express").Express;
  let workDir: string;
  let yamlPath: string;
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ events_processed: 1 }),
    })
  );
  let verifySpy: { mockRestore: () => void };

  beforeAll(async () => {
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
    process.env.SCALEMARGIN_DISPATCH_SECRET = "dispatch-secret";
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
    process.env.EVENT_FORWARD_MODE = "sync";
    process.env.EMAIL_PROVIDER = "sendgrid";
    process.env.UNSUBSCRIBE_URL_BASE = "https://example.com/unsub";

    vi.stubGlobal("fetch", fetchMock);

    workDir = mkdtempSync(join(tmpdir(), "evt-dispatch-e2e-"));
    const dbPath = join(workDir, "u.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users (user_id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, company_name TEXT, phone_no TEXT);
    `);
    db.prepare(
      "INSERT INTO users (user_id, first_name, last_name, email, company_name, phone_no) VALUES (?,?,?,?,?,?)"
    ).run("u1", "A", "B", "a@example.com", "C", null);
    db.close();

    yamlPath = join(workDir, "dispatch.yaml");
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
    company_name: company_name
    phone: phone_no
placeholders:
  first_name: { source: field, field: first_name, fallback: "there" }
  last_name: { source: field, field: last_name, fallback: "" }
  full_name: { source: computed, expr: "first_name + ' ' + last_name", fallback: "there" }
  company_name: { source: field, field: company_name, fallback: "" }
  email: { source: field, field: email, fallback: "" }
  phone: { source: field, field: phone, fallback: "" }
  unsubscribe_url:
    source: computed
    expr: "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id"
`
    );
    process.env.USER_LOOKUP_CONFIG_PATH = yamlPath;

    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(eventsYaml));
    verifySpy = vi.spyOn(EventWebhook.prototype, "verifySignature").mockReturnValue(
      true
    ) as typeof verifySpy;

    const mod = await import("../../index.js");
    app = mod.app;
    initializeEventPipeline();
  });

  afterAll(() => {
    verifySpy.mockRestore();
    vi.unstubAllGlobals();
    shutdownEventPipeline();
    resetEventPipelineForTests();
    try {
      rmSync(workDir, { recursive: true });
    } catch {
      /* ignore */
    }
    delete process.env.USER_LOOKUP_CONFIG_PATH;
    delete process.env.UNSUBSCRIBE_URL_BASE;
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    delete process.env.EVENT_FORWARD_MODE;
    delete process.env.EMAIL_PROVIDER;
  });

  it("POST /dispatch then SendGrid delivered -> two analytics POSTs with same user_id", async () => {
    const analyticsUrl = "http://127.0.0.1:19998/api/webhooks/campaign-analytics/e2e";
    const payload = {
      campaign_id: "camp-e2e",
      channel: "email",
      user_ids: ["u1"],
      content: { subject: "Hi {{first_name}}", html_body: "<p>{{email}}</p>" },
      metadata: {
        organization_id: "org-e2e",
        analytics_callback_url: analyticsUrl,
      },
    };
    const raw = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", "dispatch-secret").update(raw).digest("hex");

    const res202 = await request(app)
      .post("/api/scalemargin/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);
    expect(res202.status).toBe(202);
    await new Promise((r) => setTimeout(r, 200));

    expect(sendMock).toHaveBeenCalled();
    const sent = sendMock.mock.calls[0]![0] as {
      context?: { campaign_id: string; user_id: string };
    };
    expect(sent.context?.campaign_id).toBe("camp-e2e");
    expect(sent.context?.user_id).toBe("u1");

    const delivered = JSON.parse(
      readFileSync(join(__dirname, "../__fixtures__/sendgrid", "delivered.json"), "utf-8")
    ) as Record<string, unknown>;
    delivered.custom_args = {
      campaign_id: "camp-e2e",
      user_id: "u1",
      organization_id: "org-e2e",
      analytics_callback_url: analyticsUrl,
    };

    const sgBody = JSON.stringify([delivered]) + "\r\n";
    const resSg = await request(app)
      .post("/api/scalemargin/sendgrid-events")
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", "sig")
      .set("X-Twilio-Email-Event-Webhook-Timestamp", "1234567890")
      .send(sgBody);
    expect(resSg.status).toBe(200);

    const analyticsPosts = fetchMock.mock.calls.filter((c) => String(c[0]) === analyticsUrl);
    expect(analyticsPosts.length).toBeGreaterThanOrEqual(2);
    const bodies = analyticsPosts.map((c) =>
      JSON.parse(String((c[1] as RequestInit | undefined)?.body ?? "{}")) as {
        events?: { user_id: string; event: string }[];
      }
    );
    const events = bodies.flatMap((b) => b.events ?? []);
    expect(events.some((e) => e.event === "dispatched")).toBe(true);
    expect(events.some((e) => e.event === "delivered")).toBe(true);
    expect(events.every((e) => e.user_id === "u1")).toBe(true);
  });
});
