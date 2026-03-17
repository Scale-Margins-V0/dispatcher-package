/**
 * Email Provider Interface
 *
 * Implement this interface to add a new email sending provider.
 * Currently supported: AWS SES, SendGrid.
 * To add a new provider (e.g., Mailgun, Postmark):
 *   1. Create a new file in providers/ implementing EmailProvider
 *   2. Register it in providers/index.ts
 */

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
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
 */
export type AnalyticsEventType =
  | "dispatched"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "unsubscribed"
  | "complained";

export interface AnalyticsEvent {
  user_id: string;
  event: AnalyticsEventType;
  timestamp: string; // ISO 8601
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
