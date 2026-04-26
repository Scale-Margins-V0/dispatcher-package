/**
 * `HttpAdapter` with stubbed `global.fetch`: request shape, bearer header, 4xx no-retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDispatchConfig } from "../config.js";
import { HttpAdapter } from "./http.js";

const httpCfg = parseDispatchConfig({
  user_lookup: {
    backend: "http",
    fields: { email: "email" },
    http: {
      base_url: "https://api.test",
      path: "/v1/users",
      method: "POST",
      auth: { type: "bearer", token_env: "PROFILE_API_TOKEN" },
      request: { id_field: "user_ids" },
      response: { root: "users", id_field: "id" },
      timeout_ms: 800,
      retries: 2,
    },
  },
  placeholders: {},
});

describe("HttpAdapter", () => {
  beforeEach(() => {
    process.env.PROFILE_API_TOKEN = "secret-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          users: [{ id: "1", email: "a@b.com" }],
        }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROFILE_API_TOKEN;
  });

  it("POSTs JSON body with bearer auth and maps users", async () => {
    const a = new HttpAdapter(httpCfg);
    const m = await a.lookupUsers(["1"]);
    expect(m.size).toBe(1);
    expect(m.get("1")?.email).toBe("a@b.com");
    expect(fetch).toHaveBeenCalled();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/v1/users");
    expect(init?.method).toBe("POST");
    const rawHeaders = init?.headers;
    const auth =
      rawHeaders instanceof Headers
        ? rawHeaders.get("Authorization")
        : (rawHeaders as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer secret-token");
    expect(JSON.parse(init?.body as string)).toEqual({ user_ids: ["1"] });
  });

  it("does not retry on 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    } as Response);
    const a = new HttpAdapter(httpCfg);
    const m = await a.lookupUsers(["1"]);
    expect(m.size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
