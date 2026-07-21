/**
 * One-time seed of the variables table from config/dispatch.yaml (or the
 * built-in defaults). Guarded by dispatcher_meta so an operator deleting all
 * variables later sticks — the YAML is a seed, not an ongoing source of truth.
 */

import { getMeta, setMeta } from "../db/repos/meta.js";
import { countVariables, createVariable } from "../db/repos/variables.js";
import { META_KEYS } from "../db/schema/index.js";
import { getDispatchConfig } from "../user-lookup/config.js";
import { refreshPlaceholders } from "./service.js";

export async function importYamlPlaceholdersOnce(): Promise<{ imported: number }> {
  if (await getMeta(META_KEYS.yamlImportDoneAt)) {
    await refreshPlaceholders();
    return { imported: 0 };
  }

  let imported = 0;
  // Guard against a half-initialized table from a previous partial boot.
  if ((await countVariables()) === 0) {
    const placeholders = getDispatchConfig().placeholders;
    for (const [name, def] of Object.entries(placeholders)) {
      await createVariable({
        name,
        source: def.source,
        field: def.source === "field" ? def.field : null,
        expr: def.source === "computed" ? def.expr : null,
        fallback: def.fallback ?? null,
        updated_by: "yaml_import",
      });
      imported += 1;
    }
  }
  await setMeta(META_KEYS.yamlImportDoneAt, new Date().toISOString());
  await refreshPlaceholders();
  return { imported };
}
