/**
 * In-memory log capture, active only under vitest.
 *
 * Before this, the logger was fully silent in tests, which meant "does this
 * path warn when misconfigured?" could only be asserted by spying on
 * `console.warn` — so the moment a call site moved to the structured logger,
 * the test silently stopped testing anything.
 *
 * Capturing instead of silencing keeps those assertions honest and makes the
 * new structured fields testable: a spec can assert that a dispatch logged
 * `{ sent, failed }`, or that a log line contains no email address.
 *
 * Nothing is written to stdout or the database — the buffer is the only sink in
 * tests, and it is bounded so a long suite cannot grow it without limit.
 */

import type { LogLevel } from "../db/schema/shared.js";

export type CapturedLog = {
  level: LogLevel;
  component: string | null;
  msg: string;
  /** Everything else pino serialized: the structured fields plus err/stack. */
  fields: Record<string, unknown>;
};

const LEVEL_LABELS: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** A long suite emits thousands of lines; only the recent ones are ever asserted on. */
const MAX_CAPTURED = 1_000;

const captured: CapturedLog[] = [];

/** pino stream contract. */
export const testCaptureStream = {
  write(line: string): void {
    try {
      const { level, msg, component, time, pid, hostname, ...fields } = JSON.parse(
        line
      ) as Record<string, unknown>;
      captured.push({
        level: LEVEL_LABELS[level as number] ?? "info",
        component: (component as string | undefined) ?? null,
        msg: String(msg ?? ""),
        fields,
      });
      if (captured.length > MAX_CAPTURED) captured.splice(0, captured.length - MAX_CAPTURED);
    } catch {
      // Never throw into pino, for the same reason DbLogSink does not.
    }
  },
};

/** Every line captured since the last clear, oldest first. */
export function readCapturedLogs(): CapturedLog[] {
  return [...captured];
}

/**
 * Lines matching a predicate — the usual shape of an assertion.
 *
 *     expect(findCapturedLogs((l) => l.msg.includes("Dispatch completed"))).toHaveLength(1);
 */
export function findCapturedLogs(
  predicate: (entry: CapturedLog) => boolean
): CapturedLog[] {
  return captured.filter(predicate);
}

/** Call in `beforeEach` when a spec asserts on log output. */
export function clearCapturedLogs(): void {
  captured.length = 0;
}
