/**
 * SendGrid Email Provider
 *
 * Sends emails via SendGrid SDK.
 *
 * Required env vars:
 *   SENDGRID_API_KEY
 */

import * as sgMailModule from "@sendgrid/mail";

// @sendgrid/mail exports MailService as both default and named.
// Handle both CJS and ESM resolution patterns.
const sgMail = (sgMailModule as unknown as { default?: typeof sgMailModule }).default || sgMailModule;
import type { EmailProvider, EmailMessage, SendResult, BulkSendResult } from "./types.js";
import { applySendGridCustomArgs } from "../events/outbound/sendgrid-tagger.js";

/**
 * SendGrid replaces this token with the open-tracking pixel when `substitution_tag` is set on
 * `tracking_settings.open_tracking` (Mail Send v3). If the tag is missing from HTML, SendGrid
 * will not record opens for that message.
 * @see https://docs.sendgrid.com/api-reference/mail-send/mail-send (tracking_settings)
 */
const OPEN_TRACK_SUBSTITUTION_TAG = "%open-track%";

function ensureOpenTrackingPixelPlaceholder(payload: Record<string, unknown>): void {
  const ts = payload.tracking_settings as Record<string, unknown> | undefined;
  const ot = ts?.open_tracking as Record<string, unknown> | undefined;
  if (!ot?.enable) return;
  const html = payload.html;
  if (typeof html !== "string" || html.length === 0) return;
  if (html.includes(OPEN_TRACK_SUBSTITUTION_TAG)) return;
  payload.html = `${html}\n<span style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden" aria-hidden="true">${OPEN_TRACK_SUBSTITUTION_TAG}</span>`;
}

export class SendGridProvider implements EmailProvider {
  name = "sendgrid";

  constructor(apiKey?: string) {
    const key = apiKey || process.env.SENDGRID_API_KEY;
    if (!key) {
      throw new Error("SENDGRID_API_KEY is required for SendGrid provider");
    }
    sgMail.setApiKey(key);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const base: Record<string, unknown> = {
        to: message.to,
        from: message.from,
        subject: message.subject,
        html: message.html,
        ...(message.text && { text: message.text }),
        ...(message.replyTo && { replyTo: message.replyTo }),
        // Per-message: still respect account defaults if omitted; explicit true helps when
        // Settings → Tracking has open/click off but you want Activity + Event Webhook opens.
        ...(message.html
          ? {
              tracking_settings: {
                open_tracking: {
                  enable: true,
                  substitution_tag: OPEN_TRACK_SUBSTITUTION_TAG,
                },
                click_tracking: { enable: true, enable_text: false },
              },
            }
          : {}),
      };
      const payload = message.context
        ? applySendGridCustomArgs(base, message.context)
        : base;
      ensureOpenTrackingPixelPlaceholder(payload as Record<string, unknown>);
      const [response] = await sgMail.send(payload as unknown as Parameters<typeof sgMail.send>[0]);

      return {
        success: response.statusCode >= 200 && response.statusCode < 300,
        messageId: response.headers?.["x-message-id"] as string | undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "SendGrid send failed",
      };
    }
  }

  async sendBulk(messages: EmailMessage[]): Promise<BulkSendResult> {
    const results: BulkSendResult["results"] = [];
    let sent = 0;
    let failed = 0;

    // SendGrid supports batch sending via personalizations,
    // but for clarity we send individually here.
    // For high volume, use sgMail.sendMultiple() or personalizations.
    for (const message of messages) {
      const result = await this.send(message);
      results.push({
        to: message.to,
        success: result.success,
        messageId: result.messageId,
        error: result.error,
      });

      if (result.success) {
        sent++;
      } else {
        failed++;
      }
    }

    return { total: messages.length, sent, failed, results };
  }
}
