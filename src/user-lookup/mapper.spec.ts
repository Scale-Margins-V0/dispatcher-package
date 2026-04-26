/**
 * `pickByPath`, id coercion, SQL/HTTP row mapping, chunking, identifier validation.
 */
import { describe, expect, it } from "vitest";
import {
  chunkArray,
  coerceIdForType,
  mapHttpRecordToUserRecord,
  mapSqlRowToUserRecord,
  pickByPath,
  stringFromCell,
  validateSafeIdentifier,
} from "./mapper.js";

describe("validateSafeIdentifier", () => {
  it("accepts safe identifiers", () => {
    expect(validateSafeIdentifier("users")).toBe(true);
    expect(validateSafeIdentifier("user_id")).toBe(true);
    expect(validateSafeIdentifier("_x")).toBe(true);
  });
  it("rejects injection-prone tokens", () => {
    expect(validateSafeIdentifier("user;drop")).toBe(false);
    expect(validateSafeIdentifier("1bad")).toBe(false);
    expect(validateSafeIdentifier("")).toBe(false);
  });
});

describe("pickByPath", () => {
  it("reads nested paths", () => {
    expect(pickByPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });
  it("returns undefined for missing segments", () => {
    expect(pickByPath({ a: {} }, "a.b")).toBeUndefined();
  });
  it("supports array index segments", () => {
    expect(pickByPath({ items: [{ name: "x" }] }, "items.0.name")).toBe("x");
  });
});

describe("stringFromCell", () => {
  it("maps nullish to undefined", () => {
    expect(stringFromCell(null)).toBeUndefined();
    expect(stringFromCell(undefined)).toBeUndefined();
  });
  it("trims and drops empty", () => {
    expect(stringFromCell("  hi  ")).toBe("hi");
    expect(stringFromCell("   ")).toBeUndefined();
  });
});

describe("coerceIdForType", () => {
  it("passes string", () => {
    expect(coerceIdForType("  abc  ", "string")).toBe("abc");
  });
  it("validates int", () => {
    expect(coerceIdForType("42", "int")).toBe("42");
    expect(coerceIdForType("4.2", "int")).toBeNull();
  });
  it("validates uuid", () => {
    const u = "550e8400-e29b-41d4-a716-446655440000";
    expect(coerceIdForType(u, "uuid")).toBe(u.toLowerCase());
    expect(coerceIdForType("not-a-uuid", "uuid")).toBeNull();
  });
});

describe("chunkArray", () => {
  it("chunks into fixed sizes", () => {
    const ids = Array.from({ length: 2500 }, (_, i) => String(i));
    const chunks = chunkArray(ids, 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toHaveLength(1000);
    expect(chunks[2]).toHaveLength(500);
  });
});

describe("mapSqlRowToUserRecord", () => {
  it("maps arbitrary field keys into fields", () => {
    const row = {
      user_id: "u1",
      email: "a@b.com",
      title: "VP",
    };
    const u = mapSqlRowToUserRecord(
      "u1",
      row,
      "user_id",
      {
        email: "email",
        job_title: "title",
      },
      "string"
    );
    expect(u).not.toBeNull();
    expect(u!.user_id).toBe("u1");
    expect(u!.email).toBe("a@b.com");
    expect(u!.fields.job_title).toBe("VP");
  });
  it("returns null when email missing", () => {
    expect(
      mapSqlRowToUserRecord(
        "1",
        { user_id: "1", name: "x" },
        "user_id",
        { email: "email" },
        "string"
      )
    ).toBeNull();
  });
});

describe("mapHttpRecordToUserRecord", () => {
  it("maps JSON paths including nested keys", () => {
    const rec = {
      id: "42",
      contact: { primaryEmail: "x@y.com" },
      profile: { role: { title: "Eng" } },
    };
    const u = mapHttpRecordToUserRecord(
      "42",
      rec,
      "id",
      {
        email: "contact.primaryEmail",
        job_title: "profile.role.title",
      },
      "int"
    );
    expect(u).not.toBeNull();
    expect(u!.user_id).toBe("42");
    expect(u!.fields.job_title).toBe("Eng");
  });
});
