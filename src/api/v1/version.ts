/**
 * Contract version for the /api/v1 tree. Additive changes ship in place and
 * consumers must ignore unknown fields; removing or retyping a field means a
 * new /api/v2 mounted alongside this one.
 */
export const API_VERSION = "v1";

/** Fixed reporting window for the status endpoint — see docs/atlas-api-plan.md §5. */
export const STATUS_WINDOW_DAYS = 30;
