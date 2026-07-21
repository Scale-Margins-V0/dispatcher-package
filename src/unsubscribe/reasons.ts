/**
 * Unsubscribe survey reasons — configurable via UNSUBSCRIBE_REASONS env.
 *
 * Formats (either):
 *   Pipe-separated labels:
 *     This email is not relevant to me|The emails are too frequent|Other
 *   Pipe-separated id=label (id "other" enables free-text):
 *     not_relevant=This email is not relevant to me|too_frequent=The emails are too frequent|other=Other
 *   JSON array of strings or { id, label, allowCustom? } objects.
 */

export interface UnsubscribeReasonOption {
  id: string;
  label: string;
  /** When true, show a free-text field and use that as the recorded reason. */
  allowCustom: boolean;
}

const DEFAULT_REASONS: UnsubscribeReasonOption[] = [
  { id: "not_relevant", label: "This email is not relevant to me", allowCustom: false },
  { id: "too_frequent", label: "The emails are too frequent", allowCustom: false },
  { id: "dont_remember", label: "I don't remember signing up for this", allowCustom: false },
  { id: "spam", label: "I find these emails inappropriate or spam", allowCustom: false },
  { id: "other", label: "Other", allowCustom: true },
];

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  return slug || "reason";
}

function isOtherLabel(label: string): boolean {
  return /^other\b/i.test(label.trim());
}

function normalizeOption(
  id: string,
  label: string,
  allowCustom?: boolean
): UnsubscribeReasonOption | null {
  const trimmedLabel = label.trim();
  const trimmedId = id.trim();
  if (!trimmedLabel || !trimmedId) return null;
  const custom =
    allowCustom === true || trimmedId.toLowerCase() === "other" || isOtherLabel(trimmedLabel);
  return {
    id: trimmedId.slice(0, 64),
    label: trimmedLabel.slice(0, 200),
    allowCustom: custom,
  };
}

function parseJsonReasons(raw: string): UnsubscribeReasonOption[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const out: UnsubscribeReasonOption[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        const opt = normalizeOption(slugify(item), item);
        if (opt) out.push(opt);
        continue;
      }
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const label = typeof rec.label === "string" ? rec.label : "";
        const id =
          typeof rec.id === "string" && rec.id.trim()
            ? rec.id
            : slugify(label);
        const allowCustom =
          rec.allowCustom === true || rec.allow_custom === true;
        const opt = normalizeOption(id, label, allowCustom);
        if (opt) out.push(opt);
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function parsePipeReasons(raw: string): UnsubscribeReasonOption[] | null {
  const parts = raw
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const out: UnsubscribeReasonOption[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const id = part.slice(0, eq);
      const label = part.slice(eq + 1);
      const opt = normalizeOption(id, label);
      if (opt) out.push(opt);
      continue;
    }
    const opt = normalizeOption(slugify(part), part);
    if (opt) out.push(opt);
  }
  return out.length > 0 ? out : null;
}

/** Resolve reason options from UNSUBSCRIBE_REASONS, or built-in defaults. */
export function getUnsubscribeReasons(): UnsubscribeReasonOption[] {
  const raw = process.env.UNSUBSCRIBE_REASONS?.trim();
  if (!raw) return DEFAULT_REASONS.map((r) => ({ ...r }));

  if (raw.startsWith("[")) {
    return parseJsonReasons(raw) ?? DEFAULT_REASONS.map((r) => ({ ...r }));
  }
  return parsePipeReasons(raw) ?? DEFAULT_REASONS.map((r) => ({ ...r }));
}

export function findUnsubscribeReason(
  id: string | undefined
): UnsubscribeReasonOption | undefined {
  if (!id) return undefined;
  return getUnsubscribeReasons().find((r) => r.id === id);
}

/**
 * Resolve the human-readable reason string to store on the event.
 * For "other", prefer the free-text field when non-empty.
 */
export function resolveUnsubscribeReasonText(params: {
  reasonId: string | undefined;
  otherText: string | undefined;
}): { reasonId: string; reason: string } | null {
  const option = findUnsubscribeReason(params.reasonId);
  if (!option) return null;

  if (option.allowCustom) {
    const custom = params.otherText?.trim();
    if (custom && custom.length > 0) {
      return { reasonId: option.id, reason: custom.slice(0, 500) };
    }
    return { reasonId: option.id, reason: option.label };
  }

  return { reasonId: option.id, reason: option.label };
}
