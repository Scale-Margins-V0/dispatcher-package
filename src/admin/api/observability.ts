/**
 * Admin settings for observability: the GET /logs bearer token and (Phase 2)
 * the log webhook. Mounted under requireSession in registerAdminRoutes.
 */

import express, { type Express, type Request, type Response } from "express";
import { generateLogsToken, getLogsTokenStatus } from "../../logging/logs-token.js";
import { asyncHandler } from "./variables.js";

export const registerObservabilityRoutes = (app: Express): void => {
  const json = express.json({ limit: "16kb" });

  app.get(
    "/admin/api/settings/logs-token",
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await getLogsTokenStatus());
    })
  );

  // Generate/rotate the token — plaintext returned ONCE; only the hash is stored.
  app.post(
    "/admin/api/settings/logs-token",
    json,
    asyncHandler(async (_req: Request, res: Response) => {
      const token = await generateLogsToken();
      res.status(201).json({ token });
    })
  );
};
