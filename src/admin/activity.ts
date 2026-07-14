export type DispatchActivity = {
  id: string;
  campaign_id: string;
  channel: string;
  provider: string;
  status: "accepted" | "completed" | "failed";
  recipient_count: number;
  sent_count?: number;
  failed_count?: number;
  duration_ms?: number;
  occurred_at: string;
  error_category?: string;
};

export type WebhookActivity = {
  id: string;
  provider: string;
  direction: "inbound" | "outbound";
  status: "delivered" | "failed" | "rejected";
  event_count: number;
  http_status?: number;
  duration_ms?: number;
  attempt?: number;
  occurred_at: string;
  destination?: string;
  error_category?: string;
};

const MAX_ITEMS = 200;
const dispatches: DispatchActivity[] = [];
const webhooks: WebhookActivity[] = [];
let acceptedDispatches = 0;

const pushBounded = <T>(items: T[], item: T): void => {
  items.unshift(item);
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
};

const safeId = (value: string): string =>
  value.length <= 80 ? value : `${value.slice(0, 77)}...`;

export const recordDispatchActivity = (
  activity: Omit<DispatchActivity, "campaign_id"> & { campaign_id: string }
): void => {
  const safeActivity = { ...activity, campaign_id: safeId(activity.campaign_id) };
  const existingIndex = dispatches.findIndex((item) => item.id === activity.id);
  if (activity.status === "accepted") acceptedDispatches += 1;
  if (existingIndex >= 0) {
    dispatches.splice(existingIndex, 1);
  }
  pushBounded(dispatches, safeActivity);
};

export const recordWebhookActivity = (activity: WebhookActivity): void =>
  pushBounded(webhooks, activity);

export const redactDestination = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid destination";
  }
};

export const getAdminActivity = () => {
  const completed = dispatches.filter((item) => item.status === "completed");
  const sent = completed.reduce((sum, item) => sum + (item.sent_count ?? 0), 0);
  const failed = completed.reduce((sum, item) => sum + (item.failed_count ?? 0), 0);
  const outbound = webhooks.filter((item) => item.direction === "outbound");
  const deliveredWebhooks = outbound.filter((item) => item.status === "delivered").length;

  return {
    scope: {
      retention: "current_process",
      max_items: MAX_ITEMS,
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    summary: {
      accepted_dispatches: acceptedDispatches,
      completed_dispatches: completed.length,
      sent,
      failed,
      webhook_success_rate: outbound.length
        ? Math.round((deliveredWebhooks / outbound.length) * 1000) / 10
        : null,
    },
    dispatches: dispatches.slice(0, 50),
    failures: [
      ...dispatches.filter((item) => item.status === "failed" || (item.failed_count ?? 0) > 0),
      ...webhooks.filter((item) => item.status !== "delivered"),
    ].slice(0, 50),
    webhooks: webhooks.slice(0, 50),
  };
};

export const resetAdminActivityForTests = (): void => {
  dispatches.length = 0;
  webhooks.length = 0;
  acceptedDispatches = 0;
};
