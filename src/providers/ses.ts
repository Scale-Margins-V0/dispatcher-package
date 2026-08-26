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

import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { EmailProvider, EmailMessage, SendResult, BulkSendResult } from "./types.js";
import { applySesMessageTags } from "../events/outbound/ses-tagger.js";

export interface SESProviderOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  configurationSet?: string;
}

export class SESProvider implements EmailProvider {
  name = "ses";
  private client: SESClient;
  private configurationSet?: string;

  constructor(optsOrRegion?: string | SESProviderOptions) {
    const opts = typeof optsOrRegion === "string" ? { region: optsOrRegion } : optsOrRegion ?? {};
    const region = opts.region || process.env.AWS_REGION || "ap-south-1";
    this.configurationSet = opts.configurationSet;

    const accessKeyId = opts.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = opts.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;

    this.client = new SESClient({
      region,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId: accessKeyId.trim(),
              secretAccessKey: secretAccessKey.trim(),
            },
          }
        : {}),
    });

    const akidCheck = accessKeyId?.trim();
    if (
      akidCheck &&
      !/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(akidCheck) &&
      process.env.VITEST !== "true"
    ) {
      componentLogger(LogComponent.providers).warn(
        {
          provider: "ses",
          error_category: "invalid_credentials",
          key_length: akidCheck.length,
          key_prefix: akidCheck.slice(0, 4),
        },
        "AWS_ACCESS_KEY_ID does not look like an AWS access key (expected 20 chars, AKIA/ASIA). " +
          "Usually a leftover shell export overriding .env — SES will fail with InvalidClientTokenId"
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
        ? applySesMessageTags(baseInput, message.context, this.configurationSet)
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
