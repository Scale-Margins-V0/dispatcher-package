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
    /** Indicates if WhatsApp template/message contains Call-To-Action buttons. */
    has_cta?: boolean;
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
    /**
     * Program correlation, sent by ScaleMargin on every dispatch.
     *
     * A drip step arrives with campaign_id = `drip_{enrollmentId}_{stepId}`,
     * which is unique per (sequence × lead × step) — i.e. the wire id names one
     * SEND, not a campaign. `drip_sequence_id` is the only key that groups a
     * drip back into the thing a human calls "the campaign", and it exists ONLY
     * here (provider webhooks later carry just the wire id). Capture it.
     */
    dispatch_kind?: "drip" | "campaign";
    drip_sequence_id?: string;
    step_id?: string;
    enrollment_id?: string;
    lead_id?: string;
    correlation_id?: string;
    campaign_name?: string;
    variant_id?: string;
    scheduled_at?: string | null;
  };
};
