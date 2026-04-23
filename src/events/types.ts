/**
 * Event pipeline types — provider-agnostic inbound webhooks and outbound standardized events.
 */

import type { AnalyticsEventType } from "../providers/types.js";

export type Channel = "email" | "whatsapp" | "sms";

export type InboundProviderName = "sendgrid" | "ses" | "gupshup";

export interface Correlation {
  campaign_id: string;
  user_id: string;
  organization_id: string;
  /** Present when echoed from SendGrid custom_args; otherwise filled from campaign registry (SES). */
  analytics_callback_url?: string;
}

export interface StandardizedEvent extends Correlation {
  idempotency_key?: string;
  channel: Channel;
  event: AnalyticsEventType;
  provider: InboundProviderName;
  provider_message_id: string;
  occurred_at: string;
  metadata?: {
    bounce_type?: "hard" | "soft" | "block";
    bounce_reason?: string;
    click_url?: string;
    user_agent_family?: string;
    country?: string;
    provider_event_id?: string;
    [key: string]: unknown;
  };
}

/** One event plus where to POST it (after grouping). */
export interface EventEnvelope {
  callbackUrl: string;
  event: StandardizedEvent;
}

export interface SignatureRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface InboundEventAdapter {
  name: InboundProviderName;
  channel: Channel;
  verifySignature(req: SignatureRequest): boolean | Promise<boolean>;
  parseEvents(rawBody: Buffer): unknown[];
  extractCorrelation(event: unknown): Correlation | null;
  stripPii(event: unknown): Record<string, unknown>;
  toStandardEvent(
    stripped: Record<string, unknown>,
    c: Correlation
  ): StandardizedEvent | null;
}

export interface OutboundTaggingAdapter<TMessage = unknown> {
  name: InboundProviderName;
  tag(message: TMessage, ctx: import("../providers/types.js").SendContext): TMessage;
}

export interface EventBuffer {
  push(envelope: EventEnvelope): void;
  /** Remove and return up to `max` envelopes (FIFO). */
  drain(max: number): EventEnvelope[];
  /** Current queue length (approximate for disk buffer). */
  size(): number;
}

/** Escape hatch for providers without echoed metadata (stub in v1). */
export interface LookupTableCorrelator {
  lookup(providerMessageId: string): Correlation | null;
}
