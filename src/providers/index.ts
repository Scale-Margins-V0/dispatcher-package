/**
 * Provider Registry
 *
 * Central registry for email providers. To add a new provider:
 *   1. Create a class implementing EmailProvider in a new file
 *   2. Register it in PROVIDERS below
 *   3. Set EMAIL_PROVIDER env var to the provider name
 */

import type { EmailProvider } from "./types.js";
import { SESProvider } from "./ses.js";
import { SendGridProvider } from "./sendgrid.js";

export type ProviderName = "ses" | "sendgrid";

const PROVIDERS: Record<ProviderName, () => EmailProvider> = {
  ses: () => new SESProvider(),
  sendgrid: () => new SendGridProvider(),
};

let _instance: EmailProvider | null = null;

/**
 * Get the configured email provider (singleton).
 * Set EMAIL_PROVIDER env var to "ses" or "sendgrid".
 */
export function getProvider(): EmailProvider {
  if (_instance) return _instance;

  const name = (process.env.EMAIL_PROVIDER || "ses") as ProviderName;
  const factory = PROVIDERS[name];

  if (!factory) {
    throw new Error(
      `Unknown email provider: "${name}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }

  _instance = factory();
  if (process.env.VITEST !== "true") {
    console.log(`[Provider] Using email provider: ${_instance.name}`);
  }
  return _instance;
}

export { SESProvider } from "./ses.js";
export { SendGridProvider } from "./sendgrid.js";
export type { EmailProvider, EmailMessage, SendResult, BulkSendResult } from "./types.js";
