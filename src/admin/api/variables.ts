/**
 * Admin CRUD for dynamic variables (placeholders). Mounted behind
 * verifyAdminAccess in registerAdminRoutes. Every write refreshes the
 * in-process placeholder snapshot, so edits apply to the next dispatch
 * without a restart.
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import {
  createVariable,
  deleteVariable,
  getVariable,
  updateVariable,
  listVariables,
  type NewVariable,
} from "../../db/repos/variables.js";
import type { VariableRow } from "../../db/schema/index.js";
import {
  renderPlaceholderPreview,
  validateComputedExpression,
} from "../../personalize.js";
import type { PlaceholderEntry } from "../../user-lookup/config.js";
import { refreshPlaceholders } from "../../variables/service.js";

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const variablePayloadSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(191)
      .regex(NAME_RE, "name must match ^[a-zA-Z_][a-zA-Z0-9_]*$"),
    source: z.enum(["field", "computed"]),
    field: z.string().min(1).max(191).optional(),
    expr: z.string().min(1).max(4000).optional(),
    fallback: z.string().max(4000).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.source === "field" && !data.field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "field is required when source is field",
        path: ["field"],
      });
    }
    if (data.source === "computed") {
      if (!data.expr) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "expr is required when source is computed",
          path: ["expr"],
        });
      } else {
        const check = validateComputedExpression(data.expr);
        if (!check.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `invalid expression: ${check.error}`,
            path: ["expr"],
          });
        }
      }
    }
  });

function toEntry(row: VariableRow): PlaceholderEntry {
  return row.source === "field"
    ? {
        source: "field",
        field: row.field ?? "",
        ...(row.fallback !== null ? { fallback: row.fallback } : {}),
      }
    : {
        source: "computed",
        expr: row.expr ?? "",
        ...(row.fallback !== null ? { fallback: row.fallback } : {}),
      };
}

function serialize(row: VariableRow) {
  return {
    name: row.name,
    source: row.source,
    field: row.field,
    expr: row.expr,
    fallback: row.fallback,
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
    preview: renderPlaceholderPreview(toEntry(row)),
  };
}

function adminUser(): string | null {
  return process.env.DISPATCHER_ADMIN_USER ?? null;
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "Invalid variable payload",
    details: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

/** Express 4 does not catch async handler rejections — wrap them. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export const registerVariableRoutes = (app: Express): void => {
  const json = express.json({ limit: "64kb" });

  app.get(
    "/admin/api/variables",
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await listVariables();
      res.json({
        generated_at: new Date().toISOString(),
        variables: rows.map(serialize),
      });
    })
  );

  app.post("/admin/api/variables", json, asyncHandler(async (req: Request, res: Response) => {
    const parsed = variablePayloadSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    if (await getVariable(parsed.data.name)) {
      res.status(409).json({ error: `Variable "${parsed.data.name}" already exists` });
      return;
    }
    const row = await createVariable(toNewVariable(parsed.data));
    await refreshPlaceholders();
    res.status(201).json({ variable: serialize(row) });
  }));

  app.put(
    "/admin/api/variables/:name",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = variablePayloadSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const currentName = String(req.params.name);
      if (parsed.data.name !== currentName && (await getVariable(parsed.data.name))) {
        res
          .status(409)
          .json({ error: `Variable "${parsed.data.name}" already exists` });
        return;
      }
      const row = await updateVariable(currentName, toNewVariable(parsed.data));
      if (!row) {
        res.status(404).json({ error: `Variable "${currentName}" not found` });
        return;
      }
      await refreshPlaceholders();
      res.json({ variable: serialize(row) });
    })
  );

  app.delete(
    "/admin/api/variables/:name",
    asyncHandler(async (req: Request, res: Response) => {
      const deleted = await deleteVariable(String(req.params.name));
      if (!deleted) {
        res.status(404).json({ error: `Variable "${req.params.name}" not found` });
        return;
      }
      await refreshPlaceholders();
      res.json({ deleted: true });
    })
  );

  app.post(
    "/admin/api/variables/validate",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = variablePayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.json({
          ok: false,
          error: parsed.error.issues
            .map((issue) => issue.message)
            .join("; "),
        });
        return;
      }
      const entry: PlaceholderEntry =
        parsed.data.source === "field"
          ? {
              source: "field",
              field: parsed.data.field!,
              ...(parsed.data.fallback !== undefined
                ? { fallback: parsed.data.fallback }
                : {}),
            }
          : {
              source: "computed",
              expr: parsed.data.expr!,
              ...(parsed.data.fallback !== undefined
                ? { fallback: parsed.data.fallback }
                : {}),
            };
      res.json({ ok: true, preview: renderPlaceholderPreview(entry) });
    })
  );
};

function toNewVariable(data: z.infer<typeof variablePayloadSchema>): NewVariable {
  return {
    name: data.name,
    source: data.source,
    field: data.source === "field" ? data.field : null,
    expr: data.source === "computed" ? data.expr : null,
    fallback: data.fallback ?? null,
    enabled: data.enabled ?? true,
    updated_by: adminUser(),
  };
}
