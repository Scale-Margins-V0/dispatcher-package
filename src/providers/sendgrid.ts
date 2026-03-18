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
      const [response] = await sgMail.send({
        to: message.to,
        from: message.from,
        subject: message.subject,
        html: message.html,
        ...(message.text && { text: message.text }),
        ...(message.replyTo && { replyTo: message.replyTo }),
      });

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
