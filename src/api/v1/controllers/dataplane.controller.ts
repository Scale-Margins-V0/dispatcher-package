/**
 * Handlers for the external (Atlas) data-plane surface.
 *
 * Two groups live here:
 *
 *   - **Read-only observability** — `getBuild` and `getState`, which Atlas uses
 *     as a connection probe and to render the dashboard.
 *   - **Variable CRUD** — the authoring surface. Definitions travel; resolved
 *     values never do, so nothing in this file returns a value read from the
 *     client's customer store. The one exception is `sample`, which is a
 *     preview of a *fictional* record and is supplied by the caller, not read.
 *
 * Every write refreshes the in-process placeholder snapshot, so a saved
 * definition applies to the next dispatch without a restart or a redeploy.
 */

import type { Request, Response } from "express";
import { isDbInitialized } from "../../../db/client.js";
import { resolveDbEnv } from "../../../db/env.js";
import { countOutboxByStatus } from "../../../db/repos/outbox.js";
import {
  countVariables,
  dispatchWindowStats,
  lastDispatchAt,
  resolutionWarningCount,
  stateDatabaseReachable,
} from "../../../db/repos/stats.js";
import {
  createVariable,
  deleteVariable,
  getVariable,
  listVariables,
  updateVariable,
  type NewVariable,
} from "../../../db/repos/variables.js";
import type { VariableRow } from "../../../db/schema/index.js";
import { getBuildInfo } from "../../../ops/build-info.js";
import { getRuntimeStatus } from "../../../ops/diagnostics.js";
import { renderPlaceholderPreview } from "../../../personalize.js";
import { rowToPlaceholderEntry } from "../../../variables/mapping.js";
import { redactConfig, unmaskHeaders } from "../../../variables/redaction.js";
import { refreshPlaceholders } from "../../../variables/service.js";
import { apiError, invalidRequest } from "../errors.js";
import {
  ZCreateVariableSchema,
  ZListVariablesQuerySchema,
  ZUpdateVariableSchema,
  ZVariableNameParamSchema,
  type ZVariableDefinition,
} from "../validators/dataplane.validator.js";
import { API_VERSION, STATUS_WINDOW_DAYS } from "../version.js";

/*
 * Observability
 */

/**
 * GET /build — identity and environment.
 *
 * Cheap and dependency-light, which is why Atlas uses it as the connection
 * probe: a 200 proves both reachability and authentication before a connection
 * is saved.
 *
 * Emits the database *dialect*, never its URL, host, user or password. The
 * dialect is operationally useful; the connection string is a credential.
 */
export async function getBuild(_req: Request, res: Response): Promise<void> {
  const build = getBuildInfo();
  const reachable = await stateDatabaseReachable();

  res.json({
    generated_at: new Date().toISOString(),
    service: {
      name: build.name,
      version: build.version,
      git_sha: build.git_sha,
      build_time: build.build_time,
      image_tag: build.image_tag,
      api_version: API_VERSION,
    },
    runtime: {
      environment: build.environment,
      node_version: build.node_version,
      uptime_seconds: build.uptime_seconds,
    },
    database: {
      dialect: resolveDbEnv(process.env).dialect,
      reachable,
      migrations_applied: isDbInitialized(),
    },
    last_dispatch_at: await lastDispatchAt(),
  });
}

/**
 * GET /state — everything on the Atlas dashboard, in one call.
 *
 * Two rules this endpoint lives by:
 *
 * 1. **Placeholders are null, never zero.** `fallback_rate: 0` reads as
 *    "perfect"; null reads as "not measured". Atlas renders null as a dash.
 * 2. **Never 500 for an expected condition.** If the state database is
 *    unreachable the counters come back null and the status says so — a
 *    dashboard reporting "up, but its database is unreachable" is far more
 *    useful than a failed request.
 */
export async function getState(_req: Request, res: Response): Promise<void> {
  const days = STATUS_WINDOW_DAYS;

  const [runtime, dbReachable, dispatch, variables, warnings, lastDispatch] =
    await Promise.all([
      Promise.resolve(getRuntimeStatus()),
      stateDatabaseReachable(),
      dispatchWindowStats(days),
      countVariables(),
      resolutionWarningCount(days),
      lastDispatchAt(),
    ]);

  const outbox = await countOutboxByStatus().catch(() => null);

  const checks = {
    ...runtime.checks,
    state_database: dbReachable
      ? { ok: true }
      : { ok: false, message: "State database is not reachable" },
  };
  const failed = Object.values(checks).filter((check) => !check.ok).length;
  const state =
    failed === 0
      ? "healthy"
      : failed === Object.keys(checks).length
      ? "error"
      : "degraded";

  res.json({
    generated_at: new Date().toISOString(),
    status: { state, checks },
    dispatch: {
      window_days: days,
      dispatched: dispatch?.dispatched ?? null,
      failed: dispatch?.failed ?? null,
      runs: dispatch?.runs ?? null,
      last_dispatch_at: lastDispatch,
      by_channel: dispatch?.by_channel ?? null,
    },
    resolution: {
      // Deliberately null: the resolver cannot produce a true per-recipient
      // rate yet. See docs/atlas-api-plan.md §8.
      fallback_rate: null,
      fallback_events: warnings,
      variables_enabled: variables?.enabled ?? null,
    },
    catalog: {
      variables_total: variables?.total ?? null,
      variables_enabled: variables?.enabled ?? null,
      // Nothing publishes the catalog yet — Atlas pulls it on demand.
      last_published_at: null,
    },
    outbox: {
      pending: outbox ? (outbox.pending ?? 0) + (outbox.delivering ?? 0) : null,
      failed: outbox ? outbox.failed ?? 0 : null,
    },
  });
}

/*
 * Variables — shared helpers
 */

/**
 * Variable CRUD is the one part of this surface that cannot degrade: a write
 * against an unattached database would report success and lose the definition.
 * Refuse up front instead.
 */
function requireStateDb(res: Response): boolean {
  if (isDbInitialized()) return true;
  apiError(
    res,
    "unavailable",
    "This dispatcher has no state database attached — variables cannot be read or written",
  );
  return false;
}

/** Row → the column set the definition occupies, with the other branches cleared. */
function definitionToColumns(
  definition: ZVariableDefinition,
): Pick<NewVariable, "source" | "field" | "expr" | "config"> {
  switch (definition.source) {
    case "field":
      return {
        source: "field",
        field: definition.field,
        expr: null,
        config: null,
      };
    case "computed":
      return {
        source: "computed",
        field: null,
        expr: definition.expr,
        config: null,
      };
    case "constant":
      return {
        source: "constant",
        field: null,
        expr: null,
        config: { value: definition.value },
      };
    case "query":
      return {
        source: "query",
        field: null,
        expr: null,
        config: { sql: definition.sql },
      };
    case "api":
      return {
        source: "api",
        field: null,
        expr: null,
        config: { ...definition.api },
      };
  }
}

/** Row → the wire shape, with api header values masked. */
function serializeDefinition(row: VariableRow): Record<string, unknown> {
  const config = (redactConfig(row.source, row.config) ?? {}) as Record<
    string,
    unknown
  >;
  switch (row.source) {
    case "field":
      return { source: "field", field: row.field ?? "" };
    case "computed":
      return { source: "computed", expr: row.expr ?? "" };
    case "constant":
      return { source: "constant", value: String(config.value ?? "") };
    case "query":
      return { source: "query", sql: String(config.sql ?? "") };
    case "api":
      return { source: "api", api: config };
  }
}

function serializeVariable(row: VariableRow) {
  return {
    name: row.name,
    source: row.source,
    definition: serializeDefinition(row),
    fallback: row.fallback,
    sample: row.sample,
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

/**
 * A `field`/`computed`/`constant` definition renders against the fictional
 * sample record for free, so we do it rather than trust the caller. `query`
 * and `api` would have to touch the client's database or an internal service
 * to produce a sample, which a save must never do — those keep whatever the
 * caller's live test returned.
 */
function resolveSample(
  definition: ZVariableDefinition,
  fallback: string | null,
  supplied: string | null | undefined,
): string | null {
  if (definition.source === "query" || definition.source === "api") {
    return supplied ?? null;
  }
  const row = {
    source: definition.source,
    field: definition.source === "field" ? definition.field : null,
    expr: definition.source === "computed" ? definition.expr : null,
    config:
      definition.source === "constant" ? { value: definition.value } : null,
    fallback,
  } as VariableRow;
  return renderPlaceholderPreview(rowToPlaceholderEntry(row));
}

/** The authenticated Atlas caller, for the audit column. */
function actor(req: Request): string {
  const key = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  return key ? `atlas:${key.slice(0, 8)}` : "atlas";
}

/*
 * Variables — CRUD
 */

/**
 * Page descriptor for a filtered result set.
 *
 * `total_pages` floors at 1: an empty list is "page 1 of 1, showing nothing",
 * which a pager can render. "Page 1 of 0" is a state no UI has a sensible
 * layout for.
 *
 * A page past the end is not an error — it returns an empty `variables` array
 * with honest counts, so a client that deletes the last row on page 3 sees
 * `has_next_page: false` and can walk back rather than handle a 404.
 */
function pageMeta(total: number, page: number, limit: number) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const offset = (page - 1) * limit;
  const returned = Math.max(0, Math.min(limit, total - offset));
  return {
    page,
    limit,
    total,
    total_pages: totalPages,
    /** 1-based inclusive range of the rows in this response; null when empty. */
    from: returned > 0 ? offset + 1 : null,
    to: returned > 0 ? offset + returned : null,
    has_previous_page: page > 1,
    has_next_page: page < totalPages && offset + returned < total,
  };
}

/**
 * GET /variables — the catalog. Names, definitions and samples; never a value.
 *
 * Filters narrow the set, then the page is cut from what survives, so
 * `meta.total` always describes the filtered result and never the whole table.
 */
export async function listVariablesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!requireStateDb(res)) return;

  const query = ZListVariablesQuerySchema.safeParse(req.query);
  if (!query.success) return invalidRequest(res, query.error);

  const { source, enabled, q, page, limit } = query.data;
  const needle = q?.toLowerCase();
  // ponytail: filter and slice in memory. Variable counts are tens per
  // dispatcher; push page/limit into SQL if a client ever passes four figures.
  const rows = (await listVariables()).filter(
    (row) =>
      (source === undefined || row.source === source) &&
      (enabled === undefined || row.enabled === enabled) &&
      (needle === undefined || row.name.toLowerCase().includes(needle)),
  );

  const offset = (page - 1) * limit;
  res.json({
    generated_at: new Date().toISOString(),
    meta: pageMeta(rows.length, page, limit),
    variables: rows.slice(offset, offset + limit).map(serializeVariable),
  });
}

/** GET /variables/:name */
export async function getVariableHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) return invalidRequest(res, params.error);

  const row = await getVariable(params.data.name);
  if (!row) {
    apiError(res, "not_found", `Variable "${params.data.name}" does not exist`);
    return;
  }
  res.json({ variable: serializeVariable(row) });
}

/** POST /variables */
export async function createVariableHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!requireStateDb(res)) return;

  const parsed = ZCreateVariableSchema.safeParse(req.body);
  if (!parsed.success) return invalidRequest(res, parsed.error);

  const { name, definition, fallback = null, sample, enabled } = parsed.data;
  if (await getVariable(name)) {
    apiError(res, "conflict", `Variable "${name}" already exists`);
    return;
  }

  // Nothing to unmask on create — there is no stored secret to preserve, so a
  // literal mask would be saved as the credential. Reject it rather than
  // silently store eight bullets as a bearer token.
  if (definition.source === "api" && definition.api.headers) {
    const masked = Object.entries(definition.api.headers).find(
      ([, value]) => value === "••••••••",
    );
    if (masked) {
      apiError(res, "invalid_request", "Request failed validation", [
        {
          path: `definition.api.headers.${masked[0]}`,
          message:
            "Send the real header value when creating a variable — there is nothing to preserve yet",
        },
      ]);
      return;
    }
  }

  const row = await createVariable({
    name,
    ...definitionToColumns(definition),
    fallback,
    sample: resolveSample(definition, fallback, sample),
    enabled,
    updated_by: actor(req),
  });
  await refreshPlaceholders();
  res.status(201).json({ variable: serializeVariable(row) });
}

/**
 * PATCH /variables/:name
 *
 * Partial by field, atomic by definition: omit `definition` and the recipe is
 * untouched, send it and it is replaced whole.
 */
export async function updateVariableHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) return invalidRequest(res, params.error);

  const parsed = ZUpdateVariableSchema.safeParse(req.body);
  if (!parsed.success) return invalidRequest(res, parsed.error);

  const current = params.data.name;
  const existing = await getVariable(current);
  if (!existing) {
    apiError(res, "not_found", `Variable "${current}" does not exist`);
    return;
  }

  const { name, definition, fallback, sample, enabled } = parsed.data;
  if (name !== undefined && name !== current && (await getVariable(name))) {
    apiError(res, "conflict", `Variable "${name}" already exists`);
    return;
  }

  const patch: Partial<NewVariable> = {
    ...(name !== undefined ? { name } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    updated_by: actor(req),
  };

  if (definition !== undefined) {
    // Masked headers mean "keep the stored secret" — restore them before the
    // definition is flattened into columns.
    const restored: ZVariableDefinition =
      definition.source === "api"
        ? {
            ...definition,
            api: {
              ...definition.api,
              headers: unmaskHeaders(definition.api.headers, existing),
            },
          }
        : definition;
    Object.assign(patch, definitionToColumns(restored));
    patch.sample = resolveSample(
      restored,
      fallback !== undefined ? fallback : existing.fallback,
      sample !== undefined ? sample : existing.sample,
    );
  } else if (sample !== undefined) {
    patch.sample = sample;
  }

  const row = await updateVariable(current, patch);
  await refreshPlaceholders();
  // updateVariable re-reads by the (possibly new) name; a null here means the
  // row vanished between the existence check and the write.
  if (!row) {
    apiError(res, "not_found", `Variable "${current}" no longer exists`);
    return;
  }
  res.json({ variable: serializeVariable(row) });
}

/** DELETE /variables/:name */
export async function deleteVariableHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) return invalidRequest(res, params.error);

  const deleted = await deleteVariable(params.data.name);
  if (!deleted) {
    apiError(res, "not_found", `Variable "${params.data.name}" does not exist`);
    return;
  }
  await refreshPlaceholders();
  res.json({ deleted: true, name: params.data.name });
}
