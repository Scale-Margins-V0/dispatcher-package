/**
 * `evaluateComputedExpression` / `personalize`: per-user rendering, several template shapes, custom registry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateComputedExpression,
  personalize,
} from "./personalize.js";
import type { UserRecord } from "./user-lookup/types.js";
import {
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

  it("reads env.*", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://ex.com/unsub");
    const u = baseUser();
    expect(
      evaluateComputedExpression("env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id", u)
    ).toBe("https://ex.com/unsub?uid=u-1");
    vi.unstubAllEnvs();
  });

  it("rejects eval-like input", () => {
    const u = baseUser();
    expect(() => evaluateComputedExpression("eval('x')", u)).toThrow();
  });
});

describe("personalize", () => {
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
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://ex.com/u");
    const u = baseUser();
    expect(personalize("{{full_name}} {{unsubscribe_url}}", u)).toBe(
      "Ada Lovelace https://ex.com/u?uid=u-1"
    );
    vi.unstubAllEnvs();
  });

  it("same template string yields different output per user (multi-recipient style)", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://brand.example/unsub");
    const tpl =
      "{{first_name}} | {{company_name}} | {{unsubscribe_url}}";
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
    expect(personalize(tpl, alice)).toBe(
      "Ada | Analytical | https://brand.example/unsub?uid=u-1"
    );
    expect(personalize(tpl, bob)).toBe(
      "Bob | Fix-It Co | https://brand.example/unsub?uid=acct-b"
    );
    vi.unstubAllEnvs();
  });

  it("multiple template shapes for one user (subject vs html vs computed)", () => {
    vi.stubEnv("UNSUBSCRIBE_URL_BASE", "https://go.example/u");
    const u = baseUser();
    expect(personalize("Dear {{last_name}} family", u)).toBe(
      "Dear Lovelace family"
    );
    expect(personalize("<p>{{email}}</p><a href=\"{{unsubscribe_url}}\">opt out</a>", u)).toContain(
      "a@b.com"
    );
    expect(
      personalize("<p>{{email}}</p><a href=\"{{unsubscribe_url}}\">opt out</a>", u)
    ).toContain("https://go.example/u?uid=u-1");
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
