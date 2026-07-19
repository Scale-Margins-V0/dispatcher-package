import { describe, expect, it } from "vitest";
import { onsiteEnvelopeSchema, parseOnsiteConfig } from "./types.js";

const validConfig = () => ({
  schema_version: 1,
  site_key: `onsite_pk_${"a".repeat(32)}`,
  landing_url: "https://go.example/o",
  template_id: "tpl_1",
  template_revision: 3,
  placement: "corner",
  offer_fields: ["first_name", "code"],
  attribution: { source: "sm", medium: "email" },
  template: {
    content: {
      title: "Hi {{first_name}}",
      body: "Use {{code}}",
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
      starts_at: "2026-07-19T00:00:00.000Z",
      expires_at: "2026-07-26T00:00:00.000Z",
    },
  },
});

describe("parseOnsiteConfig", () => {
  it("accepts a full valid config", () => {
    const result = parseOnsiteConfig(validConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.assignments.usr_1!.decision_id).toBe("dec_1");
      expect(result.config.offer_fields).toEqual(["first_name", "code"]);
    }
  });

  it("defaults offer_fields and attribution when omitted", () => {
    const cfg = validConfig() as Record<string, unknown>;
    delete cfg.offer_fields;
    delete cfg.attribution;
    const result = parseOnsiteConfig(cfg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.offer_fields).toEqual([]);
      expect(result.config.attribution).toEqual({});
    }
  });

  it("rejects a non-http landing_url", () => {
    const cfg = { ...validConfig(), landing_url: "javascript:alert(1)" };
    expect(parseOnsiteConfig(cfg).ok).toBe(false);
  });

  it("rejects an assignment with a bad datetime", () => {
    const cfg = validConfig();
    cfg.assignments.usr_1!.starts_at = "not-a-date";
    expect(parseOnsiteConfig(cfg).ok).toBe(false);
  });

  it("rejects unknown top-level keys (strict) so typos fail closed", () => {
    const cfg = { ...validConfig(), secret: "x" };
    expect(parseOnsiteConfig(cfg).ok).toBe(false);
  });

  it("rejects a missing template", () => {
    const cfg = validConfig() as Record<string, unknown>;
    delete cfg.template;
    expect(parseOnsiteConfig(cfg).ok).toBe(false);
  });
});

describe("onsiteEnvelopeSchema", () => {
  it("accepts the exact envelope shape and rejects a non-http cta url", () => {
    const envelope = {
      schema_version: 1,
      activation_id: "act_1",
      decision_id: "dec_1",
      touch_id: "touch_1",
      placement: "corner",
      expires_at: "2026-07-26T00:00:00.000Z",
      analytics_token: `osa_${"a".repeat(43)}`,
      template: {
        id: "tpl_1",
        revision: 3,
        content: {
          title: "Hi",
          body: "b",
          cta: { label: "Go", url: "https://x.example" },
        },
        theme: {
          preset: "light",
          accent: "#ff0000",
          surface: "#ffffff",
          text: "#111111",
          radius: "md",
        },
      },
    };
    expect(onsiteEnvelopeSchema.safeParse(envelope).success).toBe(true);

    const bad = structuredClone(envelope);
    bad.template.content.cta.url = "javascript:alert(1)";
    expect(onsiteEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});
