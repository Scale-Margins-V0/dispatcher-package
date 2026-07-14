/**
 * App-wide structured logger: JSON to stdout (pretty in a dev TTY) plus the
 * batched app_logs DB sink. request_id/campaign_id are stamped from
 * AsyncLocalStorage via mixin. Silent under vitest — matching the historical
 * logUnlessVitest behavior.
 */

import { createRequire } from "node:module";
import pino from "pino";
import { logContext } from "./context.js";
import { dbLogSink } from "./db-sink.js";

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

const streams: pino.StreamEntry[] = isVitest
  ? []
  : [stdoutStream(), { level: "info", stream: dbLogSink }];

export const logger = pino(
  {
    level: isVitest ? "silent" : level,
    mixin: () => ({ ...logContext.getStore() }),
  },
  pino.multistream(streams)
);

/** Child logger tagged with a component name (shows up as its own column in the GUI). */
export function componentLogger(component: string): pino.Logger {
  return logger.child({ component });
}
