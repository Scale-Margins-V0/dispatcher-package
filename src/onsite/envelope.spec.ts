import { describe, expect, it } from "vitest";
import { assembleEnvelope, buildDecisionSnapshot } from "./envelope.js";
import type { OnsiteConfigInput } from "./types.js";

const subst: Record<string, string> = {
  "{{first_name}}": "Ada",
  "{{code}}": "SAVE20",
};
const personalizeString = (s: string): string =>
  Object.entries(subst).reduce((acc, [k, v]) => acc.split(k).join(v), s);

const config = (
  over?: Partial<OnsiteConfigInput["template"]["content"]>
): OnsiteConfigInput => ({
  schema_version: 1,
  site_key: `onsite_pk_${"a".repeat(32)}`,
  landing_url: "https://go.example/o",
  template_id: "tpl_1",
  template_revision: 3,
  placement: "corner",
  offer_fields: ["first_name", "code"],
  attribution: {},
  template: {
    content: {
      eyebrow: "For {{first_name}}",
      title: "Reward {{first_name}}",
      body: "Use {{code}}",
      offer_text: "{{code}} off",
      image_url: "https://cdn.example/{{code}}.png",
      cta: {
        label: "Claim {{code}}",
        url: "https://shop.example/{{first_name}}",
      },
      dismiss_label: "No thanks",
      ...over,
    },
    theme: {
      preset: "light",
      accent: "#ff0000",
      surface: "#ffffff",
      text: "#111111",
      radius: "md",
    },
  },
  assignments: {},
});

describe("buildDecisionSnapshot", () => {
  it("resolves only allowlisted offer fields and freezes the template", () => {
    const snap = buildDecisionSnapshot({
      config: config(),
      decisionId: "dec_1",
      personalizeString,
    });
    expect(snap.decision_id).toBe("dec_1");
    expect(snap.placement).toBe("corner");
    expect(snap.template.id).toBe("tpl_1");
    expect(snap.template.revision).toBe(3);
    expect(snap.template.content.title).toBe("Reward Ada");
    expect(snap.template.content.body).toBe("Use SAVE20");
    expect(snap.template.content.eyebrow).toBe("For Ada");
    expect(snap.template.content.offer_text).toBe("SAVE20 off");
    expect(snap.template.content.image_url).toBe(
      "https://cdn.example/SAVE20.png"
    );
    expect(snap.template.content.cta).toEqual({
      label: "Claim SAVE20",
      url: "https://shop.example/Ada",
    });
    expect(snap.template.theme.preset).toBe("light");
  });

  it("does NOT resolve a token that is not in offer_fields", () => {
    const cfg = config({ title: "Hi {{secret}}" });
    cfg.offer_fields = ["first_name"];
    const snap = buildDecisionSnapshot({
      config: cfg,
      decisionId: "d",
      personalizeString,
    });
    expect(snap.template.content.title).toBe("Hi {{secret}}");
  });

  it("throws when the resolved cta.url is not a safe http(s) URL (fail closed)", () => {
    const cfg = config({ cta: { label: "x", url: "javascript:alert(1)" } });
    expect(() =>
      buildDecisionSnapshot({ config: cfg, decisionId: "d", personalizeString })
    ).toThrow();
  });

  it("drops an unsafe image_url but keeps the rest", () => {
    const cfg = config({ image_url: "/relative/path.png" });
    const snap = buildDecisionSnapshot({
      config: cfg,
      decisionId: "d",
      personalizeString,
    });
    expect(snap.template.content.image_url).toBeUndefined();
    expect(snap.template.content.title).toBe("Reward Ada");
  });
});

describe("assembleEnvelope", () => {
  it("merges the frozen snapshot with per-activation fields", () => {
    const snap = buildDecisionSnapshot({
      config: config(),
      decisionId: "dec_1",
      personalizeString,
    });
    const env = assembleEnvelope(snap, {
      id: "act_1",
      touch_id: "touch_1",
      decision_id: "dec_1",
      analytics_token: `osa_${"a".repeat(43)}`,
      expires_at: new Date("2026-07-26T00:00:00.000Z"),
    });
    expect(env.activation_id).toBe("act_1");
    expect(env.touch_id).toBe("touch_1");
    expect(env.decision_id).toBe("dec_1");
    expect(env.analytics_token).toBe(`osa_${"a".repeat(43)}`);
    expect(env.expires_at).toBe("2026-07-26T00:00:00.000Z");
    expect(env.placement).toBe("corner");
    expect(env.template.content.title).toBe("Reward Ada");
  });
});
