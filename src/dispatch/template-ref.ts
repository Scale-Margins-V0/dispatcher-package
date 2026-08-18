/**
 * Best available template identity for a dispatch.
 *
 * There is no template id on the wire for email — `DispatchPayload.content`
 * carries an already-rendered subject and body, nothing that names the template
 * they came from. ScaleMargin does send `variant_id` and `campaign_name` on
 * every dispatch (`src/dispatch/types.ts`), and until now nothing read either.
 *
 * So this is a *reference*, not an id: good enough to group sends and to show an
 * operator which creative went out, not stable enough to join on. The column is
 * nullable and the derivation is one function, so when the platform starts
 * sending a real `template_id` this becomes a one-line change with no migration.
 *
 * WhatsApp is the exception — Gupshup requires a registered template id, so
 * there the value is genuine.
 */

import type { DispatchPayload } from "./types.js";

/** Column width is varchar(191); a longer label is truncated, not dropped. */
const MAX = 191;

function clamp(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX ? trimmed : `${trimmed.slice(0, MAX - 3)}...`;
}

export function deriveTemplateRef(
  payload: DispatchPayload,
  whatsAppTemplateId?: string | null
): string | null {
  // Most specific first: a real provider template id beats a campaign label.
  const candidates = [
    whatsAppTemplateId,
    payload.metadata?.variant_id,
    payload.metadata?.campaign_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return clamp(candidate);
    }
  }
  return null;
}
