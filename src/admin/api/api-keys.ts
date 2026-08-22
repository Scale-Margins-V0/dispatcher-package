import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import {
  ATLAS_KEY_ENV,
  atlasKeyWarning,
  isAtlasApiConfigured,
} from "../../api/v1/atlas-key.js";
import {
  allowedOrigins,
  CORS_ORIGINS_ENV,
  corsWarning,
} from "../../api/v1/cors.js";
import { API_VERSION } from "../../api/v1/version.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "../../auth/api-keys.js";
import { authBaseURL } from "../../auth/index.js";
import { asyncHandler } from "./variables.js";

const nameSchema = z.object({
  name: z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/, "Use letters, numbers, spaces, dots, dashes, or underscores"),
});
const idSchema = z.object({ id: z.string().uuid() });

export const registerApiKeyRoutes = (app: Express): void => {
  const json = express.json({ limit: "8kb" });

  app.get(
    "/admin/api/settings/api-keys",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ api_keys: await listApiKeys() });
    })
  );

  /**
   * Everything an operator must copy into Atlas to connect this dispatcher,
   * plus the fixed endpoint list. The base URL varies per deployment; the
   * paths are identical everywhere, which is what lets Atlas support any
   * number of clients without special cases.
   */
  app.get("/admin/api/settings/connection", (_req, res) => {
    const base = authBaseURL();
    res.json({
      base_url: base,
      api_version: API_VERSION,
      configured_public_url: Boolean(process.env.DISPATCHER_PUBLIC_URL?.trim()),
      // Presence only — the key itself is never read back out of the process.
      atlas_key_env: ATLAS_KEY_ENV,
      atlas_key_configured: isAtlasApiConfigured(),
      atlas_key_warning: atlasKeyWarning(),
      cors_env: CORS_ORIGINS_ENV,
      cors_origins: allowedOrigins(),
      cors_warning: corsWarning(),
      endpoints: [
        { method: "GET", path: `/api/v1/data-plane/state`, purpose: "Dashboard status" },
        { method: "GET", path: `/api/v1/data-plane/build`, purpose: "Identity + connection check" },
      ],
      internal_endpoints: [
        { method: "GET", path: `/api/v1/internal/health`, purpose: "Liveness" },
        { method: "GET", path: `/api/v1/internal/ready`, purpose: "Readiness" },
      ],
    });
  });

  app.get("/admin/api/settings/platform-secrets", (_req, res) => {
    const names = ["SCALEMARGIN_DISPATCH_SECRET", "SCALEMARGIN_ANALYTICS_SECRET"] as const;
    res.json({
      secrets: names.map((name) => ({ name, value: process.env[name] ?? "" })),
    });
  });

  app.post(
    "/admin/api/settings/api-keys",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid API key name" });
        return;
      }
      try {
        res.status(201).json({ api_key: await createApiKey(parsed.data.name) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create API key";
        res.status(message.includes("already exists") ? 409 : 500).json({ error: message });
      }
    })
  );

  app.post(
    "/admin/api/settings/api-keys/:id/rotate",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = idSchema.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid API key id" });
        return;
      }
      const apiKey = await rotateApiKey(parsed.data.id);
      if (!apiKey) {
        res.status(404).json({ error: "Active API key not found" });
        return;
      }
      res.json({ api_key: apiKey });
    })
  );

  app.post(
    "/admin/api/settings/api-keys/:id/revoke",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = idSchema.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid API key id" });
        return;
      }
      if (!(await revokeApiKey(parsed.data.id))) {
        res.status(404).json({ error: "Active API key not found" });
        return;
      }
      res.json({ revoked: true });
    })
  );
};
