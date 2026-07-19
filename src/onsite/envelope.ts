/**
 * Resolve template content, freeze the decision snapshot, and assemble the exact
 * ScaleMargin envelope.
 *
 * Only allowlisted {{offer_field}} tokens are resolved, via the caller-supplied
 * client personalization. Validation is the safety boundary: cta.url and (if
 * present) image_url must resolve to absolute http(s) URLs. A required cta.url
 * that fails validation throws — the caller then fails onsite closed for that
 * recipient rather than shipping a broken decision. An invalid image_url is
 * dropped (it is optional).
 */

import type { OnsiteActivationRow } from "../db/schema/index.js";
import {
  decisionSnapshotSchema,
  envelopeContentSchema,
  onsiteEnvelopeSchema,
  type OnsiteConfigInput,
  type OnsiteDecisionSnapshot,
  type OnsiteEnvelope,
} from "./types.js";

/** Replace only allowlisted {{field}} tokens using client personalization. */
function resolveAllowed(
  value: string,
  offerFields: string[],
  personalizeString: (input: string) => string
): string {
  let out = value;
  for (const field of offerFields) {
    const token = `{{${field}}}`;
    if (out.includes(token)) {
      out = out.split(token).join(personalizeString(token));
    }
  }
  return out;
}

function isSafeRenderUrl(value: string): boolean {
  return envelopeContentSchema.shape.cta.shape.url.safeParse(value).success;
}

export type BuildSnapshotParams = {
  config: OnsiteConfigInput;
  decisionId: string;
  personalizeString: (input: string) => string;
};

/**
 * Resolve the template for one recipient and freeze it as the channel-
 * independent decision snapshot. Throws if the resolved cta.url is not a safe
 * absolute http(s) URL.
 */
export function buildDecisionSnapshot(
  params: BuildSnapshotParams
): OnsiteDecisionSnapshot {
  const { config, decisionId } = params;
  const fields = config.offer_fields;
  const resolve = (s: string): string =>
    resolveAllowed(s, fields, params.personalizeString);
  const content = config.template.content;

  const resolvedImage = content.image_url
    ? resolve(content.image_url).trim()
    : undefined;

  const candidate = {
    schema_version: config.schema_version,
    decision_id: decisionId,
    placement: config.placement,
    template: {
      id: config.template_id,
      revision: config.template_revision,
      content: {
        ...(content.eyebrow ? { eyebrow: resolve(content.eyebrow) } : {}),
        title: resolve(content.title),
        body: resolve(content.body),
        ...(content.offer_text
          ? { offer_text: resolve(content.offer_text) }
          : {}),
        // Drop an image_url that isn't a safe absolute http(s) URL (it's optional).
        ...(resolvedImage &&
        envelopeContentSchema.shape.image_url.safeParse(resolvedImage).success
          ? { image_url: resolvedImage }
          : {}),
        cta: {
          label: resolve(content.cta.label),
          url: resolve(content.cta.url).trim(),
        },
        ...(content.dismiss_label
          ? { dismiss_label: resolve(content.dismiss_label) }
          : {}),
      },
      theme: config.template.theme,
    },
  };

  // Defense in depth: the snapshot is only ever persisted schema-validated (this
  // also rejects a cta.url that failed to resolve to a safe http(s) URL).
  if (!isSafeRenderUrl(candidate.template.content.cta.url)) {
    throw new Error("Resolved onsite CTA URL is not permitted");
  }
  return decisionSnapshotSchema.parse(candidate);
}

/** Merge the frozen snapshot with the per-activation fields into the envelope. */
export function assembleEnvelope(
  snapshot: OnsiteDecisionSnapshot,
  activation: Pick<
    OnsiteActivationRow,
    "id" | "touch_id" | "decision_id" | "analytics_token" | "expires_at"
  >
): OnsiteEnvelope {
  return onsiteEnvelopeSchema.parse({
    schema_version: snapshot.schema_version,
    activation_id: activation.id,
    decision_id: activation.decision_id,
    touch_id: activation.touch_id,
    placement: snapshot.placement,
    expires_at: activation.expires_at.toISOString(),
    analytics_token: activation.analytics_token,
    template: snapshot.template,
  });
}
