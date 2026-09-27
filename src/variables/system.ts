/**
 * System variables: defined by the dispatcher, present in every mode, and
 * never edited, renamed, disabled or deleted.
 *
 * `email` and `phone` are the only things the user lookup returns, in every
 * mode — so they are the only variables that can be guaranteed. The two links
 * are built by the dispatcher itself; losing `unsubscribe_url` would break the
 * unsubscribe link in every email, which is a compliance problem, not a style
 * choice.
 *
 * They live in code, not the variables table. A row can be deleted; this map
 * cannot. Rows seeded under these names by older versions are shadowed —
 * ignored at resolve time and hidden from the catalog.
 */

import type { PlaceholderEntry } from "../user-lookup/placeholders.js";
import { DEFAULT_PLACEHOLDERS } from "../user-lookup/placeholders.js";

export type SystemVariable = {
  entry: PlaceholderEntry;
  /** One line for the catalog UI. */
  description: string;
};

export const SYSTEM_VARIABLES: Readonly<Record<string, SystemVariable>> = {
  email: {
    entry: { source: "field", field: "email", fallback: "" },
    description: "Recipient email address, from the user lookup. Resolved on email sends.",
  },
  phone: {
    entry: { source: "field", field: "phone", fallback: "" },
    description: "Recipient phone number, from the user lookup. Resolved on WhatsApp sends.",
  },
  unsubscribe_url: {
    entry: DEFAULT_PLACEHOLDERS.unsubscribe_url!,
    description: "One-click unsubscribe link for this recipient and campaign.",
  },
  preferences_url: {
    entry: DEFAULT_PLACEHOLDERS.preferences_url!,
    description: "Link to this recipient's preference centre.",
  },
};

export function isSystemVariable(name: string): boolean {
  return Object.hasOwn(SYSTEM_VARIABLES, name);
}

/** Name → entry, for merging over the registry. */
export const SYSTEM_PLACEHOLDERS: Readonly<Record<string, PlaceholderEntry>> =
  Object.fromEntries(
    Object.entries(SYSTEM_VARIABLES).map(([name, v]) => [name, v.entry])
  );
