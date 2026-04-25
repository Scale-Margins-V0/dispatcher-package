import type { Express } from "express";

export function startServer(app: Express, port: number): void {
  const server = app.listen(port, () => {
    console.log(`[Server] ScaleMargin Dispatch Handler running on port ${port}`);
    console.log(`[Server] Email provider: ${process.env.EMAIL_PROVIDER || "ses"}`);
    console.log(`[Server] Dispatch endpoint: POST /api/scalemargin/dispatch`);
    console.log(`[Server] SES notifications: POST /api/scalemargin/ses-notifications`);
    console.log(`[Server] SendGrid events: POST /api/scalemargin/sendgrid-events`);
    console.log(`[Server] Gupshup events: POST /api/scalemargin/gupshup-events`);
    console.log("[Server] Health check: GET /health");
    if (process.env.EVENT_TEST_CSV_PATH) {
      const base =
        process.env.EVENT_TEST_PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
      console.log(
        `[Server] Event test capture URL (use as analytics_callback_url): ${base}/api/webhooks/campaign-analytics/capture`
      );
    }
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
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
}
