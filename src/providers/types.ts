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
  dispatch_id?: string;
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

export type SenderChannel = "email" | "whatsapp";
export type SenderProviderType = "ses" | "sendgrid" | "gupshup" | "freshchat";

export interface SesSenderConfig {
  region?: string;
  configuration_set?: string;
  access_key_id?: string;
  access_key_id_env?: string;
  secret_access_key?: string;
  secret_access_key_env?: string;
}

export interface SendGridSenderConfig {
  api_key?: string;
  api_key_env?: string;
  event_webhook_public_key?: string;
  event_webhook_public_key_env?: string;
}

export interface GupshupSenderConfig {
  mode?: "api_key" | "enterprise";
  api_key?: string;
  api_key_env?: string;
  user_id?: string;
  user_id_env?: string;
  password?: string;
  password_env?: string;
  src_name?: string;
  source?: string;
  default_template?: string;
  template_language?: string;
  message_type?: string;
  webhook_secret?: string;
  webhook_secret_env?: string;
  template_api_url?: string;
  enterprise_api_url?: string;
  media_api_url?: string;
}

export interface FreshchatSenderConfig {
  mode?: "api_key" | string;
  api_key?: string;
  api_key_env?: string;
  source?: string | number;
  source_env?: string;
  src_name?: string;
  template_api_url?: string;
  api_endpoint?: string;
  api_endpoint_env?: string;
  namespace?: string;
  namespace_env?: string;
  default_template?: string;
  default_template_json?: string;
  template_language?: string;
  from_number?: string;
  from_number_env?: string;
}

export interface SenderFailoverConfig {
  enabled?: boolean;
  max_attempts?: number;
  on_timeout?: boolean;
  on_identity_error?: boolean;
}

export interface SenderConfig {
  id: string;
  channel: SenderChannel;
  provider: SenderProviderType;
  organizations?: string[];
  from?: string;
  reply_to?: string;
  weight?: number;
  enabled?: boolean;
  failover?: SenderFailoverConfig;
  ses?: SesSenderConfig;
  sendgrid?: SendGridSenderConfig;
  gupshup?: GupshupSenderConfig;
  freshchat?: FreshchatSenderConfig;
}

export interface BreakerConfig {
  failure_threshold?: number;
  cooldown_ms?: number;
}

export interface GlobalRoutingFailoverConfig {
  max_attempts?: number;
  on_timeout?: boolean;
  on_identity_error?: boolean;
  breaker?: BreakerConfig;
}

export interface SenderRoutingConfig {
  failover?: GlobalRoutingFailoverConfig;
  default_sender?: {
    email?: string;
    whatsapp?: string;
  };
}

export interface SendAttempt {
  sender_id: string;
  attempt: number;
  provider: string;
  success: boolean;
  error?: string;
  error_category?: string;
  duration_ms?: number;
}

export interface Sender {
  config: SenderConfig;
  provider: EmailProvider | any;
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
  | "expired"
  /** Recipient saved the preference-center screen — logged only, never suppresses. */
  | "preference_update";

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
