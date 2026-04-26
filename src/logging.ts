/** Suppress logs when Vitest imports the app for integration tests. */
export function logUnlessVitest(...args: unknown[]): void {
  if (process.env.VITEST === "true") return;
  console.log(...args);
}

export function warnUnlessVitest(...args: unknown[]): void {
  if (process.env.VITEST === "true") return;
  console.warn(...args);
}
