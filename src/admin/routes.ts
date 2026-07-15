import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { toNodeHandler } from "better-auth/node";
import { registerAcceptRoute } from "../auth/accept.js";
import { getAuth } from "../auth/index.js";
import { requireSession, sessionProbe } from "../auth/middleware.js";
import { getBuildInfo } from "../ops/build-info.js";
import { buildDiagnosticsReport } from "../ops/diagnostics.js";
import { getAdminActivity } from "./activity.js";
import { registerHistoryRoutes } from "./api/history.js";
import { registerLogRoutes } from "./api/logs.js";
import { registerMemberRoutes } from "./api/members.js";
import { registerObservabilityRoutes } from "./api/observability.js";
import { registerVariableRoutes } from "./api/variables.js";
import { adminSecurityHeaders } from "./auth.js";

const assetsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../admin-dist");

export const registerAdminRoutes = (app: Express): void => {
  app.use("/admin", adminSecurityHeaders);

  // Better Auth owns sign-in/out, sessions, and org/member/invitation endpoints.
  // Must be mounted before any body parser and before the auth guard.
  app.all("/admin/api/auth/*", toNodeHandler(getAuth()));

  // Public probe for the SPA to decide whether to show the sign-in screen.
  app.get("/admin/api/session", sessionProbe);
  // Public invite-accept bridge (creates the account for a valid invitation).
  registerAcceptRoute(app);

  // Everything else under /admin/api requires a valid session.
  app.use("/admin/api", requireSession);

  registerVariableRoutes(app);
  registerLogRoutes(app);
  registerHistoryRoutes(app);
  registerMemberRoutes(app);
  registerObservabilityRoutes(app);

  app.get("/admin/api/overview", async (_req, res) => {
    try {
      const report = await buildDiagnosticsReport();
      const build = getBuildInfo();
      res.json({
        generated_at: new Date().toISOString(),
        status: report.status,
        build: {
          version: build.version,
          git_sha: build.git_sha,
          build_time: build.build_time,
          image_tag: build.image_tag,
        },
        runtime: report.runtime,
        config: {
          email_provider: report.config.email_provider,
          image_storage_provider: report.config.image_storage_provider,
          user_lookup_backend: report.config.user_lookup_backend,
          user_lookup_source: report.config.user_lookup_source
            ? {
                kind: report.config.user_lookup_source.kind,
                name: report.config.user_lookup_source.name,
                id_type: report.config.user_lookup_source.id_type,
              }
            : undefined,
          user_lookup_batch: report.config.user_lookup_batch,
          placeholder_names: report.config.placeholder_names,
          events: report.config.events,
          telemetry: report.config.telemetry,
          providers: report.config.providers,
        },
        env: report.env,
      });
    } catch {
      res.status(500).json({
        error: "Unable to build the dispatcher overview",
      });
    }
  });

  app.get("/admin/api/activity", async (_req, res) => {
    try {
      const activity = await getAdminActivity();
      res.json({ generated_at: new Date().toISOString(), ...activity });
    } catch {
      res.status(500).json({ error: "Unable to load dispatcher activity" });
    }
  });

  if (!existsSync(assetsDirectory)) {
    app.get("/admin", (_req, res) => {
      res.status(503).json({ error: "Dispatcher admin UI has not been built" });
    });
    return;
  }

  app.use("/admin", express.static(assetsDirectory, { index: false }));
  app.get(["/admin", "/admin/*"], (_req, res) => {
    res.sendFile("index.html", { root: assetsDirectory });
  });
};
