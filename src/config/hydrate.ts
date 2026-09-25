/**
 * Copy `.env.yaml` settings into `process.env` at boot, so every existing
 * reader keeps working with no `.env` file present.
 *
 * ## Precedence, highest first
 *
 *   1. A real environment variable (Docker `environment:`, a Kubernetes
 *      Secret, a shell export). Never overwritten.
 *   2. A structured block — `scalemargin:`, `admin:`, `storage:`, …
 *   3. The `env:` passthrough map.
 *
 * Rule 1 is the important one. A Kubernetes deployment injecting a rotated
 * secret must win over a stale value committed to a mounted file, and an
 * operator debugging with `DISPATCHER_LOG_LEVEL=debug docker compose up` must
 * not be silently overridden by the file they are trying to diagnose.
 *
 * Rule 2 over rule 3 because a typed key is more specific than a raw one. If
 * both set the same variable the typed value wins, and `hydrate` reports the
 * collision rather than resolving it quietly.
 */

import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { BINDINGS } from "./bindings.js";
import { envYamlSchema, envYamlPath, type EnvYaml } from "../env-yaml.js";

export interface HydrationResult {
  /** Variables this call actually set. */
  applied: string[];
  /** Present in the file but already set in the environment, so left alone. */
  skipped: string[];
  /** `*_env` references naming a variable that does not exist. */
  dangling: Array<{ env: string; reference: string }>;
  /** Set by both a typed block and the `env:` map. The typed value won. */
  collisions: string[];
  /** Absolute path read, or null when there is no file. */
  path: string | null;
}

const EMPTY: HydrationResult = {
  applied: [],
  skipped: [],
  dangling: [],
  collisions: [],
  path: null,
};

/**
 * YAML gives numbers, booleans and lists; `process.env` holds only strings.
 *
 * Lists join with commas because that is what every existing reader already
 * splits on — CORS origins, trusted origins, unsubscribe reasons, event
 * provider lists. Keeping the wire format identical means none of those
 * parsers change.
 */
function flatten(value: string | number | boolean | string[]): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

/** Already set and non-empty. An empty string counts as unset, as dotenv treats it. */
function presentInEnv(key: string): boolean {
  const current = process.env[key];
  return current !== undefined && current !== "";
}

/**
 * Parse `.env.yaml` on its own, rather than through `loadEnvYaml()`.
 *
 * `loadEnvYaml()` synthesizes a back-compat sender from the EMAIL_PROVIDER and
 * FROM_EMAIL environment variables when `senders:` is empty, and caches it. Calling it here
 * would run that synthesis against an environment this function has not
 * populated yet, and cache the wrong answer for the rest of the process.
 */
function readFile(): { cfg: EnvYaml; path: string } | null {
  const path = envYamlPath();
  if (!path || !existsSync(path)) return null;

  const parsed = yaml.load(readFileSync(path, "utf8"));
  // An empty file is `undefined`, which the schema rejects with a message
  // about the whole document. Treat it as "no settings" — the operator who
  // touched an empty file meant nothing by it.
  if (parsed === undefined || parsed === null) return null;

  return { cfg: envYamlSchema.parse(parsed), path };
}

/**
 * Populate `process.env` from `.env.yaml`.
 *
 * Safe to call more than once: nothing it has already set will be set again,
 * because the first call makes those variables present.
 */
export function hydrateEnvFromYaml(): HydrationResult {
  const file = readFile();
  if (!file) return { ...EMPTY };

  const { cfg, path } = file;
  const result: HydrationResult = {
    applied: [],
    skipped: [],
    dangling: [],
    collisions: [],
    path,
  };

  // ── Pass 1: the `env:` passthrough, lowest precedence ────────────────────
  const fromRawEnv = new Set<string>();
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    if (presentInEnv(key)) {
      result.skipped.push(key);
      continue;
    }
    process.env[key] = flatten(value);
    fromRawEnv.add(key);
    result.applied.push(key);
  }

  // ── Pass 2: typed blocks, which override the map above ───────────────────
  for (const binding of BINDINGS) {
    const raw = binding.read(cfg);
    if (raw === undefined || raw === "") continue;

    let value: string;
    if (binding.indirect) {
      // A `*_env` key names a variable rather than holding a value, so a
      // rotated secret takes effect on restart without editing this file.
      const referenced = process.env[String(raw)]?.trim();
      if (!referenced) {
        result.dangling.push({ env: binding.env, reference: String(raw) });
        continue;
      }
      value = referenced;
    } else {
      value = flatten(raw);
    }

    if (fromRawEnv.has(binding.env)) {
      // Both a typed key and `env:` set this. The typed one wins; say so
      // rather than leaving the operator to wonder which applied.
      result.collisions.push(binding.env);
    } else if (presentInEnv(binding.env)) {
      result.skipped.push(binding.env);
      continue;
    }

    process.env[binding.env] = value;
    if (!result.applied.includes(binding.env)) result.applied.push(binding.env);
  }

  return result;
}
