export type DispatchPayload = {
  campaign_id: string;
  channel: string;
  user_ids: string[];
  dispatch_ids?: Record<string, string>;
  content: {
    subject?: string;
    html_body?: string;
    text_body?: string;
    /** WhatsApp media template caption with {{placeholders}} — triggers SENDMEDIAMESSAGE API. */
    caption?: string;
    /** Public HTTPS URL for the WhatsApp media asset (image, etc.). */
    media_url?: string;
  };
  personalization_fields?: string[];
  images?: Array<{
    placeholder: string;
    url: string;
    raw_url: string;
    content_type: string;
    alt_text?: string;
    base64_data?: string;
  }>;
  metadata: {
    organization_id: string;
    analytics_callback_url: string;
  };
};
