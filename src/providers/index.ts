/**
 * Provider exports. Which account sends is decided by the sender registry
 * (`senders:` in .env.yaml — see ./senders.ts), never by an environment
 * variable; there is deliberately no process-wide "the provider" here.
 */

export { SESProvider } from "./ses.js";
export { SendGridProvider } from "./sendgrid.js";
export { GupshupWhatsAppProvider } from "./gupshup-whatsapp.js";
export {
  registry,
  sendWithFailover,
  resolveSenderPin,
  resolveSenderChainForRecipient,
  orderForRecipient,
  classifyError,
} from "./senders.js";
export type {
  EmailProvider,
  EmailMessage,
  SendResult,
  BulkSendResult,
  Sender,
  SenderConfig,
  SenderChannel,
  SenderProviderType,
  SendAttempt,
} from "./types.js";
