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
  resolutionStats,
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
import {
  countCampaignSummaries,
  getCampaignSummary,
  listCampaignSummaries,
} from "../../../db/repos/campaign-summary.js";
import {
  listCampaignChannels,
  listProgramSteps,
} from "../../../db/repos/campaign-events.js";
import { countSendLogs, listSendLogsPage } from "../../../db/repos/send-logs.js";
import {
  countLogs,
  getLogById,
  queryLogsPage,
  type LogFilters,
} from "../../../db/repos/logs.js";
import { scrubPii } from "../../../events/scrubber.js";
import type {
  AppLogRow,
  CampaignSummaryRollupRow,
  SendLogRow,
  VariableRow,
} from "../../../db/schema/index.js";
import { getBuildInfo } from "../../../ops/build-info.js";
import { getRuntimeStatus } from "../../../ops/diagnostics.js";
import { renderPlaceholderPreview } from "../../../personalize.js";
import { rowToPlaceholderEntry } from "../../../variables/mapping.js";
import { redactConfig, unmaskHeaders } from "../../../variables/redaction.js";
import { refreshPlaceholders } from "../../../variables/service.js";
import { componentLogger } from "../../../logging/logger.js";
import { LogComponent, errorFields } from "../../../logging/conventions.js";
import { apiError, invalidRequest } from "../errors.js";
import {
  LOG_LEVELS,
  parseRelativeWindow,
  ZCreateVariableSchema,
  ZListCampaignsQuerySchema,
  ZListLogsQuerySchema,
  ZListSendsQuerySchema,
  ZListVariablesQuerySchema,
  ZLogIdParamSchema,
  ZProgramIdParamSchema,
  ZUpdateVariableSchema,
  ZVariableNameParamSchema,
  type ZListLogsQuery,
  type ZVariableDefinition,
} from "../validators/dataplane.validator.js";
import { API_VERSION, STATUS_WINDOW_DAYS } from "../version.js";

const log = componentLogger(LogComponent.apiDataplane);

/**
 * Every request already produces method/route/status/duration in the router's
 * access log, so nothing here repeats that. These helpers record only what the
 * router cannot see: which rule rejected a payload, and what a write changed.
 */
function logRejected(resource: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): void {
  log.warn(
    {
      resource,
      // The failing field paths, not the payload — a rejected variable body can
      // contain a bearer token, and a rejected filter is not worth storing.
      invalid_fields: error.issues.map((issue) => issue.path.join(".")),
      count: error.issues.length,
    },
    `Rejected ${resource} request — failed validation`
  );
}

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

  const [runtime, dbReachable, dispatch, variables, warnings, resolution, lastDispatch] =
    await Promise.all([
      Promise.resolve(getRuntimeStatus()),
      stateDatabaseReachable(),
      dispatchWindowStats(days),
      countVariables(),
      resolutionWarningCount(days),
      resolutionStats(days),
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

  if (state !== "healthy") {
    // The endpoint deliberately answers 200 for a failing dependency, so this
    // is the only place a degraded dispatcher becomes searchable after the fact.
    log.warn(
      {
        state,
        failed_checks: Object.entries(checks)
          .filter(([, check]) => !check.ok)
          .map(([name]) => name),
      },
      `Dispatcher reporting ${state}`
    );
  }

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
      // Real per-recipient rate, from the counters the dispatch path records.
      // Null when nothing was resolved in the window — including on a dispatcher
      // whose runs all predate the instrumentation.
      fallback_rate: resolution?.rate ?? null,
      resolutions_total: resolution?.total ?? null,
      fallbacks_used: resolution?.fallbacks ?? null,
      // Thrown resolution failures, deduplicated by inputs — a different signal
      // from the rate above, kept for continuity.
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
  log.error(
    { status_code: 503 },
    "Refused data-plane request — no state database attached"
  );
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
  if (!query.success) {
    logRejected("variables.list", query.error);
    return invalidRequest(res, query.error);
  }

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
  if (!params.success) {
    logRejected("variables.get", params.error);
    return invalidRequest(res, params.error);
  }

  const row = await getVariable(params.data.name);
  if (!row) {
    log.warn({ variable: params.data.name }, "Variable not found");
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
  if (!parsed.success) {
    logRejected("variables.create", parsed.error);
    return invalidRequest(res, parsed.error);
  }

  const { name, definition, fallback = null, sample, enabled } = parsed.data;
  if (await getVariable(name)) {
    log.warn({ variable: name }, "Variable create rejected — name already exists");
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
  log.info(
    { variable: name, source: definition.source, enabled, has_fallback: fallback !== null },
    "Variable created — applies to the next dispatch"
  );
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
  if (!params.success) {
    logRejected("variables.update", params.error);
    return invalidRequest(res, params.error);
  }

  const parsed = ZUpdateVariableSchema.safeParse(req.body);
  if (!parsed.success) {
    logRejected("variables.update", parsed.error);
    return invalidRequest(res, parsed.error);
  }

  const current = params.data.name;
  const existing = await getVariable(current);
  if (!existing) {
    log.warn({ variable: current }, "Variable update rejected — does not exist");
    apiError(res, "not_found", `Variable "${current}" does not exist`);
    return;
  }

  const { name, definition, fallback, sample, enabled } = parsed.data;
  if (name !== undefined && name !== current && (await getVariable(name))) {
    log.warn(
      { variable: current, rename_to: name },
      "Variable rename rejected — target name already exists"
    );
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
  log.info(
    {
      variable: current,
      // What changed, not what it changed to: a definition body can carry a
      // bearer token, and the new value is already readable via GET.
      changed: Object.keys(parsed.data),
      ...(definition ? { source: definition.source } : {}),
      ...(name && name !== current ? { renamed_to: name } : {}),
    },
    "Variable updated — applies to the next dispatch"
  );
  // updateVariable re-reads by the (possibly new) name; a null here means the
  // row vanished between the existence check and the write.
  if (!row) {
    apiError(res, "not_found", `Variable "${current}" no longer exists`);
    return;
  }
  res.json({ variable: serializeVariable(row) });
}

/*
 * Campaigns
 */

function serializeCampaign(row: CampaignSummaryRollupRow) {
  return {
    program_id: row.program_id,
    program_kind: row.program_kind,
    organization_id: row.organization_id,
    channel: row.channel,
    provider: row.provider,
    template_ref: row.template_ref,
    totals: {
      // Sends, not people — a drip counts one per recipient per step. The
      // headcount is `unique_recipients`, which comes from the event funnel.
      recipients: row.total_recipients,
      unique_recipients: row.unique_recipients,
      sent: row.sent,
      failed: row.failed,
      fallbacks_used: row.fallbacks_used,
    },
    engagement: {
      dispatched: row.dispatched,
      delivered: row.delivered,
      opened: row.opened,
      clicked: row.clicked,
      bounced: row.bounced,
      complained: row.complained,
      unsubscribed: row.unsubscribed,
    },
    first_send_at: row.first_send_at ? row.first_send_at.toISOString() : null,
    last_event_at: row.last_event_at ? row.last_event_at.toISOString() : null,
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * A provider's rejection text is free-form and routinely quotes the address it
 * rejected — "550 5.1.1 <ada@acme.com> does not exist". That would put a
 * recipient email on the wire to ScaleMargin, which ATLAS_API.md §10 promises
 * never happens, so every message goes through the same scrubber the event
 * pipeline uses.
 */
function serializeSendLog(row: SendLogRow) {
  return {
    id: row.id,
    dispatch_run_id: row.dispatch_run_id,
    campaign_id: row.campaign_id,
    program_id: row.program_id,
    step_id: row.step_id,
    user_id: row.user_id,
    channel: row.channel,
    provider: row.provider,
    template_ref: row.template_ref,
    status: row.status,
    provider_message_id: row.provider_message_id,
    latency_ms: row.latency_ms,
    error_category: row.error_category,
    error_message: row.error_message ? scrubPii(row.error_message) : null,
    fallbacks_used: row.fallbacks_used,
    occurred_at: row.occurred_at.toISOString(),
  };
}

/** GET /campaigns — the durable rollup, one row per campaign. */
export async function listCampaignsHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const query = ZListCampaignsQuerySchema.safeParse(req.query);
  if (!query.success) {
    logRejected("campaigns.list", query.error);
    return invalidRequest(res, query.error);
  }

  const { page, limit, ...filters } = query.data;
  const offset = (page - 1) * limit;
  const [total, rows] = await Promise.all([
    countCampaignSummaries(filters),
    listCampaignSummaries(filters, { offset, limit }),
  ]);

  res.json({
    generated_at: new Date().toISOString(),
    meta: pageMeta(total, page, limit),
    campaigns: rows.map(serializeCampaign),
  });
}

/**
 * GET /campaigns/:programId
 *
 * The rollup plus the two things it cannot hold: the full channel/provider set
 * (a drip may span several, while the summary keeps only the latest) and the
 * per-step breakdown.
 */
export async function getCampaignHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZProgramIdParamSchema.safeParse(req.params);
  if (!params.success) {
    logRejected("campaigns.get", params.error);
    return invalidRequest(res, params.error);
  }

  const { programId } = params.data;
  const summary = await getCampaignSummary(programId);
  if (!summary) {
    // Overwhelmingly this is a caller passing a drip's WIRE id
    // (drip_{enrollment}_{step}) where a program_id belongs. Say so, because
    // the 404 alone sends people looking for missing data that is really there.
    log.warn(
      {
        program_id: programId,
        looks_like_wire_id: programId.startsWith("drip_"),
      },
      "Campaign not found"
    );
    apiError(res, "not_found", `Campaign "${programId}" does not exist`);
    return;
  }

  const [channels, steps] = await Promise.all([
    listCampaignChannels([programId]),
    listProgramSteps(programId),
  ]);

  res.json({
    campaign: {
      ...serializeCampaign(summary),
      // Every channel/provider pair this program has ever used — the summary
      // itself keeps only the most recent.
      channels: channels.map(({ channel, provider }) => ({ channel, provider })),
      steps: steps.map((step) => ({
        ...step,
        first_activity: step.first_activity.toISOString(),
        last_activity: step.last_activity.toISOString(),
      })),
    },
  });
}

/** GET /campaigns/:programId/sends — one row per recipient per send. */
export async function listCampaignSendsHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZProgramIdParamSchema.safeParse(req.params);
  if (!params.success) {
    logRejected("campaigns.sends", params.error);
    return invalidRequest(res, params.error);
  }

  const query = ZListSendsQuerySchema.safeParse(req.query);
  if (!query.success) {
    logRejected("campaigns.sends", query.error);
    return invalidRequest(res, query.error);
  }

  const { page, limit, ...filters } = query.data;
  const scoped = { ...filters, program_id: params.data.programId };
  const offset = (page - 1) * limit;
  const [total, rows] = await Promise.all([
    countSendLogs(scoped),
    listSendLogsPage(scoped, { offset, limit }),
  ]);

  res.json({
    generated_at: new Date().toISOString(),
    meta: pageMeta(total, page, limit),
    sends: rows.map(serializeSendLog),
  });
}

/*
 * Logs
 */

/**
 * Log lines are the least structured thing on this surface: `message`, `stack`
 * and `context` are free-form developer output, written by code that was not
 * thinking about a trust boundary. A lookup warning naming the address it could
 * not resolve is an ordinary, useful log line — and a PII leak the moment it
 * crosses to ScaleMargin.
 *
 * So everything a human wrote is scrubbed. Structured fields the dispatcher
 * controls — level, component, ids, timestamps — pass through untouched.
 */
function serializeLog(row: AppLogRow) {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    level: row.level,
    component: row.component,
    request_id: row.request_id,
    campaign_id: row.campaign_id,
    message: scrubPii(row.message),
    stack: row.stack ? scrubPii(row.stack) : null,
    context: row.context ? scrubPii(row.context) : null,
  };
}

/** Turn the validated query into repo filters, resolving `since` into `from`. */
function logFilters(query: ZListLogsQuery): LogFilters {
  // Absolute bounds win over the relative window when both are supplied.
  const from = query.from ?? (query.since ? (parseRelativeWindow(query.since) ?? undefined) : undefined);
  const levels = query.min_level
    ? LOG_LEVELS.slice(LOG_LEVELS.indexOf(query.min_level))
    : undefined;
  return {
    // `min_level` expands to a set and takes precedence over an exact `level`.
    ...(levels ? { levels: [...levels] } : query.level ? { level: query.level } : {}),
    ...(from ? { from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.component ? { component: query.component } : {}),
    ...(query.campaign_id ? { campaign_id: query.campaign_id } : {}),
    ...(query.request_id ? { request_id: query.request_id } : {}),
    ...(query.q ? { q: query.q } : {}),
  };
}

/** GET /logs — the dispatcher's own structured log, filtered and paginated. */
export async function listLogsHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const query = ZListLogsQuerySchema.safeParse(req.query);
  if (!query.success) {
    // Note the feedback loop: this handler reads app_logs, and anything it logs
    // becomes a row the next reader sees. The router's access log already
    // records the request, so only a rejected query is worth a second line —
    // never the successful reads, which an operator refreshes constantly.
    logRejected("logs.list", query.error);
    return invalidRequest(res, query.error);
  }

  const { page, limit, order } = query.data;
  const filters = logFilters(query.data);
  const offset = (page - 1) * limit;
  const [total, rows] = await Promise.all([
    countLogs(filters),
    queryLogsPage(filters, { offset, limit, order }),
  ]);

  res.json({
    generated_at: new Date().toISOString(),
    meta: pageMeta(total, page, limit),
    logs: rows.map(serializeLog),
  });
}

/** GET /logs/:id — one line, including its stack and context. */
export async function getLogHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZLogIdParamSchema.safeParse(req.params);
  if (!params.success) {
    logRejected("logs.get", params.error);
    return invalidRequest(res, params.error);
  }

  const row = await getLogById(params.data.id);
  if (!row) {
    // Very often the row was simply pruned — 14 days / 200k rows by default.
    apiError(res, "not_found", `Log "${params.data.id}" does not exist`);
    return;
  }
  res.json({ log: serializeLog(row) });
}

/** DELETE /variables/:name */
export async function deleteVariableHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZVariableNameParamSchema.safeParse(req.params);
  if (!params.success) {
    logRejected("variables.delete", params.error);
    return invalidRequest(res, params.error);
  }

  const deleted = await deleteVariable(params.data.name);
  if (!deleted) {
    log.warn({ variable: params.data.name }, "Variable delete rejected — does not exist");
    apiError(res, "not_found", `Variable "${params.data.name}" does not exist`);
    return;
  }
  await refreshPlaceholders();
  log.info(
    { variable: params.data.name },
    "Variable deleted — templates referencing it now render empty"
  );
  res.json({ deleted: true, name: params.data.name });
}
