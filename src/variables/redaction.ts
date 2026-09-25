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
 *
 * Query parameters get the same treatment when their name looks like a
 * credential (`api_key`, `token`, `signature`…) — `?api_key=` is how plenty of
 * services authenticate. Other query values (`user_id={{user_id}}`) stay
 * readable, because an editor has to see them to change them.
 */

import type { VariableRow } from "../db/schema/index.js";

export const HEADER_MASK = "••••••••";

type Headers = Record<string, string>;
type QueryRow = { key: string; value: string };

/** Heuristic, deliberately broad: a false positive only masks a harmless value. */
const SECRET_QUERY_KEY = /key|token|secret|password|passwd|auth|signature|sig$|credential/i;

export function isSecretQueryKey(key: string): boolean {
  return SECRET_QUERY_KEY.test(key);
}

function queryOf(config: Record<string, unknown> | null | undefined): QueryRow[] {
  const raw = (config as { query?: unknown } | null | undefined)?.query;
  return Array.isArray(raw) ? (raw as QueryRow[]) : [];
}

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
  const query = queryOf(config);
  return {
    ...config,
    ...(Object.keys(headers).length > 0
      ? {
          headers: Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [key, value ? HEADER_MASK : ""])
          ),
        }
      : {}),
    ...(query.length > 0
      ? {
          query: query.map((row) =>
            isSecretQueryKey(row.key) && row.value ? { ...row, value: HEADER_MASK } : row
          ),
        }
      : {}),
  };
}

/**
 * Inbound: a masked query value means "keep the stored one" — matched by name.
 * A row whose name changed has no stored value to keep and resolves to "".
 */
export function unmaskQuery(
  next: QueryRow[] | undefined,
  previous: VariableRow | null
): QueryRow[] | undefined {
  if (!next) return next;
  const stored = queryOf(previous?.config);
  return next.map((row) =>
    row.value === HEADER_MASK
      ? { ...row, value: stored.find((s) => s.key === row.key)?.value ?? "" }
      : row
  );
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
