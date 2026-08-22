import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { buildPayloadForGroup, postAnalyticsWithRetry } from "../events/forwarder.js";
import { persistCampaignEvents } from "../events/persist.js";
import { logPreferenceSideEffectSimulation } from "../events/preference-side-effect-log.js";
import { scrubPii } from "../events/scrubber.js";
import type { StandardizedEvent } from "../events/common/types.js";
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import {
  escapeHtml,
  PUBLIC_PAGE_STYLES,
  renderCloseTabButtonHtml,
  renderLogoHtml,
} from "../public-pages/branding.js";

const log = componentLogger(LogComponent.events);

/**
 * Recipient-selectable email categories. Keys must match
 * `SELECTABLE_SUPPRESSION_CAMPAIGN_TYPES` in the ScaleMargin backend
 * (apps/backend/src/routes/webhooks/shared.ts) so `metadata.campaignType`
 * resolves to a scoped SuppressionEntry instead of falling back to "all".
 */
export const PREFERENCE_CATEGORIES = [
  { key: "newsletter", label: "Newsletter" },
  { key: "promotional", label: "Promotional offers" },
] as const;

function readParam(req: Parameters<RequestHandler>[0], name: string): string | undefined {
  const q = req.query[name];
  if (typeof q === "string" && q.trim().length > 0) return q.trim();
  if (Array.isArray(q) && typeof q[0] === "string" && q[0].trim().length > 0) return q[0].trim();
  return undefined;
}

function readBodyField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[name];
  return typeof v === "string" ? v : undefined;
}

function renderPreferencesPage(params: {
  uid: string;
  campaignId?: string;
  organizationId?: string;
  message?: string;
  checkedCategoryKeys?: ReadonlySet<string>;
}): string {
  const { uid, campaignId, organizationId, message } = params;
  const done = Boolean(message);

  let bodyContent: string;
  if (done) {
    bodyContent = `
    <h1>Email preferences</h1>
    <div class="msg">${escapeHtml(message!)}</div>
    ${renderCloseTabButtonHtml()}`;
  } else {
    const checked =
      params.checkedCategoryKeys ?? new Set(PREFERENCE_CATEGORIES.map((c) => c.key));

    const hiddenFields = [
      `<input type="hidden" name="uid" value="${escapeHtml(uid)}" />`,
      campaignId
        ? `<input type="hidden" name="campaign_id" value="${escapeHtml(campaignId)}" />`
        : "",
      organizationId
        ? `<input type="hidden" name="organization_id" value="${escapeHtml(organizationId)}" />`
        : "",
    ].join("\n      ");

    const categoryRows = PREFERENCE_CATEGORIES.map(
      (c) => `
      <label class="row">
        <input type="checkbox" name="category_${c.key}" value="1" ${checked.has(c.key) ? "checked" : ""} />
        <span>${escapeHtml(c.label)}</span>
      </label>`
    ).join("");

    bodyContent = `
    <h1>Email preferences</h1>
    <p class="sub">Choose which emails you'd like to keep receiving. Unchecking a category stops those emails only — you'll still get everything else.</p>
    <form method="POST" action="/api/preferences">
      ${hiddenFields}${categoryRows}
      <button type="submit" class="save">Save preferences</button>
    </form>
    <form method="POST" action="/api/preferences">
      ${hiddenFields}
      <input type="hidden" name="unsubscribe_all" value="1" />
      <button type="submit" class="unsub">Unsubscribe from all emails</button>
    </form>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Email preferences</title>
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

export function createPreferencesGetHandler(): RequestHandler {
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
      .send(renderPreferencesPage({ uid, campaignId, organizationId }));
  };
}

function buildUnsubscribeEvent(params: {
  uid: string;
  campaignId: string;
  organizationId: string;
  occurredAt: string;
  /** "all" | "newsletter" | "promotional" — always explicit, never left for backend inference. */
  campaignType: string;
}): StandardizedEvent {
  const provider_message_id = createHash("sha256")
    .update(
      `preference_click|${params.uid}|${params.campaignId}|${params.organizationId}|${params.campaignType}|${params.occurredAt}`
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
      source: "preferences_link_click",
      campaignType: params.campaignType,
    }) as StandardizedEvent["metadata"],
  };
}

/**
 * Distinct from "unsubscribed" — records that the recipient interacted with the
 * preference center at all (even a no-op save), regardless of whether anything
 * was actually stopped. Never triggers backend suppression side-effects.
 */
function buildPreferenceUpdateEvent(params: {
  uid: string;
  campaignId: string;
  organizationId: string;
  occurredAt: string;
  kept: readonly string[];
  stopped: readonly string[];
  unsubscribedAll: boolean;
}): StandardizedEvent {
  const provider_message_id = createHash("sha256")
    .update(
      `preference_update|${params.uid}|${params.campaignId}|${params.organizationId}|${params.occurredAt}`
    )
    .digest("hex")
    .slice(0, 40);

  return {
    campaign_id: params.campaignId,
    user_id: params.uid,
    organization_id: params.organizationId,
    channel: "email",
    event: "preference_update",
    provider: "link_click",
    provider_message_id,
    occurred_at: params.occurredAt,
    metadata: scrubPii({
      source: "preferences_link_click",
      kept: params.kept,
      stopped: params.stopped,
      unsubscribed_all: params.unsubscribedAll,
    }) as StandardizedEvent["metadata"],
  };
}

export function createPreferencesPostHandler(): RequestHandler {
  return async (req, res): Promise<void> => {
    const uid = readBodyField(req.body, "uid");
    if (!uid) {
      res.status(400).type("text/plain").send("Missing uid");
      return;
    }

    const campaignId = readBodyField(req.body, "campaign_id");
    const organizationId = readBodyField(req.body, "organization_id");
    const unsubscribeAll = readBodyField(req.body, "unsubscribe_all") === "1";

    const categoriesToStop = unsubscribeAll
      ? []
      : PREFERENCE_CATEGORIES.filter(
          (c) => readBodyField(req.body, `category_${c.key}`) !== "1"
        ).map((c) => c.key);
    const remainingChecked = new Set(
      PREFERENCE_CATEGORIES.map((c) => c.key).filter(
        (key) => !categoriesToStop.includes(key)
      )
    );

    const analyticsUrl = process.env.UNSUBSCRIBE_LINK_ANALYTICS_URL?.trim();
    const secret = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
    const redirect = process.env.PREFERENCES_LINK_REDIRECT_URL?.trim();

    const canProxy =
      Boolean(analyticsUrl) && Boolean(secret) && Boolean(campaignId) && Boolean(organizationId);

    if (!canProxy && analyticsUrl) {
      log.warn(
        { error_category: "incomplete_link_context" },
        "Analytics URL is configured but campaign_id or organization_id is missing — " +
          "preference changes will not be forwarded. Extend preferences_url in dispatch.yaml."
      );
    }

    let forwarded = false;
    // Events exist whenever the form carries correlation; forwarding
    // additionally needs the analytics URL + secret (canProxy).
    if (campaignId && organizationId) {
      const occurredAt = new Date().toISOString();
      // "Unsubscribe from all" is always an explicit campaignType="all" scope —
      // never left for the backend to infer from the campaign's own type.
      const unsubscribeEvents: StandardizedEvent[] = unsubscribeAll
        ? [buildUnsubscribeEvent({ uid, campaignId, organizationId, occurredAt, campaignType: "all" })]
        : categoriesToStop.map((campaignType) =>
            buildUnsubscribeEvent({ uid, campaignId, organizationId, occurredAt, campaignType })
          );

      // Logged on every save (even a no-op) so the preference-center interaction
      // itself is distinguishable from a plain unsubscribe-link click.
      const preferenceUpdateEvent = buildPreferenceUpdateEvent({
        uid,
        campaignId,
        organizationId,
        occurredAt,
        kept: unsubscribeAll ? [] : Array.from(remainingChecked),
        stopped: unsubscribeAll ? PREFERENCE_CATEGORIES.map((c) => c.key) : categoriesToStop,
        unsubscribedAll: unsubscribeAll,
      });
      const events: StandardizedEvent[] = [...unsubscribeEvents, preferenceUpdateEvent];

      for (const event of events) {
        logPreferenceSideEffectSimulation(event);
      }
      await persistCampaignEvents(events);
      if (canProxy && analyticsUrl) {
        const payload = buildPayloadForGroup({
          campaign_id: campaignId,
          organization_id: organizationId,
          events,
        });
        const r = await postAnalyticsWithRetry(analyticsUrl, payload, secret);
        if (!r.success) {
          log.warn(
            { error_category: "analytics_post_failed", error_message: r.error ?? "unknown" },
            "Preference analytics callback failed"
          );
        }
        forwarded = true;
      }
    }

    if (redirect) {
      res.redirect(302, redirect);
      return;
    }

    const message = !canProxy
      ? "Preferences received. Configure UNSUBSCRIBE_LINK_ANALYTICS_URL (+ campaign_id & organization_id in the link) to forward to ScaleMargin."
      : unsubscribeAll
        ? "You've been unsubscribed from all emails."
        : forwarded && categoriesToStop.length > 0
          ? `Preferences saved. You will no longer receive: ${categoriesToStop.join(", ")}.`
          : "Preferences saved. No changes were made.";

    res
      .status(200)
      .type("text/html")
      .send(
        renderPreferencesPage({
          uid,
          campaignId,
          organizationId,
          message,
          checkedCategoryKeys: unsubscribeAll ? new Set() : remainingChecked,
        })
      );
  };
}
