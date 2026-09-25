/**
 * Seeds 7 days of DUMMY per-minute metrics for one program, so the Atlas
 * campaign metrics page has something to draw before real traffic exists.
 *
 *   tsx scripts/seed-dummy-metrics.ts <programId>           # refuses if rows exist
 *   tsx scripts/seed-dummy-metrics.ts <programId> --reset   # replace that program's rows
 *
 * Uses the program's real step ids and enabled api / SQL variable names when
 * the state DB has them. Includes one incident (an API timing out for ~90
 * minutes, two days ago) so error and latency charts have a story.
 * Deterministic. Dev/demo only — never run against a production state DB.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { hydrateEnvFromYaml } from "../src/config/hydrate.js";
import { createDispatcherDb, setDbSingleton } from "../src/db/client.js";
import { queryDb, tableFor } from "../src/db/dialect-helpers.js";
import { runDispatcherMigrations } from "../src/db/migrate.js";
import { BUCKET_COUNT, bucketIndex } from "../src/metrics/histogram.js";

const programId = process.argv[2];
const reset = process.argv.includes("--reset");
if (!programId || programId.startsWith("--")) {
  console.error("usage: tsx scripts/seed-dummy-metrics.ts <programId> [--reset]");
  process.exit(1);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260925);
/** Log-normal around `median` — latency's usual shape: most fast, a long tail. */
const lognormal = (median: number, spread = 0.6) => {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return median * Math.exp(spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};
const binomial = (n: number, p: number) => {
  // Normal approximation is plenty for demo counts.
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  return Math.max(0, Math.min(n, Math.round(mean + sd * (rand() * 2 - 1) * 1.2)));
};

type Row = Record<string, unknown>;

/** A row whose latency fields come from `count` draws of `draw()` (sampled, then scaled). */
function row(minute: number, step: string, kind: string, subject: string, c: Partial<Row>, draw?: () => number): Row {
  const count = Number(c.count ?? 0);
  const out: Row = {
    id: randomUUID(),
    minute,
    program_id: programId,
    step_id: step,
    kind,
    subject,
    count,
    ok: 0,
    failed: 0,
    timeout: 0,
    skipped: 0,
    fallback: 0,
    items: 0,
    sum_ms: 0,
    min_ms: null,
    max_ms: null,
    peak_per_sec: count > 0 ? Math.max(1, Math.round((count / 60) * (2 + rand() * 5))) : 0,
    ...c,
  };
  const buckets = new Array<number>(BUCKET_COUNT).fill(0);
  const samples = Number(c.samples ?? count);
  delete out.samples;
  if (draw && samples > 0) {
    const k = Math.min(samples, 150);
    const drawn = Array.from({ length: k }, draw).map((ms) => Math.max(1, Math.round(ms)));
    const scale = samples / k;
    drawn.forEach((ms) => {
      buckets[bucketIndex(ms)]! += scale;
    });
    // Integer buckets that still sum to `samples`.
    const rounded = buckets.map(Math.floor);
    let rest = samples - rounded.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % BUCKET_COUNT) {
      if (buckets[i]! > rounded[i]!) {
        rounded[i]! += 1;
        rest -= 1;
      }
    }
    rounded.forEach((n, i) => (buckets[i] = n));
    out.sum_ms = Math.round((drawn.reduce((a, b) => a + b, 0) / k) * samples);
    out.min_ms = Math.min(...drawn);
    out.max_ms = Math.max(...drawn);
  }
  buckets.forEach((n, i) => (out[`b${i}`] = n));
  return out;
}

async function main() {
  hydrateEnvFromYaml();
  const dbx = createDispatcherDb();
  await runDispatcherMigrations(dbx);
  setDbSingleton(dbx);
  const q = queryDb(dbx);
  const metrics = tableFor(dbx, "dispatchMetrics");

  const existing = await q.select({ id: metrics.id }).from(metrics).where(eq(metrics.program_id, programId)).limit(1);
  if (existing.length > 0 && !reset) {
    console.error(`${programId} already has metrics rows — pass --reset to replace them.`);
    process.exit(1);
  }
  if (reset) await q.delete(metrics).where(eq(metrics.program_id, programId));

  const runs = tableFor(dbx, "dispatchRuns");
  const runRows: Array<{ step_id: string | null; provider: string }> = await q
    .select({ step_id: runs.step_id, provider: runs.provider })
    .from(runs)
    .where(eq(runs.program_id, programId));
  const realSteps = [...new Set(runRows.map((r) => r.step_id).filter((s): s is string => Boolean(s)))];
  const steps = realSteps.length > 0 ? realSteps.slice(0, 4) : ["step_welcome", "step_nudge", "step_offer"];
  const provider = runRows.find((r) => r.provider && r.provider !== "multi")?.provider ?? "sendgrid";

  const vars = tableFor(dbx, "variables");
  const varRows: Array<{ name: string; source: string }> = await q
    .select({ name: vars.name, source: vars.source })
    .from(vars)
    .where(and(eq(vars.enabled, true), inArray(vars.source, ["api", "query"])));
  const variables = (varRows.length > 0 ? varRows : [
    { name: "user_info", source: "api" },
    { name: "credit_offer", source: "api" },
    { name: "risk_score", source: "query" },
  ]).slice(0, 6).map((v, i) => ({
    ...v,
    median: v.source === "query" ? 12 + i * 4 : 110 + i * 70,
    // User-specific URLs call once per recipient; the last api var is shared (1 call per batch).
    perRecipient: !(v.source === "api" && i === varRows.length - 1 && varRows.length > 2),
  }));
  const incidentVar = variables.filter((v) => v.source === "api").at(-1)?.name ?? variables[0]?.name;

  const nowMinute = Math.floor(Date.now() / 60_000);
  const start = nowMinute - 7 * 24 * 60 + 5;
  const incidentStart = nowMinute - 2 * 24 * 60 - 180;
  const rows: Row[] = [];

  for (let minute = start; minute <= nowMinute - 1; minute++) {
    const hour = new Date(minute * 60_000).getHours();
    const daytime = hour >= 9 && hour < 21;
    // Drip waves: busy on the hour and half hour in the daytime, a trickle otherwise.
    const wave = minute % 30 < 6;
    const active = rand() < (daytime ? (wave ? 0.95 : 0.35) : wave ? 0.4 : 0.05);
    if (!active) continue;
    const incident = incidentVar !== undefined && minute >= incidentStart && minute < incidentStart + 90;

    for (const [si, step] of steps.entries()) {
      if (rand() > [0.9, 0.6, 0.45, 0.3][si]!) continue;
      const n = Math.max(1, Math.round((daytime ? (wave ? 90 : 25) : 8) * (0.5 + rand()) * [1, 0.6, 0.4, 0.3][si]!));
      const batches = Math.max(1, Math.ceil(n / 50));
      const notFound = binomial(n, 0.004);
      const built = n - notFound;

      rows.push(
        row(minute, step, "lookup", "database", { count: batches, ok: batches, items: n, skipped: notFound }, () =>
          lognormal(35, 0.4)
        )
      );

      let recipientsWithFallback = 0;
      for (const v of variables) {
        const requests = v.perRecipient ? built : batches;
        const slow = incident && v.name === incidentVar;
        const timeouts = binomial(requests, slow ? 0.28 : 0.002);
        const failed = binomial(requests - timeouts, slow ? 0.05 : 0.006);
        const kind = v.source === "api" ? "api_call" : "query_var";
        rows.push(
          row(minute, step, kind, v.name, { count: requests, ok: requests - timeouts - failed, failed, timeout: timeouts }, () =>
            slow && rand() < 0.35 ? 5000 : lognormal(slow ? v.median * 8 : v.median, 0.55)
          )
        );
        const fellBack = v.perRecipient
          ? Math.min(built, timeouts + failed + binomial(built, 0.01))
          : timeouts + failed > 0 ? built : binomial(built, 0.01);
        recipientsWithFallback = Math.max(recipientsWithFallback, fellBack);
        rows.push(row(minute, step, kind, v.name, { count: 0, items: built, fallback: fellBack, peak_per_sec: 0 }));
      }

      const resolveMedian = incident ? 1900 : 420;
      rows.push(
        row(
          minute,
          step,
          "message_resolve",
          "",
          { count: n, ok: built, failed: notFound, fallback: recipientsWithFallback },
          () => lognormal(resolveMedian, 0.5)
        )
      );
      const sendFailed = binomial(built, 0.007);
      const sent = built - sendFailed;
      rows.push(
        row(minute, step, "provider_send", provider, { count: built, ok: sent, failed: sendFailed }, () => lognormal(190, 0.45))
      );
      rows.push(row(minute, step, "message_e2e", "", { count: sent, ok: sent }, () => lognormal(resolveMedian + 900, 0.55)));
      rows.push(
        row(
          minute,
          step,
          "dispatch",
          "email",
          { count: batches, ok: sent, failed: sendFailed + notFound, items: n, samples: batches },
          () => lognormal(resolveMedian * 2 + 50 * 190, 0.35)
        )
      );
    }
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await q.insert(metrics).values(rows.slice(i, i + CHUNK));
  }
  console.log(
    `Seeded ${rows.length} metric rows for ${programId} — steps: ${steps.join(", ")}; variables: ${variables
      .map((v) => v.name)
      .join(", ")}; incident on ${incidentVar}.`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
