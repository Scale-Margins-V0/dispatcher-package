/**
 * The network adapter's contract with a client's API. The cases that matter are
 * the ungenerous ones: a partial response, an id we never asked about, a
 * numeric id where we sent a string, and a chunk that fails outright.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchConfig } from "../config.js";
import { NetworkAdapter } from "./network.js";

const URL = "https://api.example.com/lookup";

function config(over: Partial<DispatchConfig["user_lookup"]> = {}): DispatchConfig {
  return {
    user_lookup: {
      backend: "http",
      fields: { email: "email" },
      network: { url: URL, token: "secret-token", timeout_ms: 50, retries: 2 },
      ...over,
    },
    placeholders: {},
  } as DispatchConfig;
}

/** Queue one outcome per expected call. */
function stubFetch(...outcomes: Array<Response | Error>) {
  const fn = vi.fn();
  for (const o of outcomes) {
    if (o instanceof Error) fn.mockRejectedValueOnce(o);
    else fn.mockResolvedValueOnce(o);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number) => new Response("", { status: code });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.restoreAllMocks());

describe("the request", () => {
  it("sends user_ids and the field list, with the bearer token", async () => {
    const fetchMock = stubFetch(ok({ users: [] }));
    await new NetworkAdapter(config()).lookupUsers(["u1", "u2"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body)).toEqual({
      user_ids: ["u1", "u2"],
      channel: "email",
      fields: ["email"],
    });
  });

  // The response is read by the client's names, so the request must use them
  // too. Asking with the logical key resolved nothing for `phone: phone_no`.
  it("asks for the client's field names, and reads them back", async () => {
    const fetchMock = stubFetch(ok({ users: [{ user_id: "u1", email_address: "a@x.com" }] }));
    const out = await new NetworkAdapter(
      config({ fields: { email: "email_address" } })
    ).lookupUsers(["u1"]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).fields).toEqual(["email_address"]);
    expect(out.get("u1")!.fields).toEqual({ email: "a@x.com" });
  });

  it("reads the token from token_env when there is no inline token", async () => {
    vi.stubEnv("LOOKUP_TOKEN", "from-env");
    const fetchMock = stubFetch(ok({ users: [] }));
    await new NetworkAdapter(
      config({ network: { url: URL, token_env: "LOOKUP_TOKEN", timeout_ms: 50, retries: 0 } })
    ).lookupUsers(["u1"]);
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer from-env");
    vi.unstubAllEnvs();
  });

  it("makes no request at all for an empty batch", async () => {
    const fetchMock = stubFetch();
    expect(await new NetworkAdapter(config()).lookupUsers([])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates ids before asking", async () => {
    const fetchMock = stubFetch(ok({ users: [] }));
    await new NetworkAdapter(config()).lookupUsers(["u1", "u1", "u2"]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).user_ids).toEqual(["u1", "u2"]);
  });

  it("splits into chunks of max_ids_per_query", async () => {
    const fetchMock = stubFetch(ok({ users: [] }), ok({ users: [] }));
    await new NetworkAdapter(
      config({ batch: { max_ids_per_query: 2, dedupe: true } })
    ).lookupUsers(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).user_ids).toEqual(["c"]);
  });
});

describe("the response", () => {
  it("maps records through the fields map", async () => {
    stubFetch(ok({ users: [{ user_id: "u1", email: "a@x.com" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1"]);
    expect(out.get("u1")).toEqual({
      user_id: "u1",
      email: "a@x.com",
      fields: { email: "a@x.com" },
    });
  });

  it("keeps resolved users and skips the ones the client omitted", async () => {
    stubFetch(ok({ users: [{ user_id: "u2", email: "b@x.com" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1", "u2"]);
    expect([...out.keys()]).toEqual(["u2"]);
  });


  // Compared as strings: a JSON number is a serializer quirk, not a different
  // user. This is a widening and cannot drop anyone — unlike the int/uuid
  // coercion the SQL path needs, which fails closed on a bad value.
  it("matches a JSON number against the string id we sent", async () => {
    stubFetch(ok({ users: [{ user_id: 42, email: "a@x.com" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["42"]);
    expect(out.get("42")?.email).toBe("a@x.com");
  });

  it("still refuses an id that is genuinely different", async () => {
    stubFetch(ok({ users: [{ user_id: "u9", email: "a@x.com" }] }));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
  });

  it("ignores a record for an id we never asked about", async () => {
    stubFetch(ok({ users: [{ user_id: "someone-else", email: "x@x.com" }] }));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
  });

  it("an email lookup drops a record with no email, as every backend does", async () => {
    stubFetch(ok({ users: [{ user_id: "u1", first_name: "Ada" }] }));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
  });

  it("drops a record with no user_id", async () => {
    stubFetch(ok({ users: [{ email: "a@x.com" }] }));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
  });

  it("ignores extra keys the client sends", async () => {
    stubFetch(ok({ users: [{ user_id: "u1", email: "a@x.com", internal_id: 9 }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1"]);
    expect(out.get("u1")!.fields).not.toHaveProperty("internal_id");
  });

  it("treats a missing users key as an empty result", async () => {
    stubFetch(ok({}));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
  });
});

describe("failure handling", () => {
  it("does not retry a 4xx — a bad request or credential cannot fix itself", async () => {
    const fetchMock = stubFetch(status(401));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and uses the eventual success", async () => {
    const fetchMock = stubFetch(status(503), ok({ users: [{ user_id: "u1", email: "a@x.com" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.has("u1")).toBe(true);
  });

  it("gives up after retries are exhausted", async () => {
    const fetchMock = stubFetch(status(500), status(500), status(500));
    expect(await new NetworkAdapter(config()).lookupUsers(["u1"])).toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a network error", async () => {
    const fetchMock = stubFetch(new Error("ECONNREFUSED"), ok({ users: [] }));
    await new NetworkAdapter(config()).lookupUsers(["u1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("survives malformed JSON", async () => {
    stubFetch(new Response("not json", { status: 200 }));
    expect(
      await new NetworkAdapter(
        config({ network: { url: URL, token: "t", timeout_ms: 50, retries: 0 } })
      ).lookupUsers(["u1"])
    ).toEqual(new Map());
  });

  // A campaign is not lost because one chunk of a thousand failed.
  it("keeps the users from chunks that did succeed", async () => {
    stubFetch(status(500), status(500), status(500), ok({ users: [{ user_id: "b", email: "b@x.com" }] }));
    const out = await new NetworkAdapter(
      config({ batch: { max_ids_per_query: 1, dedupe: true } })
    ).lookupUsers(["a", "b"]);
    expect([...out.keys()]).toEqual(["b"]);
  });
});

describe("the channel", () => {
  const both = { fields: { email: "email", phone: "phone_no" } };

  it("an email lookup asks for the address, never the phone", async () => {
    const fetchMock = stubFetch(ok({ users: [] }));
    await new NetworkAdapter(config(both)).lookupUsers(["u1"], "email");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.channel).toBe("email");
    expect(body.fields).toEqual(["email"]);
  });

  it("a WhatsApp lookup asks for the phone, never the address", async () => {
    const fetchMock = stubFetch(ok({ users: [] }));
    await new NetworkAdapter(config(both)).lookupUsers(["u1"], "whatsapp");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.channel).toBe("whatsapp");
    expect(body.fields).toEqual(["phone_no"]);
  });

  // Requiring an email here dropped everyone who only has a phone.
  it("keeps a WhatsApp recipient who has no email", async () => {
    stubFetch(ok({ users: [{ user_id: "u1", phone_no: "+447700900000" }] }));
    const out = await new NetworkAdapter(config(both)).lookupUsers(["u1"], "whatsapp");
    expect(out.get("u1")).toEqual({
      user_id: "u1",
      email: "",
      fields: { phone: "+447700900000" },
    });
  });

  it("drops a WhatsApp recipient with no phone", async () => {
    stubFetch(ok({ users: [{ user_id: "u1", first_name: "Ada" }] }));
    expect(await new NetworkAdapter(config(both)).lookupUsers(["u1"], "whatsapp")).toEqual(
      new Map()
    );
  });
});
