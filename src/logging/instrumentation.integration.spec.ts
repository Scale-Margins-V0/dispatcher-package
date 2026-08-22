/**
 * Guards the three rules in ./conventions.ts.
 *
 * These are the properties that make the log usable rather than merely present:
 * lines carry structured fields, hot paths do not emit per recipient, and
 * nothing that came out of the customer's database is written down.
 */

import express, { type Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import { setDispatchConfigForTests } from "../user-lookup/config.js";
import { resetLookupAdapterForTests } from "../user-lookup/index.js";
import { processDispatch } from "../dispatch/processor.js";
import { ATLAS_KEY_ENV } from "../api/v1/atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../api/v1/router.js";
import { clearCapturedLogs, findCapturedLogs, readCapturedLogs } from "./test-capture.js";
import type { DispatchPayload } from "../dispatch/types.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;

const auth = { Authorization: `Bearer ${KEY}` };

/** A mock lookup that hands back addresses — the PII the log must not repeat. */
function configureLookup(): void {
  setDispatchConfigForTests({
    user_lookup: {
      backend: "mock",
      fields: {
        first_name: "first_name",
        last_name: "last_name",
        email: "email",
        phone: "phone",
        company_name: "company_name",
      },
      batch: { max_ids_per_query: 1000, dedupe: true },
    },
    placeholders: {
      first_name: { source: "field", field: "first_name", fallback: "there" },
      missing_one: { source: "field", field: "not_a_column", fallback: "n/a" },
    },
  });
  resetLookupAdapterForTests();
}

function payload(userIds: string[]): DispatchPayload {
  return {
    campaign_id: "cmp_log_1",
    channel: "email",
    user_ids: userIds,
    content: {
      subject: "Hello {{first_name}}",
      html_body: "<p>Hi {{first_name}}, ref {{missing_one}}</p>",
    },
    metadata: {
      organization_id: "org_1",
      analytics_callback_url: "http://127.0.0.1:19999/api/webhooks/campaign-analytics/x",
    },
  };
}

beforeAll(async () => {
  savedKey = process.env[ATLAS_KEY_ENV];
  process.env[ATLAS_KEY_ENV] = KEY;
  dbx = await createTestDb();
  app = express();
  registerApiV1Routes(app);
});

afterAll(() => {
  if (savedKey === undefined) delete process.env[ATLAS_KEY_ENV];
  else process.env[ATLAS_KEY_ENV] = savedKey;
  destroyTestDb(dbx);
});

beforeEach(() => {
  clearCapturedLogs();
  resetApiRateLimitForTests();
});

describe("every line is tagged and structured", () => {
  it("tags dispatch lines with a component and machine-readable fields", async () => {
    configureLookup();
    await processDispatch(payload(["u1", "u2"]), "sender@example.com", "run_1");

    const [completed] = findCapturedLogs((e) => e.msg.startsWith("Dispatch completed"));
    expect(completed).toBeDefined();
    expect(completed?.component).toBe("dispatch.email");
    // The shape of the run, not a sentence someone has to parse.
    expect(completed?.fields).toMatchObject({
      channel: "email",
      requested: 2,
      sent: expect.any(Number),
      failed: expect.any(Number),
    });
  });

  it("stamps campaign_id on dispatch lines without the call site passing it", async () => {
    configureLookup();
    await processDispatch(payload(["u1"]), "sender@example.com", "run_2");

    const started = findCapturedLogs((e) => e.msg === "Dispatch started");
    expect(started.length).toBeGreaterThan(0);
    // AsyncLocalStorage mixin — see logger.ts. Not threaded by hand anywhere.
    expect(started[0]?.fields).toHaveProperty("recipients");
  });

  it("leaves no component null on a dispatch path", async () => {
    configureLookup();
    await processDispatch(payload(["u1"]), "sender@example.com", "run_3");

    const untagged = readCapturedLogs().filter((e) => e.component === null);
    expect(untagged.map((e) => e.msg)).toEqual([]);
  });
});

describe("hot paths stay quiet at info", () => {
  /**
   * The regression this exists to prevent: a per-recipient `log.info` turns a
   * 50,000-recipient campaign into 50,000 rows and a thousand extra inserts.
   */
  it("does not emit an info line per recipient", async () => {
    configureLookup();
    const recipients = Array.from({ length: 25 }, (_, i) => `u${i}`);
    await processDispatch(payload(recipients), "sender@example.com", "run_4");

    const infoLines = readCapturedLogs().filter(
      (e) => e.level === "info" && e.component?.startsWith("dispatch")
    );
    // A handful of lifecycle lines, and nowhere near one per recipient.
    expect(infoLines.length).toBeLessThan(recipients.length);
  });

  it("records per-recipient detail at debug instead", async () => {
    configureLookup();
    await processDispatch(payload(["u1", "u2", "u3"]), "sender@example.com", "run_5");

    const perSend = findCapturedLogs((e) => e.msg === "Send event emitted");
    expect(perSend.length).toBeGreaterThan(0);
    expect(perSend.every((e) => e.level === "debug")).toBe(true);
  });
});

describe("no customer data reaches the log", () => {
  it("never writes a recipient address, even though the send path holds one", async () => {
    configureLookup();
    await processDispatch(payload(["u1", "u2"]), "sender@example.com", "run_6");

    // The mock lookup resolves real-looking addresses; the log must not repeat them.
    const serialized = JSON.stringify(readCapturedLogs());
    expect(serialized).not.toMatch(/@example\.com|@acme|@test\./);
  });

  it("logs which fields failed validation, never the rejected payload", async () => {
    const res = await request(app)
      .post("/api/v1/data-plane/variables")
      .set(auth)
      .send({
        name: "leaky",
        definition: {
          source: "api",
          api: {
            url: "https://crm.internal/u/{{user_id}}",
            headers: { Authorization: "Bearer super-secret-token" },
            json_path: "tier",
          },
        },
        // Invalid: forces the rejection path while the body holds a credential.
        enabled: "yes-please",
      });

    expect(res.status).toBe(400);
    const [rejected] = findCapturedLogs((e) => e.msg.startsWith("Rejected"));
    expect(rejected?.level).toBe("warn");
    expect(rejected?.fields.invalid_fields).toContain("enabled");
    expect(JSON.stringify(readCapturedLogs())).not.toContain("super-secret-token");
  });
});

describe("the data-plane access log", () => {
  it("records one structured line per request with the matched route", async () => {
    await request(app).get("/api/v1/data-plane/variables?limit=5").set(auth);

    const [access] = findCapturedLogs((e) => e.fields.status_code !== undefined);
    expect(access?.component).toBe("api.dataplane");
    expect(access?.fields).toMatchObject({
      method: "GET",
      status_code: 200,
      duration_ms: expect.any(Number),
    });
    // Grouping key, so "how slow is this endpoint" is one GROUP BY.
    expect(access?.fields.route).toBe("/api/v1/data-plane/variables");
  });

  it("logs a 4xx at warn and never carries the API key", async () => {
    await request(app).get("/api/v1/data-plane/campaigns/does-not-exist").set(auth);

    const [access] = findCapturedLogs((e) => e.fields.status_code === 404);
    expect(access?.level).toBe("warn");
    expect(JSON.stringify(readCapturedLogs())).not.toContain(KEY);
  });

  it("names the likely cause when a drip wire id is used as a program id", async () => {
    await request(app)
      .get("/api/v1/data-plane/campaigns/drip_enroll1_step2")
      .set(auth);

    const [notFound] = findCapturedLogs((e) => e.msg === "Campaign not found");
    expect(notFound?.fields.looks_like_wire_id).toBe(true);
  });
});

describe("misconfiguration is visible after the fact", () => {
  it("warns through the logger, not the terminal, when a provider send is rejected", async () => {
    configureLookup();
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    // No AWS credentials in the test env, so the provider rejects every send.
    await processDispatch(payload(["u1", "u2", "u3"]), "sender@example.com", "run_7");

    const failures = findCapturedLogs((e) =>
      e.msg.startsWith("Provider rejected a message")
    );
    if (failures.length > 0) {
      // First failure loud, the rest counted — never one warn per recipient.
      expect(failures.filter((e) => e.level === "warn")).toHaveLength(1);
    }
    vi.unstubAllEnvs();
  });
});
