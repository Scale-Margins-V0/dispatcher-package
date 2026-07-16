import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../client.js";
import { createTestDb, destroyTestDb } from "../test-utils.js";
import {
  parseDripWireCampaignId,
  programOf,
  recordDispatchProgramForPayload,
  resetProgramCacheForTests,
  resolveProgram,
} from "./dispatch-programs.js";

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
  resetProgramCacheForTests();
});

afterEach(() => {
  destroyTestDb(dbx);
  resetProgramCacheForTests();
});

describe("parseDripWireCampaignId", () => {
  it("splits ScaleMargin's drip wire id on the last underscore", () => {
    // Enrollment ids are cuids; the step id follows the final underscore.
    expect(parseDripWireCampaignId("drip_clx123abc_step7")).toEqual({
      enrollmentId: "clx123abc",
      stepId: "step7",
    });
    // Enrollment ids containing underscores still resolve the step correctly.
    expect(parseDripWireCampaignId("drip_enr_with_parts_stepZ")).toEqual({
      enrollmentId: "enr_with_parts",
      stepId: "stepZ",
    });
  });

  it("returns null for anything that isn't a drip wire id", () => {
    expect(parseDripWireCampaignId("cmp_regular")).toBeNull();
    expect(parseDripWireCampaignId("drip_nounderscore")).toBeNull();
  });
});

describe("programOf", () => {
  it("treats a one-shot campaign as its own program", () => {
    expect(
      programOf({ campaign_id: "cmp_1", metadata: { dispatch_kind: "campaign" } })
    ).toEqual({ program_id: "cmp_1", program_kind: "campaign", step_id: null });
  });

  it("groups a drip step under its sequence, not the wire id", () => {
    expect(
      programOf({
        campaign_id: "drip_enr1_step2",
        metadata: { dispatch_kind: "drip", drip_sequence_id: "seq_welcome", step_id: "step2" },
      })
    ).toEqual({ program_id: "seq_welcome", program_kind: "drip", step_id: "step2" });
  });

  it("detects a drip from the wire id even without dispatch_kind", () => {
    expect(programOf({ campaign_id: "drip_enr1_step2" })).toEqual({
      // No sequence id available — group by send rather than guess.
      program_id: "drip_enr1_step2",
      program_kind: "drip",
      step_id: "step2",
    });
  });
});

describe("resolveProgram", () => {
  it("resolves recorded dispatches, including from cold cache", async () => {
    await recordDispatchProgramForPayload({
      campaign_id: "drip_enr1_step2",
      metadata: {
        organization_id: "org_1",
        dispatch_kind: "drip",
        drip_sequence_id: "seq_welcome",
        step_id: "step2",
      },
    });
    // Inbound provider webhooks arrive with only the wire id, in a fresh
    // process — the mapping must come from the DB, not the in-memory cache.
    resetProgramCacheForTests();
    const resolved = await resolveProgram(["drip_enr1_step2"]);
    expect(resolved.get("drip_enr1_step2")).toEqual({
      program_id: "seq_welcome",
      program_kind: "drip",
      step_id: "step2",
    });
  });

  it("collapses a whole sequence's sends onto one program", async () => {
    for (const enr of ["enrA", "enrB"]) {
      for (const step of ["s1", "s2"]) {
        await recordDispatchProgramForPayload({
          campaign_id: `drip_${enr}_${step}`,
          metadata: {
            organization_id: "org_1",
            dispatch_kind: "drip",
            drip_sequence_id: "seq_onboard",
            step_id: step,
          },
        });
      }
    }
    const ids = ["drip_enrA_s1", "drip_enrA_s2", "drip_enrB_s1", "drip_enrB_s2"];
    const resolved = await resolveProgram(ids);
    expect(new Set([...resolved.values()].map((r) => r.program_id))).toEqual(
      new Set(["seq_onboard"])
    );
  });

  it("falls back to the send for an unmapped drip rather than misattributing it", async () => {
    const resolved = await resolveProgram(["drip_unknown_step9", "cmp_plain"]);
    expect(resolved.get("drip_unknown_step9")).toEqual({
      program_id: "drip_unknown_step9",
      program_kind: "drip",
      step_id: "step9",
    });
    expect(resolved.get("cmp_plain")).toEqual({
      program_id: "cmp_plain",
      program_kind: "campaign",
      step_id: null,
    });
  });

  it("re-recording a send updates the mapping without duplicating", async () => {
    const payload = {
      campaign_id: "cmp_1",
      metadata: { organization_id: "org_1", dispatch_kind: "campaign" as const },
    };
    await recordDispatchProgramForPayload(payload);
    await recordDispatchProgramForPayload(payload);
    const resolved = await resolveProgram(["cmp_1"]);
    expect(resolved.get("cmp_1")?.program_id).toBe("cmp_1");
  });
});
