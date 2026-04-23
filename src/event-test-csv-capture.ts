/**
 * Optional dev hook: append verified analytics payloads to CSV when EVENT_TEST_CSV_PATH is set.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Request, Response } from "express";

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function createEventTestCsvCaptureHandler(csvPathRel: string) {
  const csvAbs = resolve(process.cwd(), csvPathRel);
  mkdirSync(dirname(csvAbs), { recursive: true });

  const header =
    "received_at,campaign_id,organization_id,user_id,event,channel,idempotency_key,metadata_json\n";

  return (req: Request, res: Response): void => {
    if (!existsSync(csvAbs)) {
      appendFileSync(csvAbs, header, "utf8");
    }

    const receivedAt = new Date().toISOString();
    const payload = req.body as {
      campaign_id?: string;
      organization_id?: string;
      events?: Array<{
        user_id?: string;
        event?: string;
        channel?: string;
        idempotency_key?: string;
        metadata?: unknown;
      }>;
    };

    const events = Array.isArray(payload.events) ? payload.events : [];
    if (events.length === 0) {
      const row = [
        csvEscape(receivedAt),
        csvEscape(String(payload.campaign_id ?? "")),
        csvEscape(String(payload.organization_id ?? "")),
        "",
        "",
        "",
        "",
        csvEscape(JSON.stringify(payload)),
      ].join(",");
      appendFileSync(csvAbs, row + "\n", "utf8");
    } else {
      for (const ev of events) {
        const row = [
          csvEscape(receivedAt),
          csvEscape(String(payload.campaign_id ?? "")),
          csvEscape(String(payload.organization_id ?? "")),
          csvEscape(String(ev.user_id ?? "")),
          csvEscape(String(ev.event ?? "")),
          csvEscape(String(ev.channel ?? "")),
          csvEscape(String(ev.idempotency_key ?? "")),
          csvEscape(JSON.stringify(ev.metadata ?? {})),
        ].join(",");
        appendFileSync(csvAbs, row + "\n", "utf8");
      }
    }

    res.status(200).json({ received: true, rows_appended: Math.max(1, events.length) });
  };
}
