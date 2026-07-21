/**
 * `evaluateComputedExpression` / `personalize`: per-user rendering, several template shapes, custom registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateComputedExpression,
  personalize,
} from "./personalize.js";
import type { UserRecord } from "./user-lookup/types.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  parseDispatchConfig,
  resetDispatchConfigForTests,
  setDispatchConfigForTests,
} from "./user-lookup/config.js";

const baseUser = (): UserRecord => ({
  user_id: "u-1",
  email: "a@b.com",
  fields: {
    first_name: "Ada",
    last_name: "Lovelace",
    company_name: "Analytical",
    email: "a@b.com",
  },
});

describe("evaluateComputedExpression", () => {
  it("concatenates fields and literals", () => {
    const u = baseUser();
    expect(evaluateComputedExpression("first_name + ' ' + last_name", u)).toBe(
      "Ada Lovelace"
    );
  });

  it("derives env.UNSUBSCRIBE_URL_BASE / env.PREFERENCES_URL_BASE from UNSUBSCRIBE_URL_BASE host", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://tunnel.example/dispatch");
    const u = baseUser();
    expect(
      evaluateComputedExpression("env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id", u)
    ).toBe("https://tunnel.example/dispatch/api/unsubscribe?uid=u-1");
    expect(
      evaluateComputedExpression("env.PREFERENCES_URL_BASE + '?uid=' + user_id", u)
    ).toBe("https://tunnel.example/dispatch/api/preferences?uid=u-1");
    vi.unstubAllEnvs();
  });

  it("includes campaign_id and organization_id when dispatch context is provided", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://tunnel.example/dispatch");
    const u = baseUser();
    expect(
      evaluateComputedExpression(
        "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id",
        u,
        { campaign_id: "cmp_9", organization_id: "org_9" }
      )
    ).toBe(
      "https://tunnel.example/dispatch/api/unsubscribe?uid=u-1&campaign_id=cmp_9&organization_id=org_9"
    );
    vi.unstubAllEnvs();
  });

  it("rejects eval-like input", () => {
    const u = baseUser();
    expect(() => evaluateComputedExpression("eval('x')", u)).toThrow();
  });

  it("trims a trailing slash on UNSUBSCRIBE_URL_BASE before appending the API path", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://tunnel.example/dispatch/");
    const u = baseUser();
    expect(evaluateComputedExpression("env.UNSUBSCRIBE_URL_BASE", u)).toBe(
      "https://tunnel.example/dispatch/api/unsubscribe"
    );
    vi.unstubAllEnvs();
  });

  it("prefers UNSUBSCRIBE_LINK_URL / PREFERENCES_LINK_URL overrides over derived paths", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://tunnel.example/dispatch");
    vi.stubEnv("UNSUBSCRIBE_LINK_URL", "https://other-host.example/unsub");
    vi.stubEnv("PREFERENCES_LINK_URL", "https://other-host.example/prefs");
    const u = baseUser();
    expect(evaluateComputedExpression("env.UNSUBSCRIBE_URL_BASE", u)).toBe(
      "https://other-host.example/unsub"
    );
    expect(evaluateComputedExpression("env.PREFERENCES_URL_BASE", u)).toBe(
      "https://other-host.example/prefs"
    );
    vi.unstubAllEnvs();
  });
});

describe("personalize", () => {
  beforeEach(() => {
    setDispatchConfigForTests(DEFAULT_DISPATCH_CONFIG);
  });

  afterEach(() => {
    resetDispatchConfigForTests();
    vi.unstubAllEnvs();
  });

  it("renders built-in tokens with defaults", () => {
    const u = baseUser();
    const html = "Hi {{first_name}} {{last_name}} — {{company_name}} {{email}}";
    expect(personalize(html, u)).toBe(
      "Hi Ada Lovelace — Analytical a@b.com"
    );
  });

  it("renders full_name and unsubscribe_url", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://ex.com");
    const u = baseUser();
    const ctx = { campaign_id: "cmp_1", organization_id: "org_1" };
    expect(personalize("{{full_name}} {{unsubscribe_url}}", u, ctx)).toBe(
      "Ada Lovelace https://ex.com/api/unsubscribe?uid=u-1&campaign_id=cmp_1&organization_id=org_1"
    );
    vi.unstubAllEnvs();
  });

  it("same template string yields different output per user (multi-recipient style)", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://brand.example");
    const tpl =
      "{{first_name}} | {{company_name}} | {{unsubscribe_url}}";
    const ctx = { campaign_id: "cmp_2", organization_id: "org_2" };
    const alice = baseUser();
    const bob: UserRecord = {
      user_id: "acct-b",
      email: "bob@example.com",
      fields: {
        first_name: "Bob",
        last_name: "Builder",
        company_name: "Fix-It Co",
        email: "bob@example.com",
      },
    };
    expect(personalize(tpl, alice, ctx)).toBe(
      "Ada | Analytical | https://brand.example/api/unsubscribe?uid=u-1&campaign_id=cmp_2&organization_id=org_2"
    );
    expect(personalize(tpl, bob, ctx)).toBe(
      "Bob | Fix-It Co | https://brand.example/api/unsubscribe?uid=acct-b&campaign_id=cmp_2&organization_id=org_2"
    );
    vi.unstubAllEnvs();
  });

  it("multiple template shapes for one user (subject vs html vs computed)", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://go.example");
    const u = baseUser();
    const ctx = { campaign_id: "cmp_3", organization_id: "org_3" };
    expect(personalize("Dear {{last_name}} family", u)).toBe(
      "Dear Lovelace family"
    );
    expect(
      personalize("<p>{{email}}</p><a href=\"{{unsubscribe_url}}\">opt out</a>", u, ctx)
    ).toContain("a@b.com");
    expect(
      personalize("<p>{{email}}</p><a href=\"{{unsubscribe_url}}\">opt out</a>", u, ctx)
    ).toContain(
      "https://go.example/api/unsubscribe?uid=u-1&campaign_id=cmp_3&organization_id=org_3"
    );
    vi.unstubAllEnvs();
  });

  it("supports YAML-only custom placeholder when registry is extended", () => {
    const custom = parseDispatchConfig({
      user_lookup: {
        backend: "mock",
        fields: {
          email: "email",
          job_title: "job_title",
        },
      },
      placeholders: {
        email: { source: "field", field: "email" },
        job_title: { source: "field", field: "job_title", fallback: "" },
      },
    });
    setDispatchConfigForTests(custom);

    const u: UserRecord = {
      user_id: "1",
      email: "x@y.com",
      fields: { job_title: "VP Eng" },
    };
    expect(personalize("Role: {{job_title}}", u)).toBe("Role: VP Eng");
  });
});
