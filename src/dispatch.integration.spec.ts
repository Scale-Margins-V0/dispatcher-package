/**
 * Full Express app: signed POST /dispatch, sqlite **view** as `user_lookup.source`, mocked send/analytics.
 */
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }),
}));

vi.mock("./providers/index.js", () => ({
  getProvider: () => ({
    name: "mock",
    send: sendMock,
  }),
}));

const fetchMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ events_processed: 1 }),
    })
  )
);

describe("POST /api/scalemargin/dispatch (integration)", () => {
  let app: import("express").Express;
  let yamlPath: string;
  let workDir: string;

  beforeAll(async () => {
    process.env.VITEST = "true";
    process.env.SCALEMARGIN_DISPATCH_SECRET = "dispatch-secret";
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
    process.env.NODE_ENV = "test";
    process.env.EVENT_FORWARD_MODE = "sync";
    process.env.EVENT_DELIVERY_MODE = "best_effort";
    vi.stubGlobal("fetch", fetchMock);

    workDir = mkdtempSync(join(tmpdir(), "dispatch-e2e-"));
    const dbPath = join(workDir, "campaign.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users_internal (
        user_id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        company_name TEXT,
        phone_no TEXT
      );
      CREATE VIEW users AS
        SELECT user_id, first_name, last_name, email, company_name, phone_no
        FROM users_internal;
    `);
    const ins = db.prepare(
      `INSERT INTO users_internal (user_id, first_name, last_name, email, company_name, phone_no)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run("u1", "Ada", "Lovelace", "ada@example.com", "Analytical Engines", null);
    ins.run(
      "u2",
      "Grace",
      "Hopper",
      "grace@example.com",
      "US Navy",
      "+1-555-0102"
    );
    ins.run("u3", "Alan", "Turing", "alan@example.com", "Bletchley", null);
    db.close();

    yamlPath = join(workDir, "dispatch.yaml");
    const sqliteJson = JSON.stringify(dbPath);
    writeFileSync(
      yamlPath,
      `
user_lookup:
  backend: sqlite
  sqlite:
    file: ${sqliteJson}
  source:
    kind: view
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
    process.env.UNSUBSCRIBE_URL_BASE = "https://example.com";

    vi.resetModules();
    sendMock.mockClear();
    fetchMock.mockClear();
    const mod = await import("./index.js");
    app = mod.app;
    const { initializeEventPipeline } = await import("./events/index.js");
    initializeEventPipeline();
  }, 60_000);

  beforeEach(() => {
    sendMock.mockClear();
    fetchMock.mockClear();
  });

  afterAll(async () => {
    try {
      rmSync(workDir, { recursive: true });
    } catch {
      /* ignore */
    }
    delete process.env.USER_LOOKUP_CONFIG_PATH;
    delete process.env.UNSUBSCRIBE_URL_BASE;
    delete process.env.EVENT_FORWARD_MODE;
    delete process.env.EVENT_DELIVERY_MODE;
    delete process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL;
    delete process.env.IMAGE_STORAGE_PROVIDER;
    delete process.env.IMAGE_LOCAL_DIR;
    delete process.env.IMAGE_LOCAL_BASE_URL;
    vi.unstubAllGlobals();
    const { shutdownEventPipeline, resetEventPipelineForTests } = await import("./events/index.js");
    shutdownEventPipeline();
    resetEventPipelineForTests();
  });

  it("returns 202 and sends personalized email (user rows read through a SQL view)", async () => {
    const payload = {
      campaign_id: "camp-1",
      channel: "email",
      user_ids: ["u1"],
      content: {
        subject: "Hi {{first_name}}",
        html_body: "<p>{{full_name}} — {{email}}</p>",
      },
      metadata: {
        organization_id: "org-1",
        analytics_callback_url:
          "http://127.0.0.1:9/api/webhooks/campaign-analytics/test",
      },
    };
    const raw = JSON.stringify(payload);
    const sig =
      "sha256=" +
      createHmac("sha256", "dispatch-secret").update(raw).digest("hex");

    const res = await request(app)
      .post("/api/scalemargin/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 250));
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as {
      subject: string;
      html: string;
    };
    expect(msg.subject).toBe("Hi Ada");
    expect(msg.html).toContain("Ada Lovelace");
    expect(msg.html).toContain("ada@example.com");
    expect((sendMock.mock.calls[0]![0] as { context?: { user_id: string } }).context?.user_id).toBe(
      "u1"
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("multi-recipient dispatch: one send per user with a rich HTML template", async () => {
    const payload = {
      campaign_id: "camp-multi",
      channel: "email",
      user_ids: ["u1", "u2", "u3"],
      content: {
        subject: "{{company_name}} — hello {{first_name}}",
        html_body:
          "<article><h1>{{full_name}}</h1><p>{{email}}</p>" +
          "<small>{{phone}}</small><footer>{{unsubscribe_url}}</footer></article>",
      },
      metadata: {
        organization_id: "org-1",
        analytics_callback_url:
          "http://127.0.0.1:9/api/webhooks/campaign-analytics/test",
      },
    };
    const raw = JSON.stringify(payload);
    const sig =
      "sha256=" +
      createHmac("sha256", "dispatch-secret").update(raw).digest("hex");

    const res = await request(app)
      .post("/api/scalemargin/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
    expect(sendMock).toHaveBeenCalledTimes(3);

    const byTo = new Map(
      sendMock.mock.calls.map((c) => {
        const msg = c[0] as { to: string; subject: string; html: string };
        return [msg.to, msg] as const;
      })
    );

    const ada = byTo.get("ada@example.com")!;
    expect(ada.subject).toBe("Analytical Engines — hello Ada");
    expect(ada.html).toContain("Ada Lovelace");
    expect(ada.html).toContain("https://example.com/api/unsubscribe?uid=u1");

    const grace = byTo.get("grace@example.com")!;
    expect(grace.subject).toBe("US Navy — hello Grace");
    expect(grace.html).toContain("Grace Hopper");
    expect(grace.html).toContain("+1-555-0102");

    const alan = byTo.get("alan@example.com")!;
    expect(alan.subject).toBe("Bletchley — hello Alan");
    expect(alan.html).toContain("Alan Turing");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("second template shape: text_body + different subject tokens", async () => {
    const payload = {
      campaign_id: "camp-text",
      channel: "email",
      user_ids: ["u2", "u1"],
      content: {
        subject: "Weekly: {{last_name}}, {{first_name}}",
        html_body: "<b>{{email}}</b>",
        text_body: "Text fallback: {{full_name}} | {{company_name}}",
      },
      metadata: {
        organization_id: "org-1",
        analytics_callback_url:
          "http://127.0.0.1:9/api/webhooks/campaign-analytics/test",
      },
    };
    const raw = JSON.stringify(payload);
    const sig =
      "sha256=" +
      createHmac("sha256", "dispatch-secret").update(raw).digest("hex");

    const res = await request(app)
      .post("/api/scalemargin/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 350));
    expect(sendMock).toHaveBeenCalledTimes(2);

    const grace = sendMock.mock.calls.find(
      (c) => (c[0] as { to: string }).to === "grace@example.com"
    )![0] as { subject: string; html: string; text: string };
    expect(grace.subject).toBe("Weekly: Hopper, Grace");
    expect(grace.text).toContain("Grace Hopper");
    expect(grace.text).toContain("US Navy");

    const ada = sendMock.mock.calls.find(
      (c) => (c[0] as { to: string }).to === "ada@example.com"
    )![0] as { subject: string; text: string };
    expect(ada.subject).toBe("Weekly: Lovelace, Ada");
    expect(ada.text).toContain("Ada Lovelace");
  });

  it("GET /api/unsubscribe renders a reason survey instead of recording immediately", async () => {
    process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL =
      "http://127.0.0.1:9/api/webhooks/campaign-analytics/unsub-link";
    process.env.LOGO_URL = "https://cdn.example.com/brand-logo.png";
    fetchMock.mockClear();

    const res = await request(app)
      .get("/api/unsubscribe")
      .query({ uid: "u1", campaign_id: "camp-unsub", organization_id: "org-1" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Confirm unsubscribe");
    expect(res.text).toContain("This email is not relevant to me");
    expect(res.text).toContain('name="reason"');
    expect(res.text).toContain('src="https://cdn.example.com/brand-logo.png"');
    expect(fetchMock.mock.calls).toHaveLength(0);

    delete process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL;
    delete process.env.LOGO_URL;
  });

  it("POST /api/unsubscribe forwards PII-free unsubscribed analytics with reason", async () => {
    process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL =
      "http://127.0.0.1:9/api/webhooks/campaign-analytics/unsub-link";
    fetchMock.mockClear();

    const res = await request(app)
      .post("/api/unsubscribe")
      .type("form")
      .send({
        uid: "u1",
        campaign_id: "camp-unsub",
        organization_id: "org-1",
        reason: "too_frequent",
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain("recorded");
    const call = (fetchMock.mock.calls as unknown[][]).find((c) =>
      String(c[0]).includes("campaign-analytics/unsub-link")
    );
    expect(call).toBeDefined();
    const init = (call as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init?.body ?? "")) as {
      events?: Array<{
        event: string;
        user_id: string;
        metadata?: { source?: string; reason?: string; reason_id?: string };
      }>;
    };
    expect(body.events?.[0]?.event).toBe("unsubscribed");
    expect(body.events?.[0]?.user_id).toBe("u1");
    expect(body.events?.[0]?.metadata?.source).toBe("unsubscribe_link_click");
    expect(body.events?.[0]?.metadata?.reason_id).toBe("too_frequent");
    expect(body.events?.[0]?.metadata?.reason).toBe("The emails are too frequent");

    delete process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL;
  });

  it("POST /api/unsubscribe stores free-text when Other is selected", async () => {
    process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL =
      "http://127.0.0.1:9/api/webhooks/campaign-analytics/unsub-other";
    fetchMock.mockClear();

    const res = await request(app)
      .post("/api/unsubscribe")
      .type("form")
      .send({
        uid: "u1",
        campaign_id: "camp-unsub",
        organization_id: "org-1",
        reason: "other",
        reason_other: "Changed my role",
      });

    expect(res.status).toBe(200);
    const call = (fetchMock.mock.calls as unknown[][]).find((c) =>
      String(c[0]).includes("campaign-analytics/unsub-other")
    );
    expect(call).toBeDefined();
    const init = (call as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init?.body ?? "")) as {
      events?: Array<{ metadata?: { reason?: string; reason_id?: string } }>;
    };
    expect(body.events?.[0]?.metadata?.reason_id).toBe("other");
    expect(body.events?.[0]?.metadata?.reason).toBe("Changed my role");

    delete process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL;
  });

  it("GET /api/preferences renders a preference-selection screen with both categories checked", async () => {
    process.env.LOGO_URL = "https://cdn.example.com/prefs-logo.png";
    const res = await request(app)
      .get("/api/preferences")
      .query({ uid: "u1", campaign_id: "camp-pref", organization_id: "org-1" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Newsletter");
    expect(res.text).toContain("Promotional offers");
    expect(res.text).toContain("Unsubscribe from all emails");
    expect(res.text).toContain('name="category_newsletter" value="1" checked');
    expect(res.text).toContain('name="category_promotional" value="1" checked');
    expect(res.text).toContain('src="https://cdn.example.com/prefs-logo.png"');
    delete process.env.LOGO_URL;
  });

  it("POST /api/preferences forwards a category-scoped unsubscribed event when a box is unchecked", async () => {
    process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL =
      "http://127.0.0.1:9/api/webhooks/campaign-analytics/prefs-link";
    fetchMock.mockClear();

    const res = await request(app)
      .post("/api/preferences")
      .type("form")
      .send({
        uid: "u1",
        campaign_id: "camp-pref",
        organization_id: "org-1",
        category_newsletter: "1",
        // category_promotional omitted → unchecked → stop only promotional
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain("promotional");

    const call = (fetchMock.mock.calls as unknown[][]).find((c) =>
      String(c[0]).includes("campaign-analytics/prefs-link")
    );
    expect(call).toBeDefined();
    const init = (call as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init?.body ?? "")) as {
      events?: Array<{
        event: string;
        user_id: string;
        metadata?: {
          source?: string;
          campaignType?: string;
          kept?: string[];
          stopped?: string[];
          unsubscribed_all?: boolean;
        };
      }>;
    };
    // One category-scoped unsubscribed event + one preference_update log event.
    expect(body.events).toHaveLength(2);
    const unsub = body.events?.find((e) => e.event === "unsubscribed");
    expect(unsub?.user_id).toBe("u1");
    expect(unsub?.metadata?.source).toBe("preferences_link_click");
    expect(unsub?.metadata?.campaignType).toBe("promotional");

    const prefUpdate = body.events?.find((e) => e.event === "preference_update");
    expect(prefUpdate?.user_id).toBe("u1");
    expect(prefUpdate?.metadata?.stopped).toEqual(["promotional"]);
    expect(prefUpdate?.metadata?.kept).toEqual(["newsletter"]);
    expect(prefUpdate?.metadata?.unsubscribed_all).toBe(false);

    delete process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL;
  });

  it("POST /api/preferences with unsubscribe_all forwards a single global unsubscribed event", async () => {
    process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL =
      "http://127.0.0.1:9/api/webhooks/campaign-analytics/prefs-link-all";
    fetchMock.mockClear();

    const res = await request(app)
      .post("/api/preferences")
      .type("form")
      .send({
        uid: "u1",
        campaign_id: "camp-pref",
        organization_id: "org-1",
        unsubscribe_all: "1",
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed from all");

    const call = (fetchMock.mock.calls as unknown[][]).find((c) =>
      String(c[0]).includes("campaign-analytics/prefs-link-all")
    );
    expect(call).toBeDefined();
    const init = (call as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init?.body ?? "")) as {
      events?: Array<{
        event: string;
        metadata?: { campaignType?: string; unsubscribed_all?: boolean };
      }>;
    };
    // One global-scoped unsubscribed event + one preference_update log event.
    expect(body.events).toHaveLength(2);
    const unsub = body.events?.find((e) => e.event === "unsubscribed");
    // "Unsubscribe all" always sets an explicit campaignType="all" — never left
    // for the backend to infer from the campaign's own type.
    expect(unsub?.metadata?.campaignType).toBe("all");

    const prefUpdate = body.events?.find((e) => e.event === "preference_update");
    expect(prefUpdate?.metadata?.unsubscribed_all).toBe(true);

    delete process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL;
  });

  it("processes inline campaign images and rewrites HTML URLs before send", async () => {
    const imageDir = join(workDir, "images-local");
    process.env.IMAGE_STORAGE_PROVIDER = "local";
    process.env.IMAGE_LOCAL_DIR = imageDir;
    process.env.IMAGE_LOCAL_BASE_URL = "http://test.local/images";
    sendMock.mockClear();

    const payload = {
      campaign_id: "camp-images",
      channel: "email",
      user_ids: ["u1"],
      content: {
        subject: "Image test for {{first_name}}",
        html_body:
          '<p><img src="https://cdn.scalemargin.test/original/logo.png" alt="logo" /></p>',
      },
      images: [
        {
          placeholder: "logo",
          url: "https://cdn.scalemargin.test/original/logo.png",
          raw_url: "https://cdn.scalemargin.test/original/logo.png",
          content_type: "image/png",
          base64_data:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Vf1YAAAAASUVORK5CYII=",
        },
      ],
      metadata: {
        organization_id: "org-1",
        analytics_callback_url:
          "http://127.0.0.1:9/api/webhooks/campaign-analytics/test",
      },
    };
    const raw = JSON.stringify(payload);
    const sig =
      "sha256=" +
      createHmac("sha256", "dispatch-secret").update(raw).digest("hex");

    const res = await request(app)
      .post("/api/scalemargin/dispatch")
      .set("Content-Type", "application/json")
      .set("X-ScaleMargin-Signature", sig)
      .send(raw);

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as { html: string };
    expect(msg.html).toContain("http://test.local/images/camp-images/logo.png");
    expect(msg.html).not.toContain("https://cdn.scalemargin.test/original/logo.png");
    expect(existsSync(join(imageDir, "camp-images", "logo.png"))).toBe(true);

    delete process.env.IMAGE_STORAGE_PROVIDER;
    delete process.env.IMAGE_LOCAL_DIR;
    delete process.env.IMAGE_LOCAL_BASE_URL;
  });
});
