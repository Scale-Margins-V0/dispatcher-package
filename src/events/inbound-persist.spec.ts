import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import type { DispatcherDb } from "../db/client.js";
import { listCampaignEvents } from "../db/repos/campaign-events.js";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import type { InboundEventAdapter, StandardizedEvent } from "./common/types.js";
import { loadEventsConfigFromYaml } from "./config.js";
import {
  createInboundWebhookHandler,
  resetEventPipelineForTests,
  setEventsConfigForTests,
} from "./index.js";

const yaml = `
events:
  forward:
    mode: sync
    batch_size: 10
    batch_interval_ms: 1000
  delivery:
    mode: best_effort
    buffer:
      kind: memory
      max_events_memory: 50
  providers:
    sendgrid:
      enabled: true
      signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
    ses:
      enabled: true
    gupshup:
      enabled: true
      secret_env: GUPSHUP_WEBHOOK_SECRET
`;

/** Minimal adapter: every parsed item is one correlated "delivered" event. */
const stubAdapter: InboundEventAdapter = {
  name: "ses",
  channel: "email",
  verifySignature: () => true,
  parseEvents: (raw) => JSON.parse(raw.toString("utf8")) as unknown[],
  extractCorrelation: (item) => {
    const record = item as Record<string, string>;
    return {
      campaign_id: record.campaign_id,
      user_id: record.user_id,
      organization_id: record.organization_id,
    };
  },
  stripPii: (item) => item as Record<string, unknown>,
  toStandardEvent: (item, correlation): StandardizedEvent => {
    const record = item as Record<string, string>;
    return {
      ...correlation,
      channel: "email",
      event: "delivered",
      provider: "ses",
      provider_message_id: record.message_id ?? "msg-stub",
      occurred_at: "2026-07-12T09:00:00.000Z",
    };
  },
};

function mockReqRes(bodyItems: unknown[]): { req: Request; res: Response; result: () => number } {
  let statusCode = 0;
  const req = {
    body: Buffer.from(JSON.stringify(bodyItems), "utf8"),
    headers: {},
  } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  return { req, res, result: () => statusCode };
}

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
  resetEventPipelineForTests();
  setEventsConfigForTests(loadEventsConfigFromYaml(yaml));
});

afterEach(() => {
  resetEventPipelineForTests();
  destroyTestDb(dbx);
});

describe("inbound webhook persistence", () => {
  it("persists correlated events with NO callback URL instead of dropping them", async () => {
    const handler = createInboundWebhookHandler(stubAdapter, true);
    const { req, res, result } = mockReqRes([
      { campaign_id: "cmp_nb", user_id: "u1", organization_id: "org_1", message_id: "m-1" },
      { campaign_id: "cmp_nb", user_id: "u2", organization_id: "org_1", message_id: "m-2" },
    ]);
    await handler(req, res, () => {});
    expect(result()).toBe(200);

    // Console store has both events…
    const page = await listCampaignEvents({ campaign_id: "cmp_nb", limit: 10 });
    expect(page.events.map((e) => e.user_id).sort()).toEqual(["u1", "u2"]);
    expect(page.events[0].event).toBe("delivered");

    // …while nothing was enqueued for forwarding (no callback URL anywhere).
    const outbox = tableFor(dbx, "eventOutbox");
    const outboxRows: unknown[] = await queryDb(dbx).select().from(outbox);
    expect(outboxRows).toHaveLength(0);
  });

  it("replayed webhooks stay single rows in the console store", async () => {
    const handler = createInboundWebhookHandler(stubAdapter, true);
    const items = [
      { campaign_id: "cmp_nb", user_id: "u1", organization_id: "org_1", message_id: "m-1" },
    ];
    const first = mockReqRes(items);
    await handler(first.req, first.res, () => {});
    const second = mockReqRes(items);
    await handler(second.req, second.res, () => {});

    const page = await listCampaignEvents({ campaign_id: "cmp_nb", limit: 10 });
    expect(page.events).toHaveLength(1);
  });
});
