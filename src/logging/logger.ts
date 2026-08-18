/**
 * App-wide structured logger: JSON to stdout (pretty in a dev TTY) plus the
 * batched app_logs DB sink. request_id/campaign_id are stamped from
 * AsyncLocalStorage via mixin.
 *
 * Call sites use componentLogger(name) and the (fields, message) form — see
 * ./conventions.ts for the field names and the level discipline.
 */

import { createRequire } from "node:module";
import pino from "pino";
import { logContext } from "./context.js";
import { dbLogSink } from "./db-sink.js";
import { logWebhookSink } from "./webhook-sink.js";
import { testCaptureStream } from "./test-capture.js";

const isVitest = process.env.VITEST === "true";
const level = process.env.DISPATCHER_LOG_LEVEL || "info";

function stdoutStream(): pino.StreamEntry {
  if (process.env.NODE_ENV !== "production" && process.stdout.isTTY) {
    try {
      // pino-pretty is a devDependency; production images fall back to JSON.
      const pretty = createRequire(import.meta.url)("pino-pretty") as (
        opts: Record<string, unknown>
      ) => NodeJS.WritableStream;
      return {
        stream: pretty({
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
        }),
      };
    } catch {
      // fall through to raw JSON stdout
    }
  }
  return { stream: process.stdout };
}

/**
 * Under vitest the only sink is an in-memory buffer (./test-capture.ts):
 * nothing reaches stdout or the database, but a spec can still assert that a
 * path logged what it should. Fully silencing the logger — the previous
 * behaviour — meant any test covering a warning had to spy on `console`, and
 * quietly stopped testing anything the moment that call site was modernized.
 */
const streams: pino.StreamEntry[] = isVitest
  ? [{ level: "trace", stream: testCaptureStream }]
  : [
      stdoutStream(),
      { level: "info", stream: dbLogSink },
      // Receives all levels; the sink filters by the configured min level.
      { level: "trace", stream: logWebhookSink },
    ];

export const logger = pino(
  {
    level: isVitest ? "trace" : level,
    mixin: () => ({ ...logContext.getStore() }),
  },
  pino.multistream(streams)
);

/** Child logger tagged with a component name (shows up as its own column in the GUI). */
export function componentLogger(component: string): pino.Logger {
  return logger.child({ component });
}
