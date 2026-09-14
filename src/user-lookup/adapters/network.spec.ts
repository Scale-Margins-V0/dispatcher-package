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
      fields: { email: "email", first_name: "first_name" },
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
      fields: ["email", "first_name"],
    });
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
    stubFetch(ok({ users: [{ user_id: "u1", email: "a@x.com", first_name: "Ada" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1"]);
    expect(out.get("u1")).toEqual({
      user_id: "u1",
      email: "a@x.com",
      fields: { email: "a@x.com", first_name: "Ada" },
    });
  });

  it("keeps resolved users and skips the ones the client omitted", async () => {
    stubFetch(ok({ users: [{ user_id: "u2", email: "b@x.com" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1", "u2"]);
    expect([...out.keys()]).toEqual(["u2"]);
  });

  it("leaves a missing field undefined rather than failing the record", async () => {
    stubFetch(ok({ users: [{ user_id: "u1", email: "a@x.com" }] }));
    const out = await new NetworkAdapter(config()).lookupUsers(["u1"]);
    expect(out.get("u1")!.fields.first_name).toBeUndefined();
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

  it("drops a record with no email, as every other backend does", async () => {
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
