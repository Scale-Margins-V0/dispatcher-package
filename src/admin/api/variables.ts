/**
 * Admin CRUD for dynamic variables (placeholders). Mounted behind
 * requireSession in registerAdminRoutes. Every write refreshes the in-process
 * placeholder snapshot, so edits apply to the next dispatch without a restart.
 *
 * Source types: field | computed | constant | query (SQL) | api (HTTP fetch).
 * query/api config lives in the `config` JSON column; api header values are
 * redacted in responses and preserved on edit when left masked.
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
import { renderPlaceholderPreview, validateComputedExpression } from "../../personalize.js";
import type { PlaceholderEntry } from "../../user-lookup/config.js";
import { rowToPlaceholderEntry } from "../../variables/mapping.js";
import { HEADER_MASK, redactConfig } from "../../variables/redaction.js";
import { testVariableDefinition } from "../../variables/resolver.js";
import { refreshPlaceholders } from "../../variables/service.js";

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Header masking is shared with the Atlas data-plane surface — one mask, one rule. */
export { HEADER_MASK };

const apiSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  url: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).optional(),
  json_path: z.string().max(200).optional().default(""),
  body: z.string().max(8000).optional(),
  timeout_ms: z.number().int().min(100).max(30000).optional(),
});

const variablePayloadSchema = z
  .object({
    name: z.string().min(1).max(191).regex(NAME_RE, "name must match ^[a-zA-Z_][a-zA-Z0-9_]*$"),
    source: z.enum(["field", "computed", "constant", "query", "api"]),
    field: z.string().min(1).max(191).optional(),
    expr: z.string().min(1).max(4000).optional(),
    value: z.string().max(8000).optional(),
    sql: z.string().min(1).max(8000).optional(),
    api: apiSchema.optional(),
    fallback: z.string().max(4000).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const require = (cond: boolean, path: string, message: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    };
    if (data.source === "field") require(!!data.field, "field", "field is required for a field variable");
    if (data.source === "constant") require(data.value !== undefined, "value", "value is required for a constant");
    if (data.source === "computed") {
      require(!!data.expr, "expr", "expr is required for a computed variable");
      if (data.expr) {
        const check = validateComputedExpression(data.expr);
        if (!check.ok) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid expression: ${check.error}`, path: ["expr"] });
        }
      }
    }
    if (data.source === "query") {
      require(!!data.sql, "sql", "sql is required for a query variable");
      if (data.sql && !/^\s*(select|with)\b/i.test(data.sql)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SQL must be a SELECT/WITH query", path: ["sql"] });
      }
    }
    if (data.source === "api") {
      require(!!data.api, "api", "api config is required for an api variable");
    }
  });

type Payload = z.infer<typeof variablePayloadSchema>;

function payloadToEntry(d: Payload): PlaceholderEntry {
  const fb = d.fallback !== undefined ? { fallback: d.fallback } : {};
  switch (d.source) {
    case "field":
      return { source: "field", field: d.field!, ...fb };
    case "computed":
      return { source: "computed", expr: d.expr!, ...fb };
    case "constant":
      return { source: "constant", value: d.value ?? "", ...fb };
    case "query":
      return { source: "query", sql: d.sql!, ...fb };
    case "api":
      return {
        source: "api",
        api: {
          method: d.api!.method,
          url: d.api!.url,
          ...(d.api!.headers ? { headers: d.api!.headers } : {}),
          json_path: d.api!.json_path ?? "",
          ...(d.api!.body ? { body: d.api!.body } : {}),
          ...(d.api!.timeout_ms ? { timeout_ms: d.api!.timeout_ms } : {}),
        },
        ...fb,
      };
  }
}

function entryToRowFields(e: PlaceholderEntry): {
  field: string | null;
  expr: string | null;
  config: Record<string, unknown> | null;
} {
  switch (e.source) {
    case "field":
      return { field: e.field, expr: null, config: null };
    case "computed":
      return { field: null, expr: e.expr, config: null };
    case "constant":
      return { field: null, expr: null, config: { value: e.value } };
    case "query":
      return { field: null, expr: null, config: { sql: e.sql } };
    case "api":
      return { field: null, expr: null, config: { ...e.api } };
  }
}

function serialize(row: VariableRow) {
  return {
    name: row.name,
    source: row.source,
    field: row.field,
    expr: row.expr,
    fallback: row.fallback,
    config: redactConfig(row.source, row.config),
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
    preview: renderPlaceholderPreview(rowToPlaceholderEntry(row)),
  };
}

function authedUser(req: Request): string | null {
  return (req as { authUser?: { email?: string } }).authUser?.email ?? null;
}

/** Replace masked api header values with the existing stored ones. */
function mergeMaskedHeaders(data: Payload, existing: VariableRow | null): void {
  if (data.source !== "api" || !data.api?.headers) return;
  const prev = (existing?.config as { headers?: Record<string, string> } | null)?.headers ?? {};
  for (const [k, v] of Object.entries(data.api.headers)) {
    if (v === HEADER_MASK) data.api.headers[k] = prev[k] ?? "";
  }
}

function toNewVariable(data: Payload, req: Request): NewVariable {
  const { field, expr, config } = entryToRowFields(payloadToEntry(data));
  return {
    name: data.name,
    source: data.source,
    field,
    expr,
    config,
    fallback: data.fallback ?? null,
    enabled: data.enabled ?? true,
    updated_by: authedUser(req),
  };
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "Invalid variable payload",
    details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
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
      res.json({ generated_at: new Date().toISOString(), variables: rows.map(serialize) });
    })
  );

  app.post(
    "/admin/api/variables",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = variablePayloadSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      if (await getVariable(parsed.data.name)) {
        res.status(409).json({ error: `Variable "${parsed.data.name}" already exists` });
        return;
      }
      const row = await createVariable(toNewVariable(parsed.data, req));
      await refreshPlaceholders();
      res.status(201).json({ variable: serialize(row) });
    })
  );

  app.put(
    "/admin/api/variables/:name",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = variablePayloadSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const currentName = String(req.params.name);
      const existing = await getVariable(currentName);
      if (!existing) {
        res.status(404).json({ error: `Variable "${currentName}" not found` });
        return;
      }
      if (parsed.data.name !== currentName && (await getVariable(parsed.data.name))) {
        res.status(409).json({ error: `Variable "${parsed.data.name}" already exists` });
        return;
      }
      mergeMaskedHeaders(parsed.data, existing);
      const row = await updateVariable(currentName, toNewVariable(parsed.data, req));
      await refreshPlaceholders();
      res.json({ variable: serialize(row!) });
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
        res.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") });
        return;
      }
      // Sync preview for field/computed/constant; query/api need the live test.
      const entry = payloadToEntry(parsed.data);
      const preview =
        entry.source === "query" || entry.source === "api"
          ? undefined
          : renderPlaceholderPreview(entry);
      res.json({ ok: true, ...(preview !== undefined ? { preview } : {}) });
    })
  );

  // Live test — runs query/api for real against the sample user; returns value or
  // error (plus the raw HTTP response for api). The variable need not be named
  // yet, so you can fire a request from the builder before saving it.
  app.post(
    "/admin/api/variables/test",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const named =
        typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name : "_unsaved";
      const parsed = variablePayloadSchema.safeParse({ ...req.body, name: named });
      if (!parsed.success) {
        res.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") });
        return;
      }
      // Fill masked headers from the stored variable so a test uses the real secret.
      mergeMaskedHeaders(parsed.data, await getVariable(parsed.data.name));
      const result = await testVariableDefinition(payloadToEntry(parsed.data));
      res.json(result);
    })
  );
};
