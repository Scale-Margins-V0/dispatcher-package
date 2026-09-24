/**
 * Which record fields the variables actually read.
 *
 * The user lookup returns only contact details. In database mode a variable
 * may also read other columns of the source view, and the lookup fetches
 * exactly those — so a column nobody references is never read.
 */

import { computedFieldRefs } from "../personalize.js";
import type { PlaceholderEntry } from "./placeholders.js";

/** `{{field.city}}` inside a query/api definition. */
const FIELD_TOKEN = /\{\{\s*field\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function referencedFieldNames(
  registry: Record<string, PlaceholderEntry>
): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(registry)) {
    switch (entry.source) {
      case "field":
        names.add(entry.field);
        break;
      case "computed":
        for (const ref of computedFieldRefs(entry.expr)) names.add(ref);
        break;
      case "query":
      case "api":
        for (const m of JSON.stringify(entry).matchAll(FIELD_TOKEN)) names.add(m[1]!);
        break;
      case "constant":
        break;
    }
  }
  return [...names];
}
