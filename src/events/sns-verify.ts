/**
 * AWS SNS HTTP(S) notification signature verification (SignatureVersion "1").
 * @see https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

import { createVerify, X509Certificate } from "node:crypto";

export type SnsEnvelope = Record<string, string>;

function headerToString(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

/** Build canonical string to sign for SignatureVersion 1. */
export function buildSnsStringToSign(msg: SnsEnvelope): string {
  const type = msg.Type;
  if (type === "Notification") {
    let sign = "Message\n" + msg.Message + "\nMessageId\n" + msg.MessageId + "\n";
    if (msg.Subject) {
      sign += "Subject\n" + msg.Subject + "\n";
    }
    if (msg.SequenceNumber) {
      sign += "SequenceNumber\n" + msg.SequenceNumber + "\n";
    }
    sign +=
      "Timestamp\n" +
      msg.Timestamp +
      "\nTopicArn\n" +
      msg.TopicArn +
      "\nType\n" +
      msg.Type +
      "\n";
    return sign;
  }
  if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    return (
      "Message\n" +
      msg.Message +
      "\n" +
      "MessageId\n" +
      msg.MessageId +
      "\n" +
      "SubscribeURL\n" +
      msg.SubscribeURL +
      "\n" +
      "Timestamp\n" +
      msg.Timestamp +
      "\n" +
      "Token\n" +
      msg.Token +
      "\n" +
      "TopicArn\n" +
      msg.TopicArn +
      "\n" +
      "Type\n" +
      msg.Type +
      "\n"
    );
  }
  throw new Error(`Unsupported SNS Type for signing: ${type}`);
}

function normalizeSnsBody(body: Record<string, unknown>): SnsEnvelope {
  const out: SnsEnvelope = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export async function verifySnsMessage(
  body: Record<string, unknown>,
  deps: { fetch?: typeof fetch } = {}
): Promise<boolean> {
  const f = deps.fetch ?? globalThis.fetch;
  const msg = normalizeSnsBody(body);
  if (msg.SignatureVersion !== "1") return false;
  const certUrl = msg.SigningCertURL;
  if (!certUrl || !certUrl.startsWith("https://")) return false;
  try {
    const u = new URL(certUrl);
    if (!u.hostname.endsWith(".amazonaws.com")) return false;
  } catch {
    return false;
  }

  let certPem: string;
  try {
    const res = await f(certUrl);
    if (!res.ok) return false;
    certPem = await res.text();
  } catch {
    return false;
  }

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return false;
  }
  const now = new Date();
  if (cert.validTo && new Date(cert.validTo) < now) return false;

  const stringToSign = buildSnsStringToSign(msg);
  const signature = Buffer.from(msg.Signature, "base64");
  const verify = createVerify("RSA-SHA1");
  verify.update(stringToSign, "utf8");
  verify.end();
  return verify.verify(cert.publicKey, signature);
}

export function getHeaderString(
  headers: Record<string, string | string[] | undefined>,
  canonicalName: string
): string | undefined {
  const lower = canonicalName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0];
      return typeof v === "string" ? v : undefined;
    }
  }
  return headerToString(headers, canonicalName);
}
