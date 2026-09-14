/**
 * Which variable sources this dispatcher can actually resolve.
 *
 * `source: query` runs SQL against the customer database. In network mode there
 * is no connection, so it can never produce a value — and a variable that
 * silently falls back forever is worse than one that was refused.
 *
 * Refused at **write** time rather than degraded at read time, and refused from
 * one place so the guard and what `/state` advertises cannot drift.
 */

import { getDispatchConfig } from "../user-lookup/config.js";
import {
  SQL_ONLY_VARIABLE_SOURCES,
  VARIABLE_SOURCES,
  type PlaceholderEntry,
} from "../user-lookup/placeholders.js";

export type VariableSource = PlaceholderEntry["source"];

/** What an operator selected, derived from the resolved config. */
export function lookupMode(): "database" | "network" | "mock" {
  const lookup = getDispatchConfig().user_lookup;
  if (lookup.network) return "network";
  return lookup.backend === "mock" || lookup.backend === "http" ? "mock" : "database";
}

/** True when a SQL connection to the customer database exists. */
function hasSqlConnection(): boolean {
  const { backend } = getDispatchConfig().user_lookup;
  return backend === "mysql" || backend === "postgres" || backend === "sqlite";
}

/**
 * The single list `/state` advertises and the write guard enforces. Asserting
 * one against the other in a test is what keeps the platform's UI honest.
 */
export function supportedVariableSources(): VariableSource[] {
  if (hasSqlConnection()) return [...VARIABLE_SOURCES];
  return VARIABLE_SOURCES.filter((s) => !SQL_ONLY_VARIABLE_SOURCES.includes(s));
}

export function isSourceSupported(source: VariableSource): boolean {
  return supportedVariableSources().includes(source);
}

/** Why a source was refused, phrased for whoever is looking at the response. */
export function unsupportedSourceMessage(source: VariableSource): string {
  return (
    `source=${source} needs a SQL connection to your customer database; ` +
    `this dispatcher is in ${lookupMode()} lookup mode`
  );
}

/**
 * Variables that cannot resolve here. Retained in the table rather than
 * deleted, so switching back to database mode restores them intact.
 */
export function inactiveSources(): VariableSource[] {
  return hasSqlConnection() ? [] : [...SQL_ONLY_VARIABLE_SOURCES];
}
