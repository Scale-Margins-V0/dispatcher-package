/**
 * What credentials a sender has, read from the SENDER — its inline value, or
 * the variable its `*_env` names. Never from a provider-wide environment
 * variable: a sender that forgot its key must fail loudly, not quietly send on
 * another account's key.
 *
 * One source of truth for boot validation (env-yaml.ts), diagnostics
 * (ops/diagnostics.ts) and send-time errors (gupshup-whatsapp.ts), so the three
 * can never disagree about whether a sender is configured.
 */

import type { SenderConfig } from "./types.js";

/** One credential: what the operator configured it as, and whether it resolved. */
export type CredentialCheck = {
  /**
   * The name to show: the variable a `*_env` field points at (what they set),
   * else the sender field path, e.g. `gupshup.user_id`.
   */
  source: string;
  present: boolean;
  /** Set when a `*_env` names a variable that is empty — the usual mistake. */
  unset_env?: string;
};

/** A complete way to authenticate. A sender needs any ONE of its sets. */
export type CredentialSet = { label: string; checks: CredentialCheck[]; satisfied: boolean };

export type SenderCredentialReport = {
  sender_id: string;
  provider: string;
  sets: CredentialSet[];
  satisfied: boolean;
  /** Human-readable, names the sender and exactly what to set. Absent when satisfied. */
  problem?: string;
  /** Inbound webhook verification (SendGrid key, Gupshup/Freshchat secret, SES configuration set). */
  webhook: CredentialCheck | null;
  /** Things that work, with limits worth knowing (e.g. API-key Gupshup cannot send media). */
  notes: string[];
};

/** A secret-ish field: inline wins, else the named variable. */
export function resolveField(
  provider: string,
  field: string,
  inline: string | number | undefined,
  envName: string | undefined
): CredentialCheck & { value?: string } {
  const direct = inline === undefined ? "" : String(inline).trim();
  if (direct) return { source: `${provider}.${field}`, present: true, value: direct };
  if (envName?.trim()) {
    const value = process.env[envName.trim()]?.trim();
    return value
      ? { source: envName.trim(), present: true, value }
      : { source: envName.trim(), present: false, unset_env: envName.trim() };
  }
  return { source: `${provider}.${field}`, present: false };
}

const set = (label: string, checks: CredentialCheck[]): CredentialSet => ({
  label,
  checks: checks.map(({ source, present, unset_env }) => ({ source, present, ...(unset_env ? { unset_env } : {}) })),
  satisfied: checks.every((c) => c.present),
});

/** "set gupshup.user_id (GUPSHUP_USER_ID is empty)" — one missing credential, explained. */
function describeMissing(provider: string, check: CredentialCheck, field: string): string {
  return check.unset_env
    ? `${provider}.${field}_env names ${check.unset_env}, which is not set`
    : `set ${provider}.${field} (or ${provider}.${field}_env)`;
}

const PROVIDER_LABEL: Record<string, string> = {
  sendgrid: "SendGrid",
  ses: "SES",
  gupshup: "Gupshup",
  freshchat: "Freshchat",
};

export function senderCredentials(s: SenderConfig): SenderCredentialReport {
  const base = { sender_id: s.id, provider: s.provider };
  const who = `${PROVIDER_LABEL[s.provider] ?? s.provider} sender '${s.id}'`;

  if (s.provider === "sendgrid") {
    const g = s.sendgrid;
    const key = resolveField("sendgrid", "api_key", g?.api_key, g?.api_key_env);
    const hook = resolveField("sendgrid", "event_webhook_public_key", g?.event_webhook_public_key, g?.event_webhook_public_key_env);
    const sets = [set("API key", [key])];
    return {
      ...base,
      sets,
      satisfied: key.present,
      ...(key.present ? {} : { problem: `${who} has no API key — ${describeMissing("sendgrid", key, "api_key")}` }),
      webhook: hook,
      notes: [],
    };
  }

  if (s.provider === "ses") {
    const x = s.ses;
    const id = resolveField("ses", "access_key_id", x?.access_key_id, x?.access_key_id_env);
    const secret = resolveField("ses", "secret_access_key", x?.secret_access_key, x?.secret_access_key_env);
    const declaredKeys = Boolean(
      x?.access_key_id || x?.access_key_id_env || x?.secret_access_key || x?.secret_access_key_env
    );
    // No keys at all is a supported setup: the AWS default chain (IAM role on
    // EC2 / ECS / EKS). Only a half-configured pair is a mistake.
    const sets = declaredKeys
      ? [set("Access keys", [id, secret])]
      : [set("IAM role / default AWS credentials", [{ source: "IAM role", present: true }])];
    const satisfied = sets[0]!.satisfied;
    const missing = [id, secret]
      .map((c, i) => (c.present ? null : describeMissing("ses", c, i === 0 ? "access_key_id" : "secret_access_key")))
      .filter(Boolean);
    return {
      ...base,
      sets,
      satisfied,
      ...(satisfied ? {} : { problem: `${who} has an incomplete key pair — ${missing.join("; ")}. Or remove both to use an IAM role.` }),
      webhook: x?.configuration_set?.trim()
        ? { source: "ses.configuration_set", present: true }
        : { source: "ses.configuration_set", present: false },
      notes: [],
    };
  }

  if (s.provider === "gupshup") {
    const g = s.gupshup;
    const apiKey = resolveField("gupshup", "api_key", g?.api_key, g?.api_key_env);
    const srcName: CredentialCheck = { source: "gupshup.src_name", present: Boolean(g?.src_name?.trim()) };
    const userId = resolveField("gupshup", "user_id", g?.user_id, g?.user_id_env);
    const password = resolveField("gupshup", "password", g?.password, g?.password_env);
    const hook = resolveField("gupshup", "webhook_secret", g?.webhook_secret, g?.webhook_secret_env);
    const sets = [set("API key", [apiKey, srcName]), set("Enterprise (user id + password)", [userId, password])];
    const satisfied = sets.some((x) => x.satisfied);
    const notes =
      sets[0]!.satisfied && !sets[1]!.satisfied
        ? ["Template messages only: media and text (caption) messages need gupshup.user_id + gupshup.password."]
        : [];
    let problem: string | undefined;
    if (!satisfied) {
      const apiMissing = [
        apiKey.present ? null : describeMissing("gupshup", apiKey, "api_key"),
        srcName.present ? null : "set gupshup.src_name",
      ].filter(Boolean);
      const entMissing = [
        userId.present ? null : describeMissing("gupshup", userId, "user_id"),
        password.present ? null : describeMissing("gupshup", password, "password"),
      ].filter(Boolean);
      problem =
        `${who} has no usable credentials. Either API key: ${apiMissing.join("; ")}. ` +
        `Or enterprise: ${entMissing.join("; ")}.`;
    }
    return { ...base, sets, satisfied, ...(problem ? { problem } : {}), webhook: hook, notes };
  }

  // freshchat
  const f = s.freshchat;
  const apiKey = resolveField("freshchat", "api_key", f?.api_key, f?.api_key_env);
  const hook = resolveField("freshchat", "webhook_secret", f?.webhook_secret, f?.webhook_secret_env);
  const sets = [set("API key", [apiKey])];
  return {
    ...base,
    sets,
    satisfied: apiKey.present,
    ...(apiKey.present ? {} : { problem: `${who} has no API key — ${describeMissing("freshchat", apiKey, "api_key")}` }),
    webhook: hook,
    notes: [],
  };
}
