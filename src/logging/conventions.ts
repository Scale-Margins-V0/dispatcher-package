/**
 * How this codebase logs.
 *
 * Everything here is convention, not machinery — the machinery is
 * `componentLogger` (./logger.ts) and `DbLogSink` (./db-sink.ts). The point of
 * a single file is that a filter built in Atlas keeps working: a field named
 * `campaign_id` in one module and `campaignId` in another is unfilterable, and
 * you only find out when you need the logs.
 *
 * ## The three rules
 *
 * **1. Structured first, prose second.**
 *
 *     log.info({ campaign_id, recipients: 12480 }, "Dispatch started")   // yes
 *     log.info(`Dispatch started for ${campaign_id}: 12480 users`)       // no
 *
 * The second form persists too, but `q=` substring search is all you get back.
 * The first is queryable by field and reads just as well in a terminal.
 *
 * **2. Levels carry cost, so they carry meaning.**
 *
 * | Level   | Use for                                            | Per send? |
 * | ------- | -------------------------------------------------- | --------- |
 * | `error` | The operation failed and someone must act           | yes       |
 * | `warn`  | Degraded but continuing — a fallback, a retry       | yes       |
 * | `info`  | A lifecycle boundary: started, completed, changed   | per RUN   |
 * | `debug` | Per-recipient, per-row detail                       | yes       |
 *
 * **`info` is never per-recipient.** A 50,000-recipient campaign must emit a
 * handful of lines, not 50,000 — the sink batches at 50 rows, so per-recipient
 * info logging turns one send into a thousand extra inserts. Per-recipient
 * belongs at `debug`, which is off unless `DISPATCHER_LOG_LEVEL=debug`, making
 * it free in production and available when someone is actually debugging.
 *
 * **3. Never log a value that came out of the customer's database.**
 *
 * Opaque ids only. No email addresses, no phone numbers, no resolved variable
 * values, no rendered message bodies. The API layer scrubs what it serializes
 * (see `serializeLog`), but that is a net, not a licence — a log line that
 * never contains PII cannot leak it.
 */

/**
 * Canonical field names.
 *
 * Use these exact keys so one Atlas filter works across every component. They
 * match the `app_logs` columns and the ids already on the wire, so a log line
 * joins to a dispatch run or a campaign without translation.
 *
 * `request_id` and `campaign_id` are stamped automatically from
 * AsyncLocalStorage by the logger's mixin — do not pass them by hand.
 */
export const LogField = {
  /** Grouping key a human calls "the campaign" — drip_sequence_id, else campaign_id. */
  programId: "program_id",
  /** Drip step within a program. */
  stepId: "step_id",
  organizationId: "organization_id",
  /** The dispatch_runs row, so a log line joins to a run. */
  dispatchRunId: "dispatch_run_id",
  /** Client's opaque recipient id. NEVER an address. */
  userId: "user_id",
  channel: "channel",
  provider: "provider",
  /** Wall time of the thing just logged, milliseconds. */
  durationMs: "duration_ms",
  /** How many rows/recipients/events the operation handled. */
  count: "count",
  /** Machine-readable failure class, e.g. delivery_failure. */
  errorCategory: "error_category",
  /** HTTP status, for anything that spoke to a remote service. */
  statusCode: "status_code",
  /** Route path, for API handlers. */
  route: "route",
} as const;

/**
 * Component names — the `component` column, and the value an operator filters
 * on first.
 *
 * Dotted, coarse-to-fine (`api.dataplane`, `dispatch.email`). One component per
 * module; a module that needs two is usually two modules.
 *
 * This list is descriptive, not enforced: `componentLogger` takes any string,
 * because a hard union would mean touching this file to add a log line. Keep it
 * current — docs/swagger/atlas-api.yaml publishes it so Atlas can build a
 * filter dropdown.
 */
export const LogComponent = {
  apiDataplane: "api.dataplane",
  apiExternal: "api.external",
  apiStats: "api.stats",
  dispatch: "dispatch",
  dispatchEmail: "dispatch.email",
  dispatchWhatsapp: "dispatch.whatsapp",
  dispatchSendLogs: "dispatch.send-logs",
  providers: "providers",
  providersGupshup: "providers.gupshup",
  providersFreshchat: "providers.freshchat",
  variablesResolver: "variables.resolver",
  events: "events",
  eventsInbound: "events.inbound",
  eventsForwarder: "events.forwarder",
  eventsOutbox: "events.outbox",
  userLookup: "user-lookup",
  server: "server",
  auth: "auth",
  config: "config",
  db: "db",
} as const;

export type LogComponentName = (typeof LogComponent)[keyof typeof LogComponent];

/**
 * Normalize a thrown value into the `{ err }` shape pino serializes into the
 * `stack` column.
 *
 * Catch blocks receive `unknown`; passing a bare string loses the stack, and
 * passing the raw value risks logging a whole response object with a customer
 * record inside it. This keeps the stack and drops everything else.
 */
export function errorFields(error: unknown): { err: Error } {
  return { err: error instanceof Error ? error : new Error(String(error)) };
}
