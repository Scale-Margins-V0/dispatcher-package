/**
 * Seeds the dispatcher STATE database with realistic campaign console demo data:
 * dispatch runs, per-recipient lifecycle journeys, recipient failures, outbox
 * forwarding attempts, callbacks, webhook activity and correlated logs.
 *
 *   pnpm seed:campaigns            # add/refresh the demo campaigns
 *   pnpm seed:campaigns --reset    # delete demo_* rows first
 *
 * Every row it writes uses a `demo_` campaign-id prefix so --reset can remove
 * exactly what this script created and nothing else. Deterministic: the same
 * seed produces the same journeys, and dedupe_key makes re-runs idempotent.
 */

import { eq, inArray, like } from "drizzle-orm";
import { createDispatcherDb, setDbSingleton } from "../src/db/client.js";
import { queryDb, tableFor } from "../src/db/dialect-helpers.js";
import { runDispatcherMigrations } from "../src/db/migrate.js";
import { insertCampaignEvents } from "../src/db/repos/campaign-events.js";
import type { CampaignEventRow } from "../src/db/schema/index.js";

const PREFIX = "demo_";
const ORG = "org_acme";

/** Deterministic PRNG so reruns and screenshots stay stable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);

type Channel = "email" | "whatsapp";

type CampaignSpec = {
  id: string;
  label: string;
  channel: Channel;
  provider: string;
  recipients: number;
  startedAgo: number;
  /** completed | failed | accepted (in-flight → the console polls it) */
  status: "completed" | "failed" | "accepted";
  callback: boolean;
  rates: {
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
  };
  /** Provider-level blow-up on the run itself. */
  runError?: { category: string; message: string; stack: string };
};

const CAMPAIGNS: CampaignSpec[] = [
  {
    id: `${PREFIX}spring_sale_email`,
    label: "Spring sale — email blast",
    channel: "email",
    provider: "ses",
    recipients: 420,
    startedAgo: 6 * DAY,
    status: "completed",
    callback: true,
    rates: { delivered: 0.95, opened: 0.44, clicked: 0.12, bounced: 0.035, complained: 0.004, unsubscribed: 0.011 },
  },
  {
    id: `${PREFIX}onboarding_drip`,
    label: "Onboarding drip — day 3",
    channel: "email",
    provider: "sendgrid",
    recipients: 180,
    startedAgo: 3 * DAY,
    status: "completed",
    callback: true,
    rates: { delivered: 0.97, opened: 0.61, clicked: 0.28, bounced: 0.012, complained: 0.001, unsubscribed: 0.005 },
  },
  {
    id: `${PREFIX}whatsapp_reminder`,
    label: "Appointment reminder — WhatsApp",
    channel: "whatsapp",
    provider: "gupshup",
    recipients: 96,
    startedAgo: 30 * HOUR,
    status: "completed",
    callback: true,
    // WhatsApp: "read" folds into opened; no click tracking to speak of.
    rates: { delivered: 0.92, opened: 0.73, clicked: 0.04, bounced: 0.05, complained: 0, unsubscribed: 0.01 },
  },
  {
    id: `${PREFIX}winback_no_callback`,
    label: "Win-back — no analytics callback registered",
    channel: "email",
    provider: "ses",
    recipients: 64,
    startedAgo: 20 * HOUR,
    status: "completed",
    callback: false, // events persist for the console but are never forwarded
    rates: { delivered: 0.9, opened: 0.3, clicked: 0.06, bounced: 0.07, complained: 0.01, unsubscribed: 0.02 },
  },
  {
    id: `${PREFIX}broken_credentials`,
    label: "Newsletter — provider rejected the batch",
    channel: "email",
    provider: "sendgrid",
    recipients: 50,
    startedAgo: 5 * HOUR,
    status: "failed",
    callback: true,
    rates: { delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
    runError: {
      category: "provider_auth",
      message: "SendGrid rejected the request: 401 Unauthorized (API key revoked)",
      stack:
        "Error: SendGrid rejected the request: 401 Unauthorized\n" +
        "    at postBatch (src/providers/sendgrid/client.ts:88:11)\n" +
        "    at processDispatch (src/dispatch/processor.ts:142:20)\n" +
        "    at async dispatchHandler (src/index.ts:318:5)",
    },
  },
  {
    id: `${PREFIX}flash_promo_live`,
    label: "Flash promo — dispatch in flight",
    channel: "email",
    provider: "ses",
    recipients: 240,
    startedAgo: 3 * MIN, // inside the 10-min window → campaign.active = true
    status: "accepted",
    callback: true,
    rates: { delivered: 0.42, opened: 0.08, clicked: 0.01, bounced: 0.01, complained: 0, unsubscribed: 0 },
  },
];

const FAILURE_REASONS = [
  { category: "provider_rejected", message: "554 Message rejected: address is on the suppression list" },
  { category: "invalid_recipient", message: "550 5.1.1 The email account that you tried to reach does not exist" },
  { category: "rate_limited", message: "429 Too many requests — provider throttled this batch" },
  { category: "template_render", message: "Placeholder {{first_name}} resolved empty and no fallback was set" },
];

const BOUNCE_REASONS = [
  { bounce_type: "hard", bounce_reason: "550 5.1.1 user unknown" },
  { bounce_type: "hard", bounce_reason: "554 delivery error: mailbox does not exist" },
  { bounce_type: "soft", bounce_reason: "452 4.2.2 mailbox full" },
  { bounce_type: "block", bounce_reason: "550 5.7.1 blocked by recipient policy" },
];

const CLICK_URLS = [
  "https://acme.example/spring-sale?utm_source=email",
  "https://acme.example/pricing",
  "https://acme.example/blog/whats-new",
  "https://acme.example/account/preferences",
];

type Built = {
  events: CampaignEventRow[];
  failures: Record<string, unknown>[];
  sent: number;
  failed: number;
};

function buildCampaign(spec: CampaignSpec, seed: number): Built {
  const rand = rng(seed);
  const events: CampaignEventRow[] = [];
  const failures: Record<string, unknown>[] = [];
  const start = now - spec.startedAgo;
  let sent = 0;
  let failed = 0;

  const push = (
    userId: string,
    event: string,
    offsetMs: number,
    metadata: Record<string, unknown> | null = null
  ) => {
    const occurred = new Date(start + offsetMs);
    const msgId = `${spec.provider}-${spec.id.slice(PREFIX.length, PREFIX.length + 6)}-${userId}`;
    events.push({
      id: crypto.randomUUID(),
      campaign_id: spec.id,
      organization_id: ORG,
      user_id: userId,
      channel: spec.channel,
      event,
      provider: spec.provider,
      provider_message_id: msgId,
      occurred_at: occurred,
      received_at: new Date(occurred.getTime() + Math.floor(rand() * 4_000)),
      metadata,
      // Deterministic → re-running the seeder doesn't duplicate rows.
      program_id: spec.id,
      program_kind: "campaign",
      step_id: null,
      dedupe_key: `demo|${spec.id}|${userId}|${event}|${offsetMs}`,
    });
  };

  for (let i = 0; i < spec.recipients; i += 1) {
    const userId = `usr_${String(10_000 + seed * 1000 + i)}`;

    // A failed run never leaves the provider: only send-time failures.
    if (spec.status === "failed") {
      failed += 1;
      push(userId, "failed", Math.floor(rand() * 30_000), {
        error_category: spec.runError!.category,
        error_message: spec.runError!.message,
      });
      continue;
    }

    // An in-flight run has only reached part of its audience.
    if (spec.status === "accepted" && rand() > 0.55) continue;

    // Send-time failure (never reaches the provider's event stream).
    if (rand() < 0.02) {
      const reason = FAILURE_REASONS[Math.floor(rand() * FAILURE_REASONS.length)];
      failed += 1;
      const at = new Date(start + Math.floor(rand() * 90_000));
      push(userId, "failed", at.getTime() - start, {
        error_category: reason.category,
        error_message: reason.message,
      });
      failures.push({
        id: crypto.randomUUID(),
        dispatch_run_id: "", // filled by the caller once the run id exists
        campaign_id: spec.id,
        user_id: userId,
        provider: spec.provider,
        error_category: reason.category,
        error_message: reason.message,
        error_stack: `Error: ${reason.message}\n    at sendOne (src/dispatch/processor.ts:176:9)`,
        context: { attempt: 1 + Math.floor(rand() * 2), channel: spec.channel },
        occurred_at: at,
      });
      continue;
    }

    sent += 1;
    const dispatchAt = Math.floor(rand() * 4 * MIN);
    push(userId, "dispatched", dispatchAt);

    if (rand() >= spec.rates.delivered) {
      // Not delivered → bounce (asynchronous, minutes later).
      if (rand() < 0.85) {
        const bounce = BOUNCE_REASONS[Math.floor(rand() * BOUNCE_REASONS.length)];
        push(userId, "bounced", dispatchAt + 2 * MIN + Math.floor(rand() * 20 * MIN), bounce);
      }
      continue;
    }

    const deliverAt = dispatchAt + 20_000 + Math.floor(rand() * 3 * MIN);
    push(userId, "delivered", deliverAt, { smtp_response: "250 2.0.0 OK" });

    const openRoll = rand();
    if (openRoll < spec.rates.opened) {
      const openAt = deliverAt + 4 * MIN + Math.floor(rand() * 10 * HOUR);
      // WhatsApp reports reads, email reports opens — same funnel stage.
      push(userId, spec.channel === "whatsapp" ? "read" : "opened", openAt, {
        user_agent_family: rand() < 0.6 ? "Mobile Safari" : "Gmail Image Proxy",
      });

      if (rand() < spec.rates.clicked / Math.max(spec.rates.opened, 0.01)) {
        push(userId, "clicked", openAt + 30_000 + Math.floor(rand() * 40 * MIN), {
          click_url: CLICK_URLS[Math.floor(rand() * CLICK_URLS.length)],
        });
      }

      if (rand() < spec.rates.unsubscribed / Math.max(spec.rates.opened, 0.01)) {
        push(userId, "unsubscribed", openAt + 2 * MIN + Math.floor(rand() * 2 * HOUR), {
          unsubscribe_source: rand() < 0.5 ? "global" : "asm",
          source: "unsubscribe_link_click",
        });
      }

      if (rand() < spec.rates.complained / Math.max(spec.rates.opened, 0.01)) {
        push(userId, "complained", openAt + 5 * MIN + Math.floor(rand() * 6 * HOUR), {
          feedback_type: "abuse",
        });
      }
    }
  }

  return { events, failures, sent, failed };
}

// ---------------------------------------------------------------------------
// A real multi-step, multi-channel drip sequence.
//
// This is the shape that breaks a naive console: ScaleMargin addresses each
// drip step as `drip_{enrollmentId}_{stepId}`, unique per (sequence x lead x
// step). Grouping on that wire id lists one "campaign" per recipient per step —
// here that would be ~700 rows instead of one program with 4 steps.
// ---------------------------------------------------------------------------

const DRIP_PROGRAM = `${PREFIX}seq_welcome_journey`;
const DRIP_STEPS: Array<{ id: string; channel: Channel; provider: string; afterMs: number }> = [
  { id: "step_welcome", channel: "email", provider: "ses", afterMs: 0 },
  { id: "step_tips", channel: "email", provider: "ses", afterMs: 2 * DAY },
  // Channel switches mid-sequence — a program is multi-channel across steps.
  { id: "step_nudge_wa", channel: "whatsapp", provider: "gupshup", afterMs: 4 * DAY },
  { id: "step_offer", channel: "email", provider: "sendgrid", afterMs: 6 * DAY },
];
const DRIP_LEADS = 240;
const DRIP_START_AGO = 8 * DAY;

type DripBuilt = {
  events: CampaignEventRow[];
  runs: Record<string, unknown>[];
  programs: Record<string, unknown>[];
};

function buildDrip(): DripBuilt {
  const rand = rng(9_001);
  const events: CampaignEventRow[] = [];
  const runs: Record<string, unknown>[] = [];
  const programs: Record<string, unknown>[] = [];
  const start = now - DRIP_START_AGO;

  for (let i = 0; i < DRIP_LEADS; i += 1) {
    const userId = `usr_${String(90_000 + i)}`;
    const enrollmentId = `enr${String(700_000 + i)}`;
    let active = true;

    for (const step of DRIP_STEPS) {
      if (!active) break;
      // Later steps only fire for leads still enrolled (the DAG drops the rest).
      if (step.afterMs > 0 && rand() < 0.18) break;

      const wireId = `drip_${enrollmentId}_${step.id}`;
      const stepStart = start + step.afterMs + Math.floor(rand() * 30 * MIN);
      const push = (event: string, offset: number, metadata: Record<string, unknown> | null = null) => {
        const occurred = new Date(stepStart + offset);
        events.push({
          id: crypto.randomUUID(),
          campaign_id: wireId, // the SEND
          program_id: DRIP_PROGRAM, // the sequence — what a human calls the campaign
          program_kind: "drip",
          step_id: step.id,
          organization_id: ORG,
          user_id: userId,
          channel: step.channel,
          event,
          provider: step.provider,
          provider_message_id: `${step.provider}-${step.id}-${userId}`,
          occurred_at: occurred,
          received_at: new Date(occurred.getTime() + Math.floor(rand() * 3_000)),
          metadata,
          dedupe_key: `demo|${wireId}|${event}|${offset}`,
        });
      };

      programs.push({
        campaign_id: wireId,
        program_id: DRIP_PROGRAM,
        program_kind: "drip",
        step_id: step.id,
        organization_id: ORG,
        created_at: new Date(stepStart),
        last_seen_at: new Date(stepStart),
      });
      runs.push({
        id: crypto.randomUUID(),
        campaign_id: wireId,
        program_id: DRIP_PROGRAM,
        program_kind: "drip",
        step_id: step.id,
        organization_id: ORG,
        channel: step.channel,
        provider: step.provider,
        status: "completed",
        recipient_count: 1, // drips fan out one HTTP request per lead
        sent_count: 1,
        failed_count: 0,
        duration_ms: 90 + Math.floor(rand() * 300),
        error_category: null,
        error_message: null,
        error_stack: null,
        occurred_at: new Date(stepStart),
        updated_at: new Date(stepStart),
      });

      push("dispatched", 0);
      if (rand() < 0.05) {
        push("bounced", 3 * MIN, { bounce_type: "hard", bounce_reason: "550 5.1.1 user unknown" });
        active = false;
        continue;
      }
      push("delivered", 25_000 + Math.floor(rand() * MIN), { smtp_response: "250 2.0.0 OK" });

      // WhatsApp reports reads (receipts); email reports opens (pixels).
      const viewRate = step.channel === "whatsapp" ? 0.78 : 0.5;
      if (rand() < viewRate) {
        const viewAt = 5 * MIN + Math.floor(rand() * 8 * HOUR);
        push(step.channel === "whatsapp" ? "read" : "opened", viewAt);
        if (rand() < 0.3) {
          push("clicked", viewAt + Math.floor(rand() * 30 * MIN), {
            click_url: CLICK_URLS[Math.floor(rand() * CLICK_URLS.length)],
          });
        }
        if (rand() < 0.04) {
          push("unsubscribed", viewAt + 2 * MIN, { unsubscribe_source: "global" });
          active = false; // unsubscribing exits the sequence
        }
      }
    }
  }
  return { events, runs, programs };
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  const dbx = createDispatcherDb();
  await runDispatcherMigrations(dbx);
  setDbSingleton(dbx);
  const q = queryDb(dbx);

  const runs = tableFor(dbx, "dispatchRuns");
  const recipientFailures = tableFor(dbx, "dispatchRecipientFailures");
  const campaignEvents = tableFor(dbx, "campaignEvents");
  const outbox = tableFor(dbx, "eventOutbox");
  const callbacks = tableFor(dbx, "campaignCallbacks");
  const webhooks = tableFor(dbx, "webhookActivity");
  const logs = tableFor(dbx, "appLogs");
  const programsTable = tableFor(dbx, "dispatchPrograms");

  if (reset) {
    const ids = CAMPAIGNS.map((c) => c.id);
    await q.delete(campaignEvents).where(inArray(campaignEvents.campaign_id, ids));
    await q.delete(recipientFailures).where(inArray(recipientFailures.campaign_id, ids));
    await q.delete(runs).where(inArray(runs.campaign_id, ids));
    await q.delete(outbox).where(inArray(outbox.campaign_id, ids));
    await q.delete(callbacks).where(inArray(callbacks.campaign_id, ids));
    await q.delete(logs).where(like(logs.campaign_id, `${PREFIX}%`));
    // The drip's rows key on synthetic wire ids, so clear them by program.
    await q.delete(campaignEvents).where(eq(campaignEvents.program_id, DRIP_PROGRAM));
    await q.delete(runs).where(eq(runs.program_id, DRIP_PROGRAM));
    await q.delete(programsTable).where(eq(programsTable.program_id, DRIP_PROGRAM));
    console.log(`Removed existing ${PREFIX}* rows.`);
  }

  let totalEvents = 0;

  for (const [index, spec] of CAMPAIGNS.entries()) {
    const built = buildCampaign(spec, index + 1);
    const runId = crypto.randomUUID();
    const startedAt = ago(spec.startedAgo);

    // Attach the send-time failures to this run.
    for (const failure of built.failures) failure.dispatch_run_id = runId;

    await q.insert(runs).values({
      id: runId,
      campaign_id: spec.id,
      program_id: spec.id,
      program_kind: "campaign",
      step_id: null,
      organization_id: ORG,
      channel: spec.channel,
      provider: spec.provider,
      status: spec.status,
      recipient_count: spec.recipients,
      sent_count: spec.status === "accepted" ? null : built.sent,
      failed_count: spec.status === "accepted" ? null : built.failed,
      duration_ms: spec.status === "accepted" ? null : 800 + spec.recipients * 7,
      error_category: spec.runError?.category ?? null,
      error_message: spec.runError?.message ?? null,
      error_stack: spec.runError?.stack ?? null,
      occurred_at: startedAt,
      updated_at: startedAt,
    });

    // A couple of campaigns were re-run (so the Runs tab has >1 row).
    if (index % 3 === 0 && spec.status === "completed") {
      const retryAt = ago(spec.startedAgo - 40 * MIN);
      await q.insert(runs).values({
        id: crypto.randomUUID(),
        campaign_id: spec.id,
        program_id: spec.id,
        program_kind: "campaign",
        step_id: null,
        organization_id: ORG,
        channel: spec.channel,
        provider: spec.provider,
        status: "completed",
        recipient_count: Math.round(spec.recipients * 0.08),
        sent_count: Math.round(spec.recipients * 0.08),
        failed_count: 0,
        duration_ms: 640,
        error_category: null,
        error_message: null,
        error_stack: null,
        occurred_at: retryAt,
        updated_at: retryAt,
      });
    }

    if (built.failures.length > 0) {
      await q.insert(recipientFailures).values(built.failures);
    }
    await insertCampaignEvents(built.events);
    totalEvents += built.events.length;

    if (spec.callback) {
      await q.insert(callbacks).values({
        campaign_id: spec.id,
        organization_id: ORG,
        analytics_callback_url: `https://acme.example/hooks/scalemargin/analytics?token=demo-${index}`,
        created_at: startedAt,
        last_used_at: ago(Math.max(spec.startedAgo - 2 * HOUR, 5 * MIN)),
      });

      // Forwarding attempts: mostly delivered, a few pending, one stuck failing.
      const outboxRows = built.events.slice(0, 14).map((event, i) => {
        const status = i === 0 ? "failed" : i < 3 ? "pending" : "delivered";
        return {
          id: crypto.randomUUID(),
          callback_url: `https://acme.example/hooks/scalemargin/analytics?token=demo-${index}`,
          campaign_id: spec.id,
          organization_id: ORG,
          event: {
            campaign_id: spec.id,
            user_id: event.user_id,
            organization_id: ORG,
            channel: event.channel,
            event: event.event,
            provider: event.provider,
            provider_message_id: event.provider_message_id,
            occurred_at: event.occurred_at.toISOString(),
            ...(event.metadata ? { metadata: event.metadata } : {}),
          },
          idempotency_key: `${event.dedupe_key}|fwd`,
          status,
          attempts: status === "failed" ? 6 : status === "pending" ? 1 : 1,
          next_attempt_at: event.occurred_at,
          last_error:
            status === "failed"
              ? "POST https://acme.example/hooks/scalemargin/analytics — 503 Service Unavailable (giving up after 6 attempts)"
              : null,
          created_at: event.occurred_at,
          delivered_at: status === "delivered" ? new Date(event.occurred_at.getTime() + 900) : null,
        };
      });
      if (outboxRows.length > 0) await q.insert(outbox).values(outboxRows);
    }

    // Correlated logs so the campaign's Logs tab has something to show.
    const logRows: Record<string, unknown>[] = [
      {
        id: crypto.randomUUID(),
        ts: startedAt,
        level: "info",
        request_id: crypto.randomUUID(),
        campaign_id: spec.id,
        component: "dispatch",
        message: `[Dispatch] Accepted ${spec.recipients} recipients for ${spec.id} via ${spec.provider}`,
        stack: null,
        context: { channel: spec.channel, provider: spec.provider, recipients: spec.recipients },
      },
    ];
    if (spec.runError) {
      logRows.push({
        id: crypto.randomUUID(),
        ts: new Date(startedAt.getTime() + 1200),
        level: "error",
        request_id: crypto.randomUUID(),
        campaign_id: spec.id,
        component: "dispatch",
        message: `[Dispatch] ${spec.runError.message}`,
        stack: spec.runError.stack,
        context: { provider: spec.provider, error_category: spec.runError.category },
      });
    }
    if (!spec.callback) {
      logRows.push({
        id: crypto.randomUUID(),
        ts: new Date(startedAt.getTime() + 5 * MIN),
        level: "warn",
        request_id: crypto.randomUUID(),
        campaign_id: spec.id,
        component: "events",
        message: `[Events][ses] Not forwarding event — no analytics_callback_url, no campaign registry entry, and no valid SCALEMARGIN_ANALYTICS_CALLBACK_URL for ${spec.id}; recorded in the console only`,
        stack: null,
        context: { provider: "ses", persisted_not_forwarded: 1 },
      });
    }
    if (built.failures.length > 0) {
      logRows.push({
        id: crypto.randomUUID(),
        ts: new Date(startedAt.getTime() + 2 * MIN),
        level: "warn",
        request_id: crypto.randomUUID(),
        campaign_id: spec.id,
        component: "dispatch",
        message: `[Dispatch] ${built.failures.length} recipient(s) failed for ${spec.id}`,
        stack: null,
        context: { failed: built.failures.length, sent: built.sent },
      });
    }
    await q.insert(logs).values(logRows);

    console.log(
      `  ${spec.id.padEnd(28)} ${String(spec.recipients).padStart(4)} recipients · ` +
        `${String(built.events.length).padStart(5)} events · ${spec.status}`
    );
  }

  // The drip sequence: many wire sends, one program.
  const drip = buildDrip();
  await q.insert(programsTable).values(drip.programs);
  for (let i = 0; i < drip.runs.length; i += 200) {
    await q.insert(runs).values(drip.runs.slice(i, i + 200));
  }
  await insertCampaignEvents(drip.events);
  await q.insert(callbacks).values({
    campaign_id: DRIP_PROGRAM,
    organization_id: ORG,
    analytics_callback_url: "https://acme.example/hooks/scalemargin/analytics?token=drip",
    created_at: ago(DRIP_START_AGO),
    last_used_at: ago(2 * HOUR),
  });
  await q.insert(logs).values({
    id: crypto.randomUUID(),
    ts: ago(DRIP_START_AGO),
    level: "info",
    request_id: crypto.randomUUID(),
    campaign_id: DRIP_PROGRAM,
    component: "dispatch",
    message: `[Dispatch] Drip ${DRIP_PROGRAM} enrolled ${DRIP_LEADS} leads across ${DRIP_STEPS.length} steps`,
    stack: null,
    context: { steps: DRIP_STEPS.map((s) => s.id), channels: ["email", "whatsapp"] },
  });
  totalEvents += drip.events.length;
  console.log(
    `  ${DRIP_PROGRAM.padEnd(28)} ${String(DRIP_LEADS).padStart(4)} leads      · ` +
      `${String(drip.events.length).padStart(5)} events · drip (${DRIP_STEPS.length} steps, ` +
      `${drip.runs.length} wire sends)`
  );

  // Global outbound forwarding health (the hub's webhook success rate).
  const webhookRows = Array.from({ length: 40 }, (_, i) => {
    const failedAttempt = i % 11 === 0;
    return {
      id: crypto.randomUUID(),
      provider: "scalemargin",
      direction: "outbound",
      status: failedAttempt ? "failed" : "delivered",
      event_count: 1 + Math.floor(rng(i + 99)() * 25),
      http_status: failedAttempt ? 503 : 200,
      duration_ms: 40 + Math.floor(rng(i + 7)() * 400),
      attempt: failedAttempt ? 3 : 1,
      destination: "https://acme.example/hooks/scalemargin/analytics",
      error_category: failedAttempt ? "http_error" : null,
      error_message: failedAttempt ? "503 Service Unavailable" : null,
      occurred_at: ago(Math.floor(rng(i + 3)() * 20 * HOUR)),
    };
  });
  await q.insert(webhooks).values(webhookRows);

  console.log(
    `\nSeeded ${CAMPAIGNS.length} demo campaigns · ${totalEvents} lifecycle events · ` +
      `${webhookRows.length} forwarding attempts.\nOpen the console at /admin#campaigns`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
