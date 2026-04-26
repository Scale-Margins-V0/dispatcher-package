/**
 * Binds `createHttpProfileMockApp` on an ephemeral port; exercises `HttpAdapter` with real `fetch`.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpProfileMockApp } from "../../devtools/http-profile-mock-app.js";
import { parseDispatchConfig } from "../config.js";
import { HttpAdapter } from "./http.js";

const mockEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PROFILE_MOCK_PATH: "/v1/users:batchGet",
  PROFILE_MOCK_REQUEST_FIELD: "user_ids",
  PROFILE_MOCK_RESPONSE_ROOT: "users",
  PROFILE_MOCK_RESPONSE_ID_FIELD: "id",
  PROFILE_MOCK_TOKEN: "integration-http-mock-token",
};

describe("HttpAdapter against http-profile-mock app", () => {
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  const prevToken = process.env.PROFILE_API_TOKEN;

  beforeAll(async () => {
    process.env.PROFILE_API_TOKEN = mockEnv.PROFILE_MOCK_TOKEN;
    const app = createHttpProfileMockApp(mockEnv);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (prevToken === undefined) {
      delete process.env.PROFILE_API_TOKEN;
    } else {
      process.env.PROFILE_API_TOKEN = prevToken;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("resolves fixture users over real HTTP (same app as dev:http-profile-mock)", async () => {
    const cfg = parseDispatchConfig({
      user_lookup: {
        backend: "http",
        fields: { email: "email" },
        http: {
          base_url: baseUrl,
          path: "/v1/users:batchGet",
          method: "POST",
          auth: { type: "bearer", token_env: "PROFILE_API_TOKEN" },
          request: { id_field: "user_ids" },
          response: { root: "users", id_field: "id" },
          timeout_ms: 5000,
          retries: 1,
        },
      },
      placeholders: {},
    });

    const adapter = new HttpAdapter(cfg);
    const m = await adapter.lookupUsers([
      "sm-001",
      "missing-user-xyz",
      "sm-002",
    ]);

    expect(m.size).toBe(2);
    expect(m.get("sm-001")?.email).toBe("nikhil.singh@example.com");
    expect(m.get("sm-002")?.email).toBe("priya.sharma@example.com");
    expect(m.has("missing-user-xyz")).toBe(false);
  });

  it("returns empty map when bearer token env is unset (mock responds 401)", async () => {
    const cfg = parseDispatchConfig({
      user_lookup: {
        backend: "http",
        fields: { email: "email" },
        http: {
          base_url: baseUrl,
          path: "/v1/users:batchGet",
          method: "POST",
          auth: {
            type: "bearer",
            token_env: "PROFILE_API_TOKEN_INTENTIONALLY_UNSET",
          },
          request: { id_field: "user_ids" },
          response: { root: "users", id_field: "id" },
          timeout_ms: 5000,
          retries: 0,
        },
      },
      placeholders: {},
    });

    const adapter = new HttpAdapter(cfg);
    const m = await adapter.lookupUsers(["sm-001"]);
    expect(m.size).toBe(0);
  });
});
