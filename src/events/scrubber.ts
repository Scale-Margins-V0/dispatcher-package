/**
 * Generic PII scrubber — second line of defense after adapter stripPii.
 * Redacts email-shaped strings, E.164-ish phones, IPv4, IPv6 from nested JSON-like values.
 */

const EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

const IPV6_RE =
  /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g;

/** E.164 or common local formats with digits and optional + prefix */
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;

const REDACT = "[REDACTED]";

function scrubString(s: string): string {
  return s
    .replace(EMAIL_RE, REDACT)
    .replace(IPV4_RE, REDACT)
    .replace(IPV6_RE, REDACT)
    .replace(PHONE_RE, REDACT);
}

/**
 * Deep-clone and scrub all string values in objects/arrays.
 */
export function scrubPii<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    return scrubString(input) as T;
  }
  if (typeof input !== "object") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => scrubPii(item)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = scrubPii(v);
  }
  return out as T;
}
