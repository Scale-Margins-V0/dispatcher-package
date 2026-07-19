/**
 * End-to-end onsite flow against a real in-memory state DB, per the ScaleMargin
 * contract: issue (via the dispatch-time issuer) → redeem (nonce binding:
 * idempotent / 409 / 410) → session (cookie + page_key, 204 when none) →
 * receipt (impression/click/dismiss). Cookies are threaded manually because the
 * __Host- cookie is Secure and superagent won't resend it over http.
 */
import express, { type Express } from "express";
import request, { type Response } from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import { prepareOnsite } from "./issue.js";
import { registerOnsiteRoutes } from "./routes.js";
import type { OnsiteConfigInput } from "./types.js";

const PRIOR_KEY = process.env.ONSITE_STATE_ENCRYPTION_KEY;

let dbx: DispatcherDb;
let app: Express;

const identity = (s: string): string => s.replaceAll("{{first_name}}", "Ada");

const config = (assignmentOver?: Record<string, unknown>): OnsiteConfigInput =>
  ({
    schema_version: 1,
    site_key: `onsite_pk_${"a".repeat(32)}`,
    landing_url: "https://go.example/o",
    template_id: "tpl_1",
    template_revision: 3,
    placement: "corner",
    offer_fields: ["first_name"],
    attribution: { source: "sm", medium: "email" },
    template: {
      content: {
        title: "Hi {{first_name}}",
        body: "Your reward",
        cta: { label: "Claim", url: "https://shop.example/{{first_name}}" },
      },
      theme: {
        preset: "light",
        accent: "#ff0000",
        surface: "#ffffff",
        text: "#111111",
        radius: "md",
      },
    },
    assignments: {
      usr_1: {
        decision_id: "dec_1",
        offer_ref: "offer_a",
        offer_version: "2",
        analytics_token: `osa_${"a".repeat(43)}`,
        starts_at: "2026-07-01T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        ...assignmentOver,
      },
    },
  } as unknown as OnsiteConfigInput);

/** Issue one activation through the real dispatch-time path; return its token. */
async function issueOne(
  assignmentOver?: Record<string, unknown>
): Promise<string> {
  const issuer = await prepareOnsite({
    campaign_id: "cmp_onsite",
    dispatch_ids: { usr_1: "touch_1" },
    content: { html_body: '<a href="{{onsite_url}}">go</a>' },
    metadata: { organization_id: "org_1", onsite: config(assignmentOver) },
  });
  if (!issuer) throw new Error("expected an onsite issuer");
  const url = await issuer.issue({
    userId: "usr_1",
    channel: "email",
    now: new Date(),
    personalizeString: identity,
  });
  await issuer.flush();
  if (!url) throw new Error("expected an onsite url");
  return new URL(url).hash.replace(/^#sm_t=/, "");
}

/** Extract the "name=value" cookie pair from a Set-Cookie response header. */
function cookiePair(res: Response): string {
  const setCookie = res.headers["set-cookie"] as unknown as
    | string[]
    | undefined;
  if (!setCookie?.[0]) throw new Error("expected a Set-Cookie header");
  return setCookie[0].split(";")[0]!;
}

beforeAll(() => {
  process.env.ONSITE_STATE_ENCRYPTION_KEY =
    "routes-integration-onsite-key-0123456789";
});

afterAll(() => {
  if (PRIOR_KEY === undefined) delete process.env.ONSITE_STATE_ENCRYPTION_KEY;
  else process.env.ONSITE_STATE_ENCRYPTION_KEY = PRIOR_KEY;
});

beforeEach(async () => {
  dbx = await createTestDb();
  app = express();
  registerOnsiteRoutes(app);
});

afterEach(() => {
  destroyTestDb(dbx);
});

const NONCE_A = "nonceA-1234567890";
const NONCE_B = "nonceB-1234567890";

const redeemBody = (token: string, nonce: string) => ({
  activation_token: token,
  visitor_nonce: nonce,
  page_key: "pk1",
  consent_version: "v1",
});

describe("onsite redeem", () => {
  it("binds the nonce, sets __Host-sm_as, and returns the exact envelope", async () => {
    const token = await issueOne();
    const res = await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(200);

    const setCookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(setCookie).toContain("__Host-sm_as=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");

    expect(res.body).toMatchObject({
      schema_version: 1,
      decision_id: "dec_1",
      placement: "corner",
      analytics_token: `osa_${"a".repeat(43)}`,
      template: {
        id: "tpl_1",
        revision: 3,
        content: {
          title: "Hi Ada",
          body: "Your reward",
          cta: { label: "Claim", url: "https://shop.example/Ada" },
        },
        theme: {
          preset: "light",
          accent: "#ff0000",
          surface: "#ffffff",
          text: "#111111",
          radius: "md",
        },
      },
    });
    expect(typeof res.body.activation_id).toBe("string");
    expect(res.body.touch_id).toBe("touch_1");
    expect(res.body.expires_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("is idempotent for the same nonce and 409s a different nonce", async () => {
    const token = await issueOne();
    await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(200);
    // Different browser → conflict.
    await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_B))
      .expect(409);
    // Original browser can still redeem — binding is idempotent.
    await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(200);
  });

  it("410s an expired activation", async () => {
    const token = await issueOne();
    const activations = tableFor(dbx, "onsiteActivations");
    await queryDb(dbx)
      .update(activations)
      .set({ expires_at: new Date("2000-01-01T00:00:00.000Z") });
    await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(410);
  });

  it("returns 204 before an activation becomes eligible", async () => {
    const token = await issueOne();
    const activations = tableFor(dbx, "onsiteActivations");
    await queryDb(dbx)
      .update(activations)
      .set({ starts_at: new Date("2098-01-01T00:00:00.000Z") });
    await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(204);
  });

  it("404s an unknown token", async () => {
    await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody("this-token-does-not-exist-1234567890", NONCE_A))
      .expect(404);
  });

  it("400s a malformed body", async () => {
    await request(app)
      .post("/api/onsite/redeem")
      .send({ activation_token: "x" })
      .expect(400);
  });
});

describe("onsite session", () => {
  it("returns the envelope for the cookie + matching page_key, 204 otherwise", async () => {
    const token = await issueOne();
    const redeem = await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(200);
    const cookie = cookiePair(redeem);

    const ok = await request(app)
      .get("/api/onsite/session")
      .query({ page_key: "pk1" })
      .set("Cookie", cookie)
      .expect(200);
    expect(ok.body.template.content.title).toBe("Hi Ada");

    // Wrong page_key → nothing to show.
    await request(app)
      .get("/api/onsite/session")
      .query({ page_key: "other" })
      .set("Cookie", cookie)
      .expect(204);

    // No cookie → nothing to show.
    await request(app)
      .get("/api/onsite/session")
      .query({ page_key: "pk1" })
      .expect(204);
  });

  it("400s when page_key is missing", async () => {
    await request(app).get("/api/onsite/session").expect(400);
  });
});

describe("onsite receipt", () => {
  it("records impression/click/dismiss idempotently and rejects mismatches", async () => {
    const token = await issueOne();
    const redeem = await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(200);
    const cookie = cookiePair(redeem);
    const activationId = redeem.body.activation_id as string;

    const body = {
      activation_id: activationId,
      receipt_id: "rcpt_1",
      type: "impression",
      occurred_at: "2026-07-19T12:00:00.000Z",
    };
    const first = await request(app)
      .post("/api/onsite/receipt")
      .set("Cookie", cookie)
      .send(body)
      .expect(201);
    expect(first.body).toEqual({ ok: true, receipt_id: "rcpt_1" });
    // Idempotent retry with the same receipt_id.
    await request(app)
      .post("/api/onsite/receipt")
      .set("Cookie", cookie)
      .send(body)
      .expect(201);

    // Wrong activation_id for this session → 409.
    await request(app)
      .post("/api/onsite/receipt")
      .set("Cookie", cookie)
      .send({ ...body, activation_id: "someone_else", receipt_id: "rcpt_2" })
      .expect(409);

    // No cookie → 401.
    await request(app).post("/api/onsite/receipt").send(body).expect(401);
  });

  it("400s an invalid receipt type", async () => {
    const token = await issueOne();
    const redeem = await request(app)
      .post("/api/onsite/redeem")
      .send(redeemBody(token, NONCE_A))
      .expect(200);
    const cookie = cookiePair(redeem);
    await request(app)
      .post("/api/onsite/receipt")
      .set("Cookie", cookie)
      .send({
        activation_id: redeem.body.activation_id,
        receipt_id: "r",
        type: "converted",
        occurred_at: "2026-07-19T12:00:00.000Z",
      })
      .expect(400);
  });
});

describe("onsite disabled", () => {
  it("404s every route when ONSITE_STATE_ENCRYPTION_KEY is unset", async () => {
    delete process.env.ONSITE_STATE_ENCRYPTION_KEY;
    try {
      await request(app)
        .post("/api/onsite/redeem")
        .send(redeemBody("a", "b"))
        .expect(404);
      await request(app)
        .get("/api/onsite/session")
        .query({ page_key: "pk1" })
        .expect(404);
      await request(app)
        .post("/api/onsite/receipt")
        .send({
          activation_id: "a",
          receipt_id: "r",
          type: "click",
          occurred_at: "2026-07-19T12:00:00.000Z",
        })
        .expect(404);
    } finally {
      process.env.ONSITE_STATE_ENCRYPTION_KEY =
        "routes-integration-onsite-key-0123456789";
    }
  });
});
