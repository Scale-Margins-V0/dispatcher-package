import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { createVariable, deleteVariable, listVariables, updateVariable } from "../db/repos/variables.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import { personalize, renderPlaceholderPreview, validateComputedExpression } from "../personalize.js";
import { getPlaceholderRegistry, resetDispatchConfigForTests } from "../user-lookup/config.js";
import { importYamlPlaceholdersOnce } from "./import-yaml.js";
import {
  ensurePlaceholdersFresh,
  getPlaceholderSnapshot,
  invalidatePlaceholders,
  refreshPlaceholders,
  resetPlaceholdersForTests,
} from "./service.js";

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
  resetPlaceholdersForTests();
  resetDispatchConfigForTests();
});

afterEach(() => {
  destroyTestDb(dbx);
  resetPlaceholdersForTests();
  resetDispatchConfigForTests();
});

describe("importYamlPlaceholdersOnce", () => {
  it("seeds the variables table from config/defaults exactly once", async () => {
    const first = await importYamlPlaceholdersOnce();
    expect(first.imported).toBeGreaterThan(0);
    const names = (await listVariables()).map((v) => v.name);
    expect(names).toContain("first_name");

    const second = await importYamlPlaceholdersOnce();
    expect(second.imported).toBe(0);
  });

  it("does not re-import after an operator deletes all variables", async () => {
    await importYamlPlaceholdersOnce();
    for (const row of await listVariables()) {
      await deleteVariable(row.name);
    }
    const again = await importYamlPlaceholdersOnce();
    expect(again.imported).toBe(0);
    expect(await listVariables()).toEqual([]);
  });
});

describe("placeholder snapshot", () => {
  it("is null before the first refresh, then reflects enabled variables only", async () => {
    expect(getPlaceholderSnapshot()).toBeNull();
    await createVariable({ name: "nickname", source: "field", field: "nickname", fallback: "friend" });
    await createVariable({ name: "hidden", source: "field", field: "x", enabled: false });
    await refreshPlaceholders();
    const snapshot = getPlaceholderSnapshot();
    expect(snapshot).toMatchObject({
      nickname: { source: "field", field: "nickname", fallback: "friend" },
    });
    expect(snapshot).not.toHaveProperty("hidden");
  });

  it("getPlaceholderRegistry prefers the snapshot; personalize resolves DB variables", async () => {
    await createVariable({ name: "nickname", source: "field", field: "nickname", fallback: "friend" });
    await refreshPlaceholders();
    expect(Object.keys(getPlaceholderRegistry())).toEqual(["nickname"]);

    const out = personalize("Hi {{nickname}}!", {
      user_id: "u1",
      email: "u1@example.com",
      fields: { nickname: "Viv" },
    });
    expect(out).toBe("Hi Viv!");
  });

  it("ensurePlaceholdersFresh picks up edits after invalidation", async () => {
    await createVariable({ name: "greeting", source: "computed", expr: "'Hello ' + first_name" });
    await refreshPlaceholders();
    await updateVariable("greeting", { expr: "'Hey ' + first_name" });
    invalidatePlaceholders();
    await ensurePlaceholdersFresh();
    const snapshot = getPlaceholderSnapshot();
    expect(snapshot?.greeting).toMatchObject({ expr: "'Hey ' + first_name" });
  });
});

describe("validateComputedExpression / preview", () => {
  it("accepts supported expressions", () => {
    expect(validateComputedExpression("first_name + ' ' + last_name")).toEqual({ ok: true });
    expect(validateComputedExpression("env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id")).toEqual({ ok: true });
  });

  it("rejects unsupported expressions with a reason", () => {
    // "eval" here is a hostile-input fixture; the validator must refuse it, nothing executes it.
    expect(validateComputedExpression("eval('x')")).toMatchObject({ ok: false });
    expect(validateComputedExpression("first_name * 2")).toMatchObject({ ok: false });
    expect(validateComputedExpression("   ")).toMatchObject({ ok: false });
  });

  it("renders a sample preview", () => {
    expect(
      renderPlaceholderPreview({ source: "computed", expr: "first_name + ' ' + last_name" })
    ).toBe("Ada Lovelace");
    expect(renderPlaceholderPreview({ source: "field", field: "company_name" })).toBe("Acme Corp");
  });
});
