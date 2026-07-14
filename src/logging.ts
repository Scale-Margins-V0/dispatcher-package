/**
 * Compatibility shim — call sites predating the structured logger. New code
 * should import from ./logging/logger.js directly (componentLogger for tagged
 * output). The logger is silent under vitest, preserving the old semantics.
 */

import { logger } from "./logging/logger.js";

function toMessage(first: unknown): string {
  return typeof first === "string" ? first : JSON.stringify(first);
}

export function logUnlessVitest(...args: unknown[]): void {
  const [first, ...rest] = args;
  logger.info(rest.length > 0 ? { extra: rest } : {}, toMessage(first));
}

export function warnUnlessVitest(...args: unknown[]): void {
  const [first, ...rest] = args;
  logger.warn(rest.length > 0 ? { extra: rest } : {}, toMessage(first));
}
