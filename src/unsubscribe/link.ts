import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { buildPayloadForGroup, postAnalyticsWithRetry } from "../events/forwarder.js";
import { logPreferenceSideEffectSimulation } from "../events/preference-side-effect-log.js";
import { scrubPii } from "../events/scrubber.js";
import type { StandardizedEvent } from "../events/common/types.js";
import { componentLogger } from "../logging/logger.js";
import {
  escapeHtml,
  PUBLIC_PAGE_STYLES,
  renderCloseTabButtonHtml,
  renderLogoHtml,
} from "../public-pages/branding.js";
import {
  getUnsubscribeReasons,
  resolveUnsubscribeReasonText,
} from "./reasons.js";

const log = componentLogger("unsubscribe");

function readParam(req: Parameters<RequestHandler>[0], name: string): string | undefined {
  const q = req.query[name];
  if (typeof q === "string" && q.trim().length > 0) return q.trim();
  if (Array.isArray(q) && typeof q[0] === "string" && q[0].trim().length > 0) {
    return q[0].trim();
  }
  return undefined;
}

function readBodyField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[name];
  return typeof v === "string" ? v : undefined;
}

function logUnlessVitest(...args: unknown[]): void {
  if (process.env.VITEST === "true") return;
  const [first, ...rest] = args;
  log.warn(
    rest.length > 0 ? { details: rest } : {},
    typeof first === "string" ? first : JSON.stringify(first)
  );
}

function renderUnsubscribePage(params: {
  uid: string;
  campaignId?: string;
  organizationId?: string;
  message?: string;
  error?: string;
  selectedReasonId?: string;
}): string {
  const { uid, campaignId, organizationId, message, error, selectedReasonId } = params;
  const done = Boolean(message) && !error;

  let bodyContent: string;
  if (done) {
    bodyContent = `
    <h1>Unsubscribe</h1>
    <div class="msg">${escapeHtml(message!)}</div>
    ${renderCloseTabButtonHtml()}`;
  } else {
    const reasons = getUnsubscribeReasons();
    const customReason = reasons.find((r) => r.allowCustom);

    const hiddenFields = [
      `<input type="hidden" name="uid" value="${escapeHtml(uid)}" />`,
      campaignId
        ? `<input type="hidden" name="campaign_id" value="${escapeHtml(campaignId)}" />`
        : "",
      organizationId
        ? `<input type="hidden" name="organization_id" value="${escapeHtml(organizationId)}" />`
        : "",
    ].join("\n      ");

    const reasonRows = reasons
      .map((r) => {
        const checked =
          selectedReasonId === r.id || (!selectedReasonId && reasons[0]?.id === r.id)
            ? "checked"
            : "";
        const otherField =
          r.allowCustom
            ? `
      <div class="other-wrap" id="other-wrap" data-reason-id="${escapeHtml(r.id)}">
        <input type="text" name="reason_other" maxlength="500" placeholder="Please tell us why…" />
      </div>`
            : "";
        return `
      <label class="row">
        <input type="radio" name="reason" value="${escapeHtml(r.id)}" ${checked} />
        <span>${escapeHtml(r.label)}</span>
      </label>${otherField}`;
      })
      .join("");

    const otherToggleScript = customReason
      ? `<script>
(function () {
  var wrap = document.getElementById("other-wrap");
  if (!wrap) return;
  var otherId = wrap.getAttribute("data-reason-id");
  function sync() {
    var checked = document.querySelector('input[name="reason"]:checked');
    var on = checked && checked.value === otherId;
    wrap.classList.toggle("visible", !!on);
  }
  document.querySelectorAll('input[name="reason"]').forEach(function (el) {
    el.addEventListener("change", sync);
  });
  sync();
})();
</script>`
      : "";

    bodyContent = `
    <h1>Unsubscribe</h1>
    <p class="sub">Sorry to see you go. Tell us why you're unsubscribing — it helps us improve.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/api/unsubscribe">
      ${hiddenFields}${reasonRows}
      <button type="submit" class="save">Confirm unsubscribe</button>
    </form>
  ${otherToggleScript}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unsubscribe</title>
<style>
${PUBLIC_PAGE_STYLES}
</style>
</head>
<body>
  <div class="card">
    ${renderLogoHtml()}
    ${bodyContent}
  </div>
</body>
</html>`;
}

function buildUnsubscribeEvent(params: {
  uid: string;
  campaignId: string;
  organizationId: string;
  occurredAt: string;
  reasonId: string;
  reason: string;
}): StandardizedEvent {
  const provider_message_id = createHash("sha256")
    .update(
      `link_click|${params.uid}|${params.campaignId}|${params.organizationId}|${params.reasonId}|${params.occurredAt}`
    )
    .digest("hex")
    .slice(0, 40);

  return {
    campaign_id: params.campaignId,
    user_id: params.uid,
    organization_id: params.organizationId,
    channel: "email",
    event: "unsubscribed",
    provider: "link_click",
    provider_message_id,
    occurred_at: params.occurredAt,
    metadata: scrubPii({
      source: "unsubscribe_link_click",
      reason_id: params.reasonId,
      reason: params.reason,
    }) as StandardizedEvent["metadata"],
  };
}

/** GET /api/unsubscribe — show reason survey (does not record yet). */
export function createUnsubscribeLinkGetHandler(): RequestHandler {
  return (req, res): void => {
    const uid = readParam(req, "uid");
    if (!uid) {
      res.status(400).type("text/plain").send("Missing uid");
      return;
    }

    const campaignId = readParam(req, "campaign_id");
    const organizationId = readParam(req, "organization_id");

    res
      .status(200)
      .type("text/html")
      .send(renderUnsubscribePage({ uid, campaignId, organizationId }));
  };
}

/** POST /api/unsubscribe — record unsubscribe with selected reason. */
export function createUnsubscribeLinkPostHandler(): RequestHandler {
  return async (req, res): Promise<void> => {
    const uid = readBodyField(req.body, "uid");
    if (!uid) {
      res.status(400).type("text/plain").send("Missing uid");
      return;
    }

    const campaignId = readBodyField(req.body, "campaign_id");
    const organizationId = readBodyField(req.body, "organization_id");
    const resolved = resolveUnsubscribeReasonText({
      reasonId: readBodyField(req.body, "reason"),
      otherText: readBodyField(req.body, "reason_other"),
    });

    if (!resolved) {
      res
        .status(400)
        .type("text/html")
        .send(
          renderUnsubscribePage({
            uid,
            campaignId,
            organizationId,
            error: "Please select a reason before unsubscribing.",
          })
        );
      return;
    }

    const analyticsUrl = process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL?.trim();
    const secret = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
    const redirect = process.env.UNSUBSCRIBE_LINK_REDIRECT_URL?.trim();

    const canProxy =
      Boolean(analyticsUrl) &&
      Boolean(secret) &&
      Boolean(campaignId) &&
      Boolean(organizationId);

    if (!canProxy && analyticsUrl) {
      logUnlessVitest(
        "[UnsubscribeLink] UNSUBSCRIBE_LINK_ANALYTICS_URL is set but campaign_id or organization_id query param is missing — " +
          "extend unsubscribe_url in dispatch.yaml to append them (see config/dispatch.example.yaml)."
      );
    }

    if (canProxy && analyticsUrl && campaignId && organizationId) {
      const occurredAt = new Date().toISOString();
      const std = buildUnsubscribeEvent({
        uid,
        campaignId,
        organizationId,
        occurredAt,
        reasonId: resolved.reasonId,
        reason: resolved.reason,
      });
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

    const message = canProxy
      ? "Unsubscribe recorded. You will no longer receive these emails."
      : "Unsubscribe link received. Configure UNSUBSCRIBE_LINK_ANALYTICS_URL (+ campaign_id & organization_id in the link) to forward to ScaleMargin.";

    res
      .status(200)
      .type("text/html")
      .send(
        renderUnsubscribePage({
          uid,
          campaignId,
          organizationId,
          message,
          selectedReasonId: resolved.reasonId,
        })
      );
  };
}
