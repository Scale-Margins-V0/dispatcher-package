/**
 * Shared helpers: safe SQL identifiers, JSON dot-paths, id coercion, SQL/HTTP → `UserRecord`.
 */

import type { UserRecord } from "./types.js";

export type IdType = "string" | "int" | "bigint" | "uuid";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Safe SQL / JSON identifier: letters, digits, underscore; must not be empty. */
export function validateSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Read a nested property path from an object. Supports dot segments and numeric array indices.
 * Returns undefined if any segment is missing.
 */
export function pickByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (/^\d+$/.test(seg) && Array.isArray(cur)) {
      cur = cur[Number(seg)];
      continue;
    }
    if (typeof cur === "object" && cur !== null && seg in cur) {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cur;
}

export function stringFromCell(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s.length === 0 ? undefined : s;
}

/**
 * Returns a normalized id suitable for querying, or null if the id is invalid for id_type.
 */
export function coerceIdForType(raw: string, idType: IdType): string | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  switch (idType) {
    case "string":
      return t;
    case "int": {
      if (!/^-?\d+$/.test(t)) return null;
      const n = Number(t);
      if (!Number.isSafeInteger(n)) return null;
      return String(n);
    }
    case "bigint": {
      if (!/^-?\d+$/.test(t)) return null;
      return t;
    }
    case "uuid":
      return UUID_RE.test(t) ? t.toLowerCase() : null;
    default:
      return t;
  }
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Map a flat SQL row (keys = physical column names) into UserRecord using logical→physical field map.
 * `idColumnPhysical` is the DB column holding the ScaleMargin user id.
 * `wireUserId` is the original id from the dispatch payload (used as Map key and in `user_id`).
 */
export function mapSqlRowToUserRecord(
  wireUserId: string,
  row: Record<string, unknown>,
  idColumnPhysical: string,
  fieldMap: Record<string, string>,
  idType: IdType
): UserRecord | null {
  const rawId = row[idColumnPhysical];
  const idStr = stringFromCell(rawId);
  if (idStr === undefined) return null;
  const rowCoerced = coerceIdForType(idStr, idType);
  const wireCoerced = coerceIdForType(wireUserId, idType);
  if (rowCoerced === null || wireCoerced === null || rowCoerced !== wireCoerced) {
    return null;
  }

  const fields: Record<string, string | undefined> = {};
  for (const [logical, physical] of Object.entries(fieldMap)) {
    if (!validateSafeIdentifier(logical) || !validateSafeIdentifier(physical)) {
      continue;
    }
    fields[logical] = stringFromCell(row[physical]);
  }

  const email = fields.email;
  if (email === undefined || email.length === 0) {
    return null;
  }

  return {
    user_id: wireUserId,
    email,
    fields,
  };
}

/**
 * Map an HTTP JSON record using logical key → JSON path (dot) in the record.
 */
export function mapHttpRecordToUserRecord(
  wireUserId: string,
  record: unknown,
  idPath: string,
  fieldMap: Record<string, string>,
  idType: IdType
): UserRecord | null {
  const rawId = pickByPath(record, idPath);
  const idStr = stringFromCell(rawId);
  if (idStr === undefined) return null;
  const rowCoerced = coerceIdForType(idStr, idType);
  const wireCoerced = coerceIdForType(wireUserId, idType);
  if (rowCoerced === null || wireCoerced === null || rowCoerced !== wireCoerced) {
    return null;
  }

  const fields: Record<string, string | undefined> = {};
  for (const [logical, jsonPath] of Object.entries(fieldMap)) {
    fields[logical] = stringFromCell(pickByPath(record, jsonPath));
  }

  const email = fields.email;
  if (email === undefined || email.length === 0) {
    return null;
  }

  return {
    user_id: wireUserId,
    email,
    fields,
  };
}
