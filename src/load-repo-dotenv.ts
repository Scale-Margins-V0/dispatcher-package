/**
 * Load repo-root `.env` into `process.env` (dev / local runs).
 * - **Last occurrence wins** for duplicate keys in the file (matches common dotenv behavior).
 * - Does **not** overwrite keys that are already set and non-empty in the environment (shell exports win).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadRepoDotEnv(repoRoot: string): void {
  const p = join(repoRoot, ".env");
  if (!existsSync(p)) return;

  const fromFile = new Map<string, string>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fromFile.set(key, val);
  }

  for (const [key, val] of fromFile) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}
