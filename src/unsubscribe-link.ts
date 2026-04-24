/**
 * Browser GET unsubscribe links (same public origin as ngrok event + analytics “double proxy”).
 * Forwards a PII-free `unsubscribed` analytics payload to the same ScaleMargin-style URL as the event pipeline.
 *
 * Env:
 *   UNSUBSCRIBE_LINK_ANALYTICS_URL — optional; when set with uid + campaign_id + organization_id query params,
 *     POSTs a signed batch (SCALEMARGIN_ANALYTICS_SECRET) like /api/webhooks/campaign-analytics/capture.
 *   UNSUBSCRIBE_LINK_REDIRECT_URL — optional; HTTP 302 after handling (e.g. main product “you’re unsubscribed” page).
 */

import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { buildPayloadForGroup, postAnalyticsWithRetry } from "./events/forwarder.js";
import { logPreferenceSideEffectSimulation } from "./events/preference-side-effect-log.js";
import { scrubPii } from "./events/scrubber.js";
import type { StandardizedEvent } from "./events/types.js";

function readParam(req: Parameters<RequestHandler>[0], name: string): string | undefined {
  const q = req.query[name];
  if (typeof q === "string" && q.trim().length > 0) return q.trim();
  if (Array.isArray(q) && typeof q[0] === "string" && q[0].trim().length > 0) return q[0].trim();
  return undefined;
}

function logUnlessVitest(...args: unknown[]): void {
  if (process.env.VITEST === "true") return;
  console.warn(...args);
}

export function createUnsubscribeLinkGetHandler(): RequestHandler {
  return async (req, res): Promise<void> => {
    const uid = readParam(req, "uid");
    if (!uid) {
      res.status(400).type("text/plain").send("Missing uid");
      return;
    }

    const campaign_id = readParam(req, "campaign_id");
    const organization_id = readParam(req, "organization_id");

    const analyticsUrl = process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL?.trim();
    const secret = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
    const redirect = process.env.UNSUBSCRIBE_LINK_REDIRECT_URL?.trim();

    const canProxy =
      Boolean(analyticsUrl) &&
      Boolean(secret) &&
      Boolean(campaign_id) &&
      Boolean(organization_id);

    if (!canProxy && analyticsUrl) {
      logUnlessVitest(
        "[UnsubscribeLink] UNSUBSCRIBE_LINK_ANALYTICS_URL is set but campaign_id or organization_id query param is missing — " +
          "extend unsubscribe_url in dispatch.yaml to append them (see config/dispatch.example.yaml)."
      );
    }

    const occurred_at = new Date().toISOString();
    const provider_message_id = createHash("sha256")
      .update(`link_click|${uid}|${campaign_id ?? ""}|${organization_id ?? ""}|${occurred_at}`)
      .digest("hex")
      .slice(0, 40);

    if (canProxy && analyticsUrl) {
      const std: StandardizedEvent = {
        campaign_id: campaign_id!,
        user_id: uid,
        organization_id: organization_id!,
        channel: "email",
        event: "unsubscribed",
        provider: "link_click",
        provider_message_id,
        occurred_at,
        metadata: scrubPii({ source: "unsubscribe_link_click" }) as StandardizedEvent["metadata"],
      };
      logPreferenceSideEffectSimulation(std);
      const payload = buildPayloadForGroup({
        campaign_id: std.campaign_id,
        organization_id: std.organization_id,
        events: [std],
      });
      const r = await postAnalyticsWithRetry(analyticsUrl, payload, secret);
      if (!r.success) {
        logUnlessVitest(`[UnsubscribeLink] Analytics POST failed: ${r.error ?? "unknown"}`);
      }
    }

    if (redirect) {
      res.redirect(302, redirect);
      return;
    }

    res
      .status(200)
      .type("text/plain")
      .send(
        canProxy
          ? "Unsubscribe recorded."
          : "Unsubscribe link received. Configure UNSUBSCRIBE_LINK_ANALYTICS_URL (+ campaign_id & organization_id in the link) to forward to ScaleMargin."
      );
  };
}
