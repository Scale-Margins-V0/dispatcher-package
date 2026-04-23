/**
 * Email Provider Interface
 *
 * Implement this interface to add a new email sending provider.
 * Currently supported: AWS SES, SendGrid.
 * To add a new provider (e.g., Mailgun, Postmark):
 *   1. Create a new file in providers/ implementing EmailProvider
 *   2. Register it in providers/index.ts
 */

/** Correlation + callback context echoed on provider webhooks (SendGrid customArgs) or resolved via campaign registry (SES tags). */
export interface SendContext {
  campaign_id: string;
  user_id: string;
  organization_id: string;
  /** Required for forwarding standardized events to ScaleMargin (SendGrid customArgs; SES uses campaign registry). */
  analytics_callback_url: string;
}

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Set by dispatch before send — outbound taggers attach to provider-specific metadata. */
  context?: SendContext;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface BulkSendResult {
  total: number;
  sent: number;
  failed: number;
  results: Array<{
    to: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }>;
}

export interface EmailProvider {
  name: string;

  /**
   * Send a single email message.
   */
  send(message: EmailMessage): Promise<SendResult>;

  /**
   * Send multiple emails. Default implementation sends sequentially,
   * but providers can override for bulk APIs.
   */
  sendBulk(messages: EmailMessage[]): Promise<BulkSendResult>;
}

/**
 * Analytics event types that can be reported back to ScaleMargin.
 * Extended for provider webhooks and WhatsApp-style lifecycle events.
 */
export type AnalyticsEventType =
  | "dispatched"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "unsubscribed"
  | "complained"
  | "failed"
  | "sent"
  | "read"
  | "deferred"
  | "expired";

export type AnalyticsChannel = "email" | "whatsapp" | "sms";

export interface AnalyticsEvent {
  user_id: string;
  event: AnalyticsEventType;
  timestamp: string; // ISO 8601
  channel?: AnalyticsChannel;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsSummary {
  total_sent: number;
  delivered: number;
  bounced: number;
  opened?: number;
  clicked?: number;
  unsubscribed?: number;
  complained?: number;
}

export interface AnalyticsPayload {
  campaign_id: string;
  organization_id: string;
  events?: AnalyticsEvent[];
  summary?: AnalyticsSummary;
}
