/**
 * Onsite activation types + zod schemas — the ScaleMargin cross-repo contract.
 *
 * Three validated boundaries:
 *   1. `metadata.onsite` — untrusted sender input on a dispatch: schema_version,
 *      site_key, landing_url, template_id/revision, placement, offer_fields
 *      (the allowlist of {{...}} tokens the template may resolve), attribution
 *      (UTM values), template{content,theme}, and per-user `assignments`.
 *   2. The frozen decision snapshot — the resolved, channel-independent envelope
 *      core persisted (encrypted) per decision_id and reused across channels.
 *   3. The typed ScaleMargin envelope — the exact shape returned to a browser.
 *
 * URLs are constrained to the same rules as the browser SDK: landing URLs may
 * be absolute HTTP(S), images must be HTTPS, and CTAs must be HTTPS or a
 * same-origin path. Personalized values can never introduce executable URLs.
 */

import { z } from "zod";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrl = z
  .string()
  .max(2048)
  .refine(isHttpUrl, "must be an absolute http(s) URL");
const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute https URL");
const renderTarget = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value.startsWith("/") && !value.startsWith("//")) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be a same-origin path or an absolute https URL");
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const placement = z.enum(["corner", "banner_top"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// ---------------------------------------------------------------------------
// metadata.onsite — sender input (template strings may contain {{offer_field}})
// ---------------------------------------------------------------------------

export const templateContentInputSchema = z
  .object({
    eyebrow: z.string().max(80).optional(),
    title: z.string().min(1).max(160),
    body: z.string().max(500),
    offer_text: z.string().max(160).optional(),
    image_url: z.string().max(2048).optional(),
    cta: z
      .object({
        label: z.string().min(1).max(80),
        url: z.string().min(1).max(2048),
      })
      .strict(),
    dismiss_label: z.string().max(80).optional(),
  })
  .strict();

export const templateThemeSchema = z
  .object({
    preset: z.string().min(1).max(80),
    accent: color,
    surface: color,
    text: color,
    radius: z.enum(["none", "sm", "md", "lg"]),
  })
  .strict();

export const onsiteTemplateInputSchema = z
  .object({
    content: templateContentInputSchema,
    theme: templateThemeSchema,
  })
  .strict();

export const onsiteAssignmentSchema = z
  .object({
    decision_id: z.string().min(1).max(128),
    offer_ref: z.string().min(1).max(128),
    offer_version: z.string().min(1).max(128),
    analytics_token: z.string().min(32).max(512),
    starts_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const onsiteConfigSchema = z
  .object({
    schema_version: z.literal(1),
    site_key: z.string().regex(/^onsite_pk_[A-Za-z0-9_-]{32,}$/),
    landing_url: httpUrl,
    template_id: z.string().min(1).max(128),
    template_revision: z.number().int().positive(),
    placement,
    /** Allowlist of {{field}} names the template may resolve. */
    offer_fields: z.array(identifier).max(50).default([]),
    /** UTM (and similar) values; only the UTM allowlist reaches the URL. */
    attribution: z
      .object({
        source: z.string().max(200).optional(),
        medium: z.string().max(200).optional(),
        campaign: z.string().max(200).optional(),
        content: z.string().max(200).optional(),
        utm_id: z.string().max(200).optional(),
      })
      .strict()
      .default({}),
    template: onsiteTemplateInputSchema,
    /** Per opaque user_id → the user's assignment for this dispatch. */
    assignments: z.record(onsiteAssignmentSchema),
  })
  .strict();

export type OnsiteAssignment = z.infer<typeof onsiteAssignmentSchema>;
export type OnsiteTemplateInput = z.infer<typeof onsiteTemplateInputSchema>;
export type OnsiteConfigInput = z.infer<typeof onsiteConfigSchema>;

/**
 * Validate a raw `metadata.onsite`. Returns the parsed config or a reason
 * string — never throws, so an invalid block fails the onsite feature closed
 * without disturbing the surrounding dispatch.
 */
export function parseOnsiteConfig(
  raw: unknown
): { ok: true; config: OnsiteConfigInput } | { ok: false; error: string } {
  const result = onsiteConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}

// ---------------------------------------------------------------------------
// The typed ScaleMargin envelope (exact) + the frozen decision snapshot
// ---------------------------------------------------------------------------

export const envelopeContentSchema = z
  .object({
    eyebrow: z.string().max(80).optional(),
    title: z.string().min(1).max(160),
    body: z.string().max(500),
    offer_text: z.string().max(160).optional(),
    image_url: httpsUrl.optional(),
    cta: z
      .object({ label: z.string().min(1).max(80), url: renderTarget })
      .strict(),
    dismiss_label: z.string().max(80).optional(),
  })
  .strict();

export const envelopeTemplateSchema = z
  .object({
    id: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    content: envelopeContentSchema,
    theme: templateThemeSchema,
  })
  .strict();

/** Frozen, channel-independent core reused across channels sharing decision_id. */
export const decisionSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    decision_id: z.string().min(1).max(128),
    placement,
    template: envelopeTemplateSchema,
  })
  .strict();

/** The exact envelope returned by redeem / session. */
export const onsiteEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    activation_id: z.string().min(1).max(128),
    decision_id: z.string().min(1).max(128),
    touch_id: z.string().min(1).max(128),
    placement,
    expires_at: z.string().datetime({ offset: true }),
    analytics_token: z.string().min(32).max(512),
    template: envelopeTemplateSchema,
  })
  .strict();

export type OnsiteEnvelopeContent = z.infer<typeof envelopeContentSchema>;
export type OnsiteEnvelopeTemplate = z.infer<typeof envelopeTemplateSchema>;
export type OnsiteDecisionSnapshot = z.infer<typeof decisionSnapshotSchema>;
export type OnsiteEnvelope = z.infer<typeof onsiteEnvelopeSchema>;

/** Receipt event kinds a client may report. */
export const ONSITE_RECEIPT_TYPES = ["impression", "click", "dismiss"] as const;
export type OnsiteReceiptType = (typeof ONSITE_RECEIPT_TYPES)[number];
