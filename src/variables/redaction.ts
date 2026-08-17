/**
 * API-variable secrets never leave the dispatcher in the clear.
 *
 * Header *values* are replaced with a mask on the way out; a masked value on
 * the way back in means "keep the stored secret". That lets an editor which was
 * never allowed to read a bearer token still round-trip the definition that
 * carries it, without the caller having to re-type it or send it back.
 *
 * Header *names* are not secret and are returned as-is — an operator needs to
 * see that `Authorization` is set even when they cannot see what it is set to.
 */

import type { VariableRow } from "../db/schema/index.js";

export const HEADER_MASK = "••••••••";

type Headers = Record<string, string>;

function headersOf(config: Record<string, unknown> | null | undefined): Headers {
  const raw = (config as { headers?: unknown } | null | undefined)?.headers;
  return raw && typeof raw === "object" ? (raw as Headers) : {};
}

/** Outbound: every non-empty header value becomes the mask. */
export function redactConfig(
  source: VariableRow["source"],
  config: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (source !== "api" || !config) return config;
  const headers = headersOf(config);
  if (Object.keys(headers).length === 0) return config;
  return {
    ...config,
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, value ? HEADER_MASK : ""])
    ),
  };
}

/**
 * Inbound: swap masked values for the stored ones. A header the caller did not
 * send is dropped, so removing a header is still possible — only the mask is
 * treated as "unchanged".
 */
export function unmaskHeaders(next: Headers | undefined, previous: VariableRow | null): Headers | undefined {
  if (!next) return next;
  const stored = headersOf(previous?.config);
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [key, value === HEADER_MASK ? (stored[key] ?? "") : value])
  );
}
