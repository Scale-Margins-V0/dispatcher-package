/**
 * Correlation extraction from provider-specific echoed metadata (Option A).
 */

import type { Correlation } from "./types.js";

function readString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return v;
  return undefined;
}

/** SendGrid echoes custom_args as object with string values. */
export function extractCorrelationFromSendGridEvent(event: unknown): Correlation | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const ca =
    (e.custom_args as Record<string, unknown> | undefined) ??
    (e.customArgs as Record<string, unknown> | undefined) ??
    (e.unique_args as Record<string, unknown> | undefined);
  if (ca && typeof ca === "object") {
    const campaign_id = readString(ca.campaign_id);
    const user_id = readString(ca.user_id);
    const organization_id = readString(ca.organization_id);
    const analytics_callback_url = readString(ca.analytics_callback_url);
    if (campaign_id && user_id && organization_id) {
      return {
        campaign_id,
        user_id,
        organization_id,
        ...(analytics_callback_url && { analytics_callback_url }),
      };
    }
  }
  const campaign_id = readString(e.campaign_id);
  const user_id = readString(e.user_id);
  const organization_id = readString(e.organization_id);
  const analytics_callback_url = readString(e.analytics_callback_url);
  if (!campaign_id || !user_id || !organization_id) return null;
  return {
    campaign_id,
    user_id,
    organization_id,
    ...(analytics_callback_url && { analytics_callback_url }),
  };
}

export function explainSendGridCorrelationDrop(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "Event payload was not a JSON object.";
  }
  const e = event as Record<string, unknown>;
  const ca =
    (e.custom_args as Record<string, unknown> | undefined) ??
    (e.customArgs as Record<string, unknown> | undefined) ??
    (e.unique_args as Record<string, unknown> | undefined);
  if (!ca || typeof ca !== "object") {
    return (
      "No custom_args / customArgs / unique_args on this payload — SendGrid UI “Test Integration” " +
      "often sends samples like that. Trigger a real send with POST /api/scalemargin/dispatch " +
      "(this app adds customArgs on outbound mail so webhooks can correlate)."
    );
  }
  return (
    "custom_args present but campaign_id, user_id, or organization_id is missing — " +
    "check that outbound sends use SendContext (dispatch path sets message.context)."
  );
}

/** SES mail.tags: each key maps to string[] — take first element. */
export function extractCorrelationFromSesMail(mail: unknown): Correlation | null {
  if (!mail || typeof mail !== "object") return null;
  const m = mail as Record<string, unknown>;
  const tags = m.tags as Record<string, string[]> | undefined;
  if (!tags || typeof tags !== "object") return null;
  const first = (arr: string[] | undefined) =>
    Array.isArray(arr) && arr.length > 0 ? readString(arr[0]) : undefined;
  const campaign_id = first(tags.campaign_id);
  const user_id = first(tags.user_id);
  const organization_id = first(tags.organization_id);
  if (!campaign_id || !user_id || !organization_id) return null;
  return { campaign_id, user_id, organization_id };
}

/** Gupshup: `tag` JSON string or object with correlation keys (flat body or v2 `payload.tag`). */
export function extractCorrelationFromGupshupEvent(event: unknown): Correlation | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  let raw = e.tag;
  if (
    raw === undefined &&
    e.version === 2 &&
    e.type === "message-event" &&
    typeof e.payload === "object" &&
    e.payload
  ) {
    raw = (e.payload as Record<string, unknown>).tag;
  }
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    // `smsign_<sig>` tags carry no IDs (50-char limit) — they correlate on the
    // backend by externalId, not here. Legacy self-contained JSON tags still
    // parse locally for backward compat.
    if (raw.startsWith("smsign_")) return null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;
  const campaign_id = readString(obj.campaign_id);
  const user_id = readString(obj.user_id);
  const organization_id = readString(obj.organization_id);
  const analytics_callback_url = readString(obj.analytics_callback_url);
  if (!campaign_id || !user_id || !organization_id) return null;
  return {
    campaign_id,
    user_id,
    organization_id,
    ...(analytics_callback_url && { analytics_callback_url }),
  };
}

export class LookupTableCorrelator {
  lookup(_providerMessageId: string): Correlation | null {
    return null;
  }
}
