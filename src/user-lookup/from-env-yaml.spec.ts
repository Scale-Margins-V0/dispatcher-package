/**
 * Network mode looks up contact details only. A leftover personalization key in
 * `fields:` is dropped with a warning — it must never stop a boot.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logging/logger.js", () => ({
  componentLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const { dispatchConfigFromEnvYaml } = await import("./from-env-yaml.js");
const { userLookupSchema } = await import("./schema.js");

const network = (fields: Record<string, string>) =>
  userLookupSchema.parse({
    mode: "network",
    network: { url: "https://api.example.com/lookup", token: "t" },
    fields,
  });

beforeEach(() => warn.mockClear());

describe("network mode fields", () => {
  it("keeps email and phone, drops the rest, and warns once naming them", () => {
    const cfg = dispatchConfigFromEnvYaml(
      network({ email: "email_address", phone: "mobile", first_name: "given_name", city: "city" })
    );
    expect(cfg.user_lookup.fields).toEqual({ email: "email_address", phone: "mobile" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ ignored_fields: ["first_name", "city"] });
  });

  it("stays quiet when only contact fields are mapped", () => {
    const cfg = dispatchConfigFromEnvYaml(network({ email: "email" }));
    expect(cfg.user_lookup.fields).toEqual({ email: "email" });
    expect(warn).not.toHaveBeenCalled();
  });
});
