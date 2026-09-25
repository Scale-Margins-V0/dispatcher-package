/**
 * Response shape: deriving paths from a sample, and reading values out of a
 * real response the way a template addresses them — `{{user_info.info.pincode}}`.
 */

import { describe, expect, it } from "vitest";
import {
  apiPlaceholders,
  deriveResponseSchema,
  isValidResponsePath,
  MAX_RESPONSE_FIELDS,
  mergeResponseSchema,
  renderValue,
  valueAtPath,
} from "./api-response.js";

const sample = {
  info: {
    firstname: "Ada",
    age: 36,
    verified: true,
    nickname: null,
    address: { city: "London", pincode: "560001" },
  },
  orders: [
    { id: 7, total: 12.5 },
    { id: 8, total: 3 },
  ],
  tags: ["vip", "beta"],
};

describe("deriveResponseSchema", () => {
  // A placeholder lands in a sentence: only single values are offered.
  // Objects and arrays are walked through, never listed themselves.
  it("lists every single-value path with its type and a short example", () => {
    const { fields, skipped, truncated } = deriveResponseSchema(sample);
    expect(fields).toEqual([
      { path: "info.firstname", type: "string", example: "Ada" },
      { path: "info.age", type: "number", example: "36" },
      { path: "info.verified", type: "boolean", example: "true" },
      { path: "info.nickname", type: "null" },
      { path: "info.address.city", type: "string", example: "London" },
      { path: "info.address.pincode", type: "string", example: "560001" },
      { path: "orders.0.id", type: "number", example: "7" },
      { path: "orders.0.total", type: "number", example: "12.5" },
      { path: "tags.0", type: "string", example: "vip" },
    ]);
    expect(fields.map((f) => f.type)).not.toContain("object");
    expect(skipped).toEqual([]);
    expect(truncated).toBe(false);
  });

  // A template token is `{{name.a.b}}` — a key with a dash or space can never
  // be written in one, so offering it would be a lie.
  it("skips keys no template could address, and says which", () => {
    const { fields, skipped } = deriveResponseSchema({ ok: 1, "first-name": "x", "a b": 2, nest: { "x.y": 1 } });
    expect(fields.map((f) => f.path)).toEqual(["ok"]);
    expect(skipped).toEqual(["first-name", "a b", "nest.x.y"]);
  });

  it("describes an array by its first element, not every row", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    expect(deriveResponseSchema({ rows }).fields.map((f) => f.path)).toEqual(["rows.0.id"]);
  });

  it("stops at the field cap and says so", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const out = deriveResponseSchema(wide);
    expect(out.fields).toHaveLength(MAX_RESPONSE_FIELDS);
    expect(out.truncated).toBe(true);
  });

  it("stops at the depth cap and says so", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    const out = deriveResponseSchema(deep);
    // The only value sits past the cap, so nothing is offered — and it says why.
    expect(out.fields).toEqual([]);
    expect(out.truncated).toBe(true);
    const shallow = deriveResponseSchema({ a: { b: { leaf: 1 } } });
    expect(shallow.fields.map((f) => f.path)).toEqual(["a.b.leaf"]);
  });

  it("truncates a long example", () => {
    const [f] = deriveResponseSchema({ bio: "x".repeat(500) }).fields;
    expect(f!.example!.length).toBeLessThanOrEqual(121);
  });
});

describe("valueAtPath / renderValue", () => {
  it.each([
    ["info.firstname", "Ada"],
    ["info.address.pincode", "560001"],
    ["info.age", "36"],
    ["info.verified", "true"],
    ["orders.1.id", "8"],
    ["tags.0", "vip"],
  ])("%s → %s", (path, expected) => {
    expect(renderValue(valueAtPath(sample, path))).toBe(expected);
  });

  it.each([
    "info.nickname",
    "info.missing",
    "orders.9.id",
    "info.firstname.deeper",
    "tags.x",
    // An object or a list is never printed into a message.
    "info.address",
    "orders",
    "orders.0",
    "tags",
  ])(
    "%s has no single value, so the fallback applies",
    (path) => {
      expect(renderValue(valueAtPath(sample, path))).toBeNull();
    }
  );
});

describe("isValidResponsePath", () => {
  it.each(["info", "info.address.pincode", "orders.0.id", "a_b.c1"])("accepts %s", (p) => {
    expect(isValidResponsePath(p)).toBe(true);
  });
  it.each(["", "0", "0.id", "info..x", "info.first-name", "a b", "a.b.c.d.e.f.g.h.i"])("rejects %s", (p) => {
    expect(isValidResponsePath(p)).toBe(false);
  });
});

describe("mergeResponseSchema / apiPlaceholders", () => {
  it("lets an explicit entry override a derived one on the same path", () => {
    const merged = mergeResponseSchema(
      [{ path: "id", type: "number", example: "7" }],
      [{ path: "id", type: "string" }, { path: "extra", type: "string" }]
    );
    expect(merged).toEqual([
      { path: "id", type: "string", example: "7" },
      { path: "extra", type: "string" },
    ]);
  });

  it("offers {{name}} only when a default path picks one value", () => {
    const schema = [{ path: "info.firstname", type: "string" as const }];
    // No default path → {{user_info}} would be the whole response, an object.
    expect(apiPlaceholders("user_info", schema)).toEqual(["user_info.info.firstname"]);
    expect(apiPlaceholders("user_info", schema, "info.firstname")).toEqual([
      "user_info",
      "user_info.info.firstname",
    ]);
    expect(apiPlaceholders("tier", undefined, "data.tier")).toEqual(["tier"]);
  });

  it("never offers an object or array row stored before they were excluded", () => {
    const legacy = [
      { path: "info", type: "object" },
      { path: "orders", type: "array" },
      { path: "info.firstname", type: "string" },
    ] as never;
    expect(apiPlaceholders("u", legacy, "")).toEqual(["u.info.firstname"]);
  });
});
