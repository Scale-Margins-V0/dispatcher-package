/**
 * Onsite runtime configuration + feature gating.
 *
 * The subsystem is a no-op unless ONSITE_STATE_ENCRYPTION_KEY is set: decision
 * snapshots are always stored encrypted, so without a key we refuse to issue
 * activations and every onsite endpoint 404s. This is the "fail closed"
 * contract — ordinary dispatch is never affected by onsite being unconfigured.
 */

/** Reserved placeholder replaced per-recipient with the activation landing URL. */
export const ONSITE_URL_PLACEHOLDER = "onsite_url";

/**
 * Session cookie name. The `__Host-` prefix is a browser-enforced hardening
 * contract: the cookie MUST be Secure, Path=/, and carry no Domain attribute.
 */
export const ONSITE_COOKIE_NAME = "__Host-sm_as";
export const ONSITE_COOKIE_PATH = "/";

/** Session lifetimes fixed by the contract: 30m idle, 24h absolute. */
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_ABSOLUTE_SECONDS = 24 * 60 * 60;

/** UTM keys allowed to reach the generated landing_url query string. */
export const UTM_ATTRIBUTION_MAP = {
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  content: "utm_content",
  utm_id: "utm_id",
} as const;

/** Onsite is enabled only when a state encryption key is configured. */
export function isOnsiteConfigured(): boolean {
  const value = process.env.ONSITE_STATE_ENCRYPTION_KEY?.trim();
  return Boolean(value && Buffer.byteLength(value, "utf8") >= 32);
}

function intEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Retention window (days) for activations/sessions past expiry. */
export function onsiteRetentionDays(): number {
  return intEnv("DISPATCHER_ONSITE_RETENTION_DAYS", 30);
}
