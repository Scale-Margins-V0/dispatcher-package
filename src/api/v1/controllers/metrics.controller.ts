/**
 * Campaign performance metrics — per-minute rollups of the send path (api and
 * SQL variable calls, user lookup, per-message resolve and send latency).
 * Counts, latencies and variable / provider names only: no user data exists
 * in dispatch_metrics to leak.
 */

import type { Request, Response } from "express";
import { sumMetrics, sumMetricsBy } from "../../../db/repos/metrics.js";
import { metricsRetentionDays } from "../../../db/retention.js";
import { buildMetricsReport, METRIC_RANGES } from "../../../metrics/report.js";
import { invalidRequest } from "../errors.js";
import {
  ZCampaignMetricsQuerySchema,
  ZOverallMetricsQuerySchema,
  ZProgramIdParamSchema,
} from "../validators/dataplane.validator.js";
import { logRejected, requireStateDb } from "./dataplane.controller.js";

/** GET /campaigns/:programId/metrics?range=24h&step_id= */
export async function getCampaignMetricsHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const params = ZProgramIdParamSchema.safeParse(req.params);
  if (!params.success) {
    logRejected("campaigns.metrics", params.error);
    return invalidRequest(res, params.error);
  }
  const query = ZCampaignMetricsQuerySchema.safeParse(req.query);
  if (!query.success) {
    logRejected("campaigns.metrics", query.error);
    return invalidRequest(res, query.error);
  }

  const { range, step_id } = query.data;
  const { minutes, resolution } = METRIC_RANGES[range];
  const toMinute = Math.floor(Date.now() / 60_000);
  const window = {
    programId: params.data.programId,
    fromMinute: toMinute - minutes + 1,
    toMinute,
    resolution,
    ...(step_id ? { stepId: step_id } : {}),
  };
  const [rows, groupRows] = await Promise.all([
    sumMetrics(window),
    sumMetricsBy(window, "step_id"),
  ]);

  res.json({
    metrics: buildMetricsReport({
      programId: window.programId,
      range,
      fromMinute: window.fromMinute,
      toMinute,
      rows,
      groupRows,
      retentionDays: metricsRetentionDays(),
    }),
  });
}

/** GET /metrics?range=24h — every campaign together, plus a per-campaign table. */
export async function getOverallMetricsHandler(req: Request, res: Response): Promise<void> {
  if (!requireStateDb(res)) return;

  const query = ZOverallMetricsQuerySchema.safeParse(req.query);
  if (!query.success) {
    logRejected("metrics.overall", query.error);
    return invalidRequest(res, query.error);
  }

  const { range } = query.data;
  const { minutes, resolution } = METRIC_RANGES[range];
  const toMinute = Math.floor(Date.now() / 60_000);
  const window = { fromMinute: toMinute - minutes + 1, toMinute, resolution };
  const [rows, groupRows] = await Promise.all([sumMetrics(window), sumMetricsBy(window, "program_id")]);

  res.json({
    metrics: buildMetricsReport({
      programId: null,
      range,
      fromMinute: window.fromMinute,
      toMinute,
      rows,
      groupRows,
      retentionDays: metricsRetentionDays(),
    }),
  });
}
