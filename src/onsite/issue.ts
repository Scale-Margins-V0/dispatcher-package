/**
 * Dispatch-time onsite issuance.
 *
 * When a dispatch carries `metadata.onsite` and its content references the
 * reserved {{onsite_url}} placeholder, each recipient that has an assignment is
 * issued one activation: a random 256-bit sm_t token (stored only as a hash),
 * and the landing_url — with allowlisted UTM values and `#sm_t=<token>` — that
 * replaces {{onsite_url}} in the email/WhatsApp content. The personalized
 * decision is frozen (encrypted) once per decision_id and reused across
 * channels sharing that decision.
 *
 * Everything here fails closed. If onsite is unconfigured, the config is
 * invalid, a recipient has no assignment, or a recipient's decision fails to
 * resolve (e.g. a bad cta.url), that recipient simply gets no link (the
 * placeholder is stripped) and the ordinary send proceeds untouched.
 */

import { isOnsiteConfigured } from "./config.js";
import { encryptJson } from "./crypto.js";
import { buildDecisionSnapshot } from "./envelope.js";
import { buildLandingUrl } from "./landing.js";
import { generateActivationToken, hashSecret } from "./tokens.js";
import { parseOnsiteConfig, type OnsiteConfigInput } from "./types.js";
import {
  getOnsiteDecision,
  insertOnsiteActivations,
  upsertOnsiteDecision,
} from "../db/repos/onsite.js";
import {
  programOf,
  type DispatchProgramPayload,
} from "../db/repos/dispatch-programs.js";
import type { OnsiteActivationRow } from "../db/schema/index.js";
import { componentLogger } from "../logging/logger.js";

const log = componentLogger("onsite");

const ONSITE_PLACEHOLDER_G = /\{\{\s*onsite_url\s*\}\}/g;
const ONSITE_PLACEHOLDER_TEST = /\{\{\s*onsite_url\s*\}\}/;

export type OnsiteContent = {
  subject?: string;
  html_body?: string;
  text_body?: string;
  caption?: string;
  cta_value?: string;
  cta_values?: string[];
};

/** True when any content field references {{onsite_url}} (email, WhatsApp caption, or CTA). */
export function contentReferencesOnsite(
  content: OnsiteContent | undefined
): boolean {
  if (!content) return false;
  const fields = [
    content.subject,
    content.html_body,
    content.text_body,
    content.caption,
    content.cta_value,
    ...(Array.isArray(content.cta_values) ? content.cta_values : []),
  ];
  return fields.some(
    (value) => typeof value === "string" && ONSITE_PLACEHOLDER_TEST.test(value)
  );
}

/** Replace {{onsite_url}} with the recipient URL, or strip it when null. */
export function applyOnsiteUrl(text: string, url: string | null): string {
  if (!ONSITE_PLACEHOLDER_TEST.test(text)) return text;
  return text.replace(ONSITE_PLACEHOLDER_G, url ?? "");
}

type OnsitePayload = DispatchProgramPayload & {
  dispatch_ids?: Record<string, string>;
  content?: OnsiteContent;
  metadata?: { organization_id?: string; onsite?: unknown };
};

export type OnsiteIssuer = {
  /** Build a per-recipient landing URL; null when this recipient gets no link. */
  issue(params: {
    userId: string;
    channel: string;
    now: Date;
    personalizeString: (input: string) => string;
  }): Promise<string | null>;
  /** Persist the activations accumulated during the run. */
  flush(): Promise<void>;
};

/**
 * Validate `metadata.onsite` and return an issuer — or null when onsite should
 * be skipped for this dispatch (fail closed). Never throws.
 */
export async function prepareOnsite(
  payload: OnsitePayload
): Promise<OnsiteIssuer | null> {
  try {
    if (!isOnsiteConfigured()) return null;
    if (payload.metadata?.onsite === undefined) return null;
    if (!contentReferencesOnsite(payload.content)) return null;

    const parsed = parseOnsiteConfig(payload.metadata.onsite);
    if (!parsed.ok) {
      log.warn(
        `Ignoring invalid metadata.onsite; dispatch continues: ${parsed.error}`
      );
      return null;
    }
    const config: OnsiteConfigInput = parsed.config;

    const campaignId = String(payload.campaign_id ?? "");
    if (!campaignId) return null;
    const organizationId = payload.metadata?.organization_id ?? "unknown";
    const program = programOf(payload);

    const rows: OnsiteActivationRow[] = [];
    // decision_ids whose frozen snapshot is guaranteed present this run.
    const ensured = new Set<string>();

    async function ensureDecision(
      decisionId: string,
      personalizeString: (input: string) => string
    ): Promise<boolean> {
      if (ensured.has(decisionId)) return true;
      // Reuse a snapshot frozen by an earlier channel/touch.
      const existing = await getOnsiteDecision(decisionId);
      if (existing) {
        ensured.add(decisionId);
        return true;
      }
      // First touch of this decision: resolve + freeze it now.
      const snapshot = buildDecisionSnapshot({
        config,
        decisionId,
        personalizeString,
      });
      const now = new Date();
      await upsertOnsiteDecision({
        decision_id: decisionId,
        campaign_id: campaignId,
        program_id: program.program_id,
        program_kind: program.program_kind,
        step_id: program.step_id,
        organization_id: organizationId,
        site_key: config.site_key,
        snapshot_ciphertext: encryptJson(snapshot),
        created_at: now,
        updated_at: now,
      });
      ensured.add(decisionId);
      return true;
    }

    return {
      async issue({ userId, channel, now, personalizeString }) {
        try {
          const assignment = config.assignments[userId];
          if (!assignment) return null;
          const touchId = payload.dispatch_ids?.[userId];
          if (!touchId) return null;
          const startsAt = new Date(assignment.starts_at);
          const expiresAt = new Date(assignment.expires_at);
          if (now < startsAt || now >= expiresAt) return null;

          await ensureDecision(assignment.decision_id, personalizeString);

          const token = generateActivationToken();
          rows.push({
            id: crypto.randomUUID(),
            touch_id: touchId,
            decision_id: assignment.decision_id,
            campaign_id: campaignId,
            program_id: program.program_id,
            program_kind: program.program_kind,
            step_id: program.step_id,
            organization_id: organizationId,
            user_id: userId,
            channel,
            site_key: config.site_key,
            placement: config.placement,
            analytics_token: assignment.analytics_token,
            offer_ref: assignment.offer_ref,
            offer_version: String(assignment.offer_version),
            token_hash: hashSecret(token),
            visitor_nonce_hash: null,
            status: "issued",
            starts_at: startsAt,
            expires_at: expiresAt,
            issued_at: now,
            bound_at: null,
            created_at: now,
          });
          return buildLandingUrl(config.landing_url, config.attribution, token);
        } catch (error) {
          log.warn(
            { err: error instanceof Error ? error : new Error(String(error)) },
            `Onsite issuance failed for a recipient in campaign ${campaignId}; sending without onsite link`
          );
          return null;
        }
      },
      async flush() {
        try {
          await insertOnsiteActivations(rows);
        } catch (error) {
          log.warn(
            { err: error instanceof Error ? error : new Error(String(error)) },
            `Failed to persist ${rows.length} onsite activation(s) for campaign ${campaignId}`
          );
        }
      },
    };
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "Onsite preparation failed; dispatch continues without onsite"
    );
    return null;
  }
}
