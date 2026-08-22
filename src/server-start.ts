import type { Express } from "express";
import { closeDispatcherDb } from "./db/shutdown.js";
import { flushLogSink } from "./logging/db-sink.js";
import { componentLogger } from "./logging/logger.js";
import { LogComponent, errorFields } from "./logging/conventions.js";
import { telemetry } from "./telemetry/posthog.js";

const log = componentLogger(LogComponent.server);

export function startServer(app: Express, port: number): void {
  const server = app.listen(port, () => {
    telemetry.capture("dispatcher_started", {
      port,
      email_provider: process.env.EMAIL_PROVIDER || "ses",
      telemetry_enabled: telemetry.isEnabled(),
    });
    log.info(
      {
        port,
        provider: process.env.EMAIL_PROVIDER || "ses",
        node_env: process.env.NODE_ENV ?? "development",
        telemetry_enabled: telemetry.isEnabled(),
      },
      "Dispatcher started"
    );
    if (process.env.EVENT_TEST_CSV_PATH) {
      const base =
        process.env.EVENT_TEST_PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
      log.info(
        { capture_url: `${base}/api/webhooks/campaign-analytics/capture` },
        "Event-test capture URL ready — use it as analytics_callback_url"
      );
    }
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    telemetry.captureException(err, { component: "server_listen" });
    if (err.code === "EADDRINUSE") {
      console.error(
        `[FATAL] Port ${port} is already in use. Stop the other process (e.g. \`pnpm dev\` in another terminal) or use a free port:\n` +
          "  PORT=3101 pnpm run dev:event-test\n" +
          "Then run ngrok against that port (`ngrok http 3101`) and set EVENT_TEST_PUBLIC_BASE_URL to the ngrok HTTPS URL."
      );
      process.exit(1);
    }
    console.error("[Server] listen error:", err);
    process.exit(1);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    telemetry.capture("dispatcher_shutdown", { signal });
    void Promise.allSettled([telemetry.shutdown(), flushLogSink()])
      .then(() => closeDispatcherDb())
      .finally(() => {
        process.exit(0);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  process.on("uncaughtException", (error) => {
    telemetry.captureException(error, { component: "uncaught_exception" });
    log.fatal(errorFields(error), "Uncaught exception — process is exiting");
    // Console too: the flush below is best-effort, and a crash that leaves no
    // trace anywhere is the worst possible outcome.
    console.error("[Server] uncaught exception:", error);
    void Promise.allSettled([telemetry.shutdown(), flushLogSink()]).finally(() => {
      process.exit(1);
    });
  });

  process.on("unhandledRejection", (reason) => {
    telemetry.captureException(reason, { component: "unhandled_rejection" });
    log.error(errorFields(reason), "Unhandled promise rejection");
  });
}
