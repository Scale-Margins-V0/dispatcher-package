/**
 * Contract version for the /api/v1 tree. Consumers must ignore unknown fields;
 * the additive-change policy is documented in routes/dataplane.route.ts.
 */
export const API_VERSION = "v1";

/** Fixed reporting window for the status endpoint — see docs/atlas-api-plan.md §5. */
export const STATUS_WINDOW_DAYS = 30;
