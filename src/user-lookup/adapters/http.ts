/**
 * HTTP profile/batch API: chunks ids, `fetch` with retries (5xx only), maps response rows to users.
 */

import { z } from "zod";
import type { DispatchConfig } from "../config.js";
import { getIdType } from "../config.js";
import {
  chunkArray,
  coerceIdForType,
  mapHttpRecordToUserRecord,
  pickByPath,
} from "../mapper.js";
import type { UserLookupAdapter, UserRecord } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(
  cfg: NonNullable<DispatchConfig["user_lookup"]["http"]>
): Record<string, string> {
  const h: Record<string, string> = {};
  const auth = cfg.auth;
  if (auth.type === "bearer" && auth.token_env) {
    const token = process.env[auth.token_env];
    if (token) h.Authorization = `Bearer ${token}`;
  }
  if (auth.type === "header" && auth.header_name && auth.token_env) {
    const v = process.env[auth.token_env];
    if (v) h[auth.header_name] = v;
  }
  return h;
}

export class HttpAdapter implements UserLookupAdapter {
  constructor(private readonly cfg: DispatchConfig) {}

  async lookupUsers(userIds: string[]): Promise<Map<string, UserRecord>> {
    const out = new Map<string, UserRecord>();
    if (userIds.length === 0) return out;

    const ul = this.cfg.user_lookup;
    const httpCfg = ul.http;
    if (!httpCfg) {
      throw new Error("user_lookup.http is required for http backend");
    }

    const fieldMap = ul.fields;
    const idType = getIdType(this.cfg);
    const dedupe = ul.batch?.dedupe !== false;
    const maxQ = ul.batch?.max_ids_per_query ?? 1000;

    const wireToCoerced = new Map<string, string>();
    const seen = new Set<string>();
    for (const w of userIds) {
      if (dedupe && seen.has(w)) continue;
      seen.add(w);
      const c = coerceIdForType(w, idType);
      if (c === null) {
        if (process.env.VITEST !== "true") {
          console.warn(
            `[UserLookup][http] Skipping invalid id for id_type=${idType}: ${JSON.stringify(w)}`
          );
        }
        continue;
      }
      wireToCoerced.set(w, c);
    }

    const uniqueCoerced = [...new Set(wireToCoerced.values())];
    const byCoerced = new Map<string, unknown>();

    for (const chunk of chunkArray(uniqueCoerced, maxQ)) {
      if (chunk.length === 0) continue;
      const url = new URL(httpCfg.path, httpCfg.base_url).toString();
      const body = JSON.stringify({ [httpCfg.request.id_field]: chunk });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...authHeaders(httpCfg),
      };

      let lastErr: unknown;
      const attempts = httpCfg.retries + 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), httpCfg.timeout_ms);
        try {
          const res = await fetch(url, {
            method: httpCfg.method,
            headers,
            body: httpCfg.method === "GET" ? undefined : body,
            signal: ac.signal,
          });
          clearTimeout(t);
          if (res.status >= 500) {
            lastErr = new Error(`HTTP ${res.status}`);
            await sleep(100 * 2 ** attempt);
            continue;
          }
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status}`);
            break;
          }
          const json: unknown = await res.json();
          const root = httpCfg.response.root
            ? pickByPath(json, httpCfg.response.root)
            : json;
          const arr = z.array(z.unknown()).parse(root);
          for (const rec of arr) {
            const rawId = pickByPath(rec, httpCfg.response.id_field);
            const idStr =
              rawId === null || rawId === undefined
                ? ""
                : String(rawId).trim();
            const ck = coerceIdForType(idStr, idType);
            if (ck !== null) {
              byCoerced.set(ck, rec);
            }
          }
          lastErr = null;
          break;
        } catch (e) {
          clearTimeout(t);
          lastErr = e;
          if (attempt < attempts - 1) {
            await sleep(100 * 2 ** attempt);
          }
        }
      }
      if (lastErr) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        // 4xx: client/auth errors — omit noisy stderr (e.g. Vitest "does not retry on 4xx")
        if (!/^HTTP 4\d\d$/.test(msg)) {
          console.warn(`[UserLookup][http] chunk failed:`, lastErr);
        }
      }
    }

    for (const [wire, coerced] of wireToCoerced) {
      const rec = byCoerced.get(coerced);
      if (!rec) continue;
      const u = mapHttpRecordToUserRecord(
        wire,
        rec,
        httpCfg.response.id_field,
        fieldMap,
        idType
      );
      if (u) out.set(wire, u);
      else if (process.env.VITEST !== "true") {
        console.warn(
          `[UserLookup][http] Skipping record that failed validation for wire=${JSON.stringify(wire)}`
        );
      }
    }

    if (process.env.VITEST !== "true") {
      console.log(
        `[UserLookup][http] Resolved ${out.size}/${userIds.length} users`
      );
    }
    return out;
  }
}
