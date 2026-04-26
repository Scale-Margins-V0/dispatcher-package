/**
 * AWS SES Email Provider
 *
 * Sends emails via AWS SES SDK v3.
 *
 * Required env vars:
 *   AWS_REGION (default: ap-south-1)
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   (or use IAM role-based auth on EC2/ECS/Lambda)
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { EmailProvider, EmailMessage, SendResult, BulkSendResult } from "./types.js";
import { applySesMessageTags } from "../events/outbound/ses-tagger.js";

export class SESProvider implements EmailProvider {
  name = "ses";
  private client: SESClient;

  constructor(region?: string) {
    this.client = new SESClient({
      region: region || process.env.AWS_REGION || "ap-south-1",
    });
    const akidCheck = process.env.AWS_ACCESS_KEY_ID?.trim();
    if (
      akidCheck &&
      !/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(akidCheck) &&
      process.env.VITEST !== "true"
    ) {
      console.warn(
        `[SES] WARNING: AWS_ACCESS_KEY_ID does not look like a real AWS access key ` +
          `(expected 20 chars starting with AKIA or ASIA; got len=${akidCheck.length}, prefix="${akidCheck.slice(0, 4)}"). ` +
          `Likely a leftover export in your shell rc (e.g. ~/.zshrc) overriding .env. ` +
          `SES calls will fail with InvalidClientTokenId. Run: env | grep AWS_`
      );
    }
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const baseInput = {
        Source: message.from,
        Destination: {
          ToAddresses: [message.to],
        },
        Message: {
          Subject: {
            Data: message.subject,
            Charset: "UTF-8",
          },
          Body: {
            Html: {
              Data: message.html,
              Charset: "UTF-8",
            },
            ...(message.text && {
              Text: {
                Data: message.text,
                Charset: "UTF-8",
              },
            }),
          },
        },
        ...(message.replyTo && {
          ReplyToAddresses: [message.replyTo],
        }),
      };
      const input = message.context
        ? applySesMessageTags(baseInput, message.context)
        : baseInput;
      const command = new SendEmailCommand(input);
      const result = await this.client.send(command);

      return {
        success: true,
        messageId: result.MessageId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "SES send failed",
      };
    }
  }

  async sendBulk(messages: EmailMessage[]): Promise<BulkSendResult> {
    const results: BulkSendResult["results"] = [];
    let sent = 0;
    let failed = 0;

    // SES rate limit: ~14 emails/sec for sandbox, higher for production.
    // Sequential send with no delay for simplicity. For high volume,
    // consider batching with SES v2 SendBulkEmail.
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
