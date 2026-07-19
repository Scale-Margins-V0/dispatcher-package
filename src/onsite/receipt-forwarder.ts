/**
 * Converts a browser receipt into a PII-free standardized event and places it
 * in the dispatcher's durable analytics outbox. The original campaign callback
 * registry supplies the authenticated ScaleMargin destination even after a
 * dispatcher restart.
 */

import type { OnsiteActivationRow } from "../db/schema/index.js";
import { getCampaignCallbackDurable } from "../events/campaign-callback-registry.js";
import type { Channel } from "../events/common/types.js";
import { emitEvent } from "../events/index.js";
import type { OnsiteReceiptType } from "./types.js";

function channelOf(value: string): Channel {
  if (value === "whatsapp" || value === "sms") return value;
  return "email";
}

export async function enqueueOnsiteReceipt(params: {
  activation: OnsiteActivationRow;
  occurredAt: string;
  receiptId: string;
  type: OnsiteReceiptType;
}): Promise<void> {
  const callback = await getCampaignCallbackDurable(
    params.activation.campaign_id
  );
  if (!callback) return;

  const eventName = `onsite_${params.type}` as const;
  await emitEvent({
    callbackUrl: callback.analytics_callback_url,
    event: {
      analytics_callback_url: callback.analytics_callback_url,
      campaign_id: params.activation.campaign_id,
      channel: channelOf(params.activation.channel),
      event: eventName,
      idempotency_key: params.receiptId,
      metadata: {
        activation_id: params.activation.id,
        analytics_token: params.activation.analytics_token,
        decision_id: params.activation.decision_id,
        placement: params.activation.placement,
        receipt_id: params.receiptId,
        source: "dispatcher_onsite_receipt",
        touch_id: params.activation.touch_id,
      },
      occurred_at: params.occurredAt,
      organization_id: params.activation.organization_id,
      provider: "onsite",
      provider_message_id: params.activation.id,
      user_id: params.activation.user_id,
    },
  });
}
