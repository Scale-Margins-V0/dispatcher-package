/**
 * Onsite redeem / session / receipt services (ScaleMargin cross-repo contract).
 *
 * Security model:
 *   - The sm_t token identifies the activation; the FIRST visitor nonce to
 *     redeem it is bound (compare-and-set). Presenting the same nonce again is
 *     idempotent (200); a different nonce is a conflict (409); an expired
 *     activation is gone (410); an unknown token is 404.
 *   - A session lives in the __Host-sm_as cookie and is bound to that nonce,
 *     with a 30m idle and 24h absolute lifetime. GET session needs only the
 *     cookie + page_key and returns 204 when there is nothing active.
 *   - The render payload is always the schema-validated frozen snapshot.
 */

import { SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS } from "./config.js";
import { decryptJson } from "./crypto.js";
import { assembleEnvelope } from "./envelope.js";
import { generateSessionSecret, hashSecret, hashesEqual } from "./tokens.js";
import { enqueueOnsiteReceipt } from "./receipt-forwarder.js";
import {
  decisionSnapshotSchema,
  type OnsiteDecisionSnapshot,
  type OnsiteEnvelope,
  type OnsiteReceiptType,
} from "./types.js";
import {
  bindActivationNonce,
  getActivationById,
  getActivationByTokenHash,
  getOnsiteDecision,
  getSessionByTokenHash,
  insertOnsiteReceipt,
  insertOnsiteSession,
  touchOnsiteSession,
} from "../db/repos/onsite.js";
import type {
  OnsiteActivationRow,
  OnsiteSessionRow,
} from "../db/schema/index.js";

export type ServiceFailure = { ok: false; status: number; error: string };

function decodeSnapshot(ciphertext: string): OnsiteDecisionSnapshot | null {
  try {
    return decisionSnapshotSchema.parse(decryptJson(ciphertext));
  } catch {
    return null;
  }
}

async function envelopeForActivation(
  activation: OnsiteActivationRow
): Promise<OnsiteEnvelope | null> {
  const decision = await getOnsiteDecision(activation.decision_id);
  if (!decision) return null;
  const snapshot = decodeSnapshot(decision.snapshot_ciphertext);
  if (!snapshot) return null;
  return assembleEnvelope(snapshot, activation);
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

export type RedeemResult =
  | {
      ok: true;
      sessionSecret: string;
      idleMaxAgeSeconds: number;
      render: OnsiteEnvelope;
    }
  | ServiceFailure;

export async function redeemActivation(
  input: {
    activation_token: string;
    visitor_nonce: string;
    page_key: string;
    consent_version: string;
  },
  now: Date = new Date()
): Promise<RedeemResult> {
  const activation = await getActivationByTokenHash(
    hashSecret(input.activation_token)
  );
  if (!activation)
    return { ok: false, status: 404, error: "Unknown activation" };
  if (activation.starts_at.getTime() > now.getTime()) {
    return { ok: false, status: 204, error: "Activation is not eligible yet" };
  }
  if (activation.expires_at.getTime() <= now.getTime()) {
    return { ok: false, status: 410, error: "Activation expired" };
  }

  const nonceHash = hashSecret(input.visitor_nonce);
  const bound = await bindActivationNonce(activation.id, nonceHash, now);
  if (!bound) {
    // Already bound: idempotent only if the SAME nonce is presented.
    const current = await getActivationById(activation.id);
    if (
      !current?.visitor_nonce_hash ||
      !hashesEqual(current.visitor_nonce_hash, nonceHash)
    ) {
      return {
        ok: false,
        status: 409,
        error: "Activation already bound to another browser",
      };
    }
  }

  const render = await envelopeForActivation(activation);
  if (!render)
    return {
      ok: false,
      status: 410,
      error: "Activation is no longer available",
    };

  const secret = generateSessionSecret();
  const session: OnsiteSessionRow = {
    id: crypto.randomUUID(),
    activation_id: activation.id,
    decision_id: activation.decision_id,
    campaign_id: activation.campaign_id,
    organization_id: activation.organization_id,
    user_id: activation.user_id,
    session_token_hash: hashSecret(secret),
    nonce_hash: nonceHash,
    page_key: input.page_key,
    consent_version: input.consent_version,
    status: "active",
    created_at: now,
    absolute_expires_at: new Date(
      now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000
    ),
    last_seen_at: now,
  };
  await insertOnsiteSession(session);

  return {
    ok: true,
    sessionSecret: secret,
    idleMaxAgeSeconds: SESSION_IDLE_SECONDS,
    render,
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function isSessionLive(session: OnsiteSessionRow, now: Date): boolean {
  if (session.status !== "active") return false;
  if (now.getTime() >= session.absolute_expires_at.getTime()) return false;
  if (
    now.getTime() >=
    session.last_seen_at.getTime() + SESSION_IDLE_SECONDS * 1000
  )
    return false;
  return true;
}

/** 200 with an envelope, or 204 (nothing active for this cookie + page_key). */
export type SessionResult =
  | { ok: true; render: OnsiteEnvelope }
  | { ok: false };

export async function getOnsiteSession(
  cookieValue: string | null,
  pageKey: string | null,
  now: Date = new Date()
): Promise<SessionResult> {
  if (!cookieValue || !pageKey) return { ok: false };
  const session = await getSessionByTokenHash(hashSecret(cookieValue));
  if (!session || !isSessionLive(session, now)) return { ok: false };
  if (session.page_key !== pageKey) return { ok: false };

  const activation = await getActivationById(session.activation_id);
  if (!activation) return { ok: false };
  const render = await envelopeForActivation(activation);
  if (!render) return { ok: false };

  await touchOnsiteSession(session.id, now);
  return { ok: true, render };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export type ReceiptResult = { ok: true; receipt_id: string } | ServiceFailure;

export async function recordOnsiteReceipt(
  cookieValue: string | null,
  input: {
    activation_id: string;
    receipt_id: string;
    type: OnsiteReceiptType;
    occurred_at: string;
  },
  now: Date = new Date()
): Promise<ReceiptResult> {
  if (!cookieValue) return { ok: false, status: 401, error: "No session" };
  const session = await getSessionByTokenHash(hashSecret(cookieValue));
  if (!session || !isSessionLive(session, now)) {
    return { ok: false, status: 401, error: "Invalid or expired session" };
  }
  // The receipt must be for the activation this session was minted from.
  if (input.activation_id !== session.activation_id) {
    return {
      ok: false,
      status: 409,
      error: "Receipt does not match session activation",
    };
  }

  const activation = await getActivationById(session.activation_id);
  if (!activation) {
    return {
      ok: false,
      status: 410,
      error: "Activation is no longer available",
    };
  }

  await insertOnsiteReceipt({
    id: crypto.randomUUID(),
    receipt_id: input.receipt_id,
    activation_id: session.activation_id,
    decision_id: session.decision_id,
    session_id: session.id,
    campaign_id: session.campaign_id,
    organization_id: session.organization_id,
    user_id: session.user_id,
    type: input.type,
    occurred_at: new Date(input.occurred_at),
    received_at: now,
  });
  await enqueueOnsiteReceipt({
    activation,
    occurredAt: input.occurred_at,
    receiptId: input.receipt_id,
    type: input.type,
  });
  await touchOnsiteSession(session.id, now);

  return { ok: true, receipt_id: input.receipt_id };
}
