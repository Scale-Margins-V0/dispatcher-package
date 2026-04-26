/**
 * SQL text generation: Postgres `ANY($1::type[])`, MySQL/SQLite `IN (?,…)`, empty chunk guard.
 */
import { describe, expect, it } from "vitest";
import { buildSelectUsersQuery, sqlChunkSize } from "./sql-build.js";

describe("buildSelectUsersQuery", () => {
  const fields = {
    email: "email",
    first_name: "first_name",
  };

  it("postgres uses ANY with typed array", () => {
    const q = buildSelectUsersQuery(
      "postgres",
      "users",
      "user_id",
      fields,
      ["550e8400-e29b-41d4-a716-446655440000"],
      "uuid"
    );
    expect(q.text).toContain("= ANY($1::uuid[])");
    expect(q.values).toEqual([["550e8400-e29b-41d4-a716-446655440000"]]);
  });

  it("mysql uses IN placeholders", () => {
    const q = buildSelectUsersQuery("mysql", "users", "user_id", fields, ["a", "b"], "string");
    expect(q.text).toMatch(/in\s*\(\s*\?\s*,\s*\?\s*\)/i);
    expect(q.values).toEqual(["a", "b"]);
  });

  it("mysql empty ids yields 1=0 guard", () => {
    const q = buildSelectUsersQuery("mysql", "users", "user_id", fields, [], "string");
    expect(q.text).toMatch(/where\s+1\s*=\s*0/i);
  });
});

describe("sqlChunkSize", () => {
  it("caps sqlite chunk below SQLITE_MAX_VARS", () => {
    expect(sqlChunkSize("sqlite", 2000)).toBe(900);
    expect(sqlChunkSize("mysql", 2000)).toBe(2000);
  });
});
