/**
 * The schema's job is to reject half-finished migrations. A `source:` block left
 * behind under `network` means someone moved half their config, and resolving
 * nobody at run time is a much worse way to find that out.
 */

import { describe, expect, it } from "vitest";
import { userLookupSchema } from "./schema.js";

const database = {
  mode: "database",
  backend: "postgres",
  source: { name: "customers", id_column: "external_id" },
  fields: { email: "email_address" },
} as const;

const network = {
  mode: "network",
  network: { url: "https://api.example.com/lookup", token: "t" },
  fields: { email: "email" },
} as const;

/** First issue path, joined — the assertion people actually want to read. */
function reason(input: unknown): string {
  const r = userLookupSchema.safeParse(input);
  if (r.success) throw new Error("expected the schema to reject this input");
  return `${r.error.issues[0]?.path.join(".")}: ${r.error.issues[0]?.message}`;
}

describe("mode: database", () => {
  it("accepts the minimum and defaults the rest", () => {
    const cfg = userLookupSchema.parse(database);
    expect(cfg).toMatchObject({ mode: "database", backend: "postgres" });
    if (cfg.mode !== "database") throw new Error("narrowing");
    expect(cfg.source.kind).toBe("table");
    expect(cfg.source.id_type).toBe("string");
  });

  it("takes an inline connection, password included", () => {
    const cfg = userLookupSchema.parse({
      ...database,
      connection: { host: "db", port: 5432, user: "ro", password: "pw", database: "c", ssl: true },
    });
    if (cfg.mode !== "database") throw new Error("narrowing");
    expect(cfg.connection?.password).toBe("pw");
  });

  it("leaves the connection optional so DB_* can still supply it", () => {
    const cfg = userLookupSchema.parse(database);
    if (cfg.mode !== "database") throw new Error("narrowing");
    expect(cfg.connection).toBeUndefined();
  });

  it("rejects a network block", () => {
    expect(reason({ ...database, network: { url: "https://x.example" } })).toMatch(/network/);
  });

  it("rejects an unknown backend", () => {
    expect(reason({ ...database, backend: "mongo" })).toMatch(/backend/);
  });

  it("requires source", () => {
    const { source, ...withoutSource } = database;
    void source;
    expect(reason(withoutSource)).toMatch(/source/);
  });
});

describe("mode: network", () => {
  // Accepted here; dropped with a warning when the config is built
  // (from-env-yaml.spec.ts) — a leftover key must not stop a boot.
  it("accepts a personalization field in the map", () => {
    expect(
      userLookupSchema.safeParse({ ...network, fields: { email: "email", first_name: "first_name" } })
        .success
    ).toBe(true);
  });

  it("needs at least one contact field", () => {
    expect(reason({ ...network, fields: {} })).toMatch(/at least one of email or phone/);
  });

  it("accepts a token and defaults timeout and retries", () => {
    const cfg = userLookupSchema.parse(network);
    if (cfg.mode !== "network") throw new Error("narrowing");
    expect(cfg.network.timeout_ms).toBe(3000);
    expect(cfg.network.retries).toBe(2);
  });

  it("accepts token_env instead of an inline token", () => {
    const cfg = userLookupSchema.parse({
      ...network,
      network: { url: "https://api.example.com/lookup", token_env: "LOOKUP_TOKEN" },
    });
    if (cfg.mode !== "network") throw new Error("narrowing");
    expect(cfg.network.token_env).toBe("LOOKUP_TOKEN");
  });

  it("rejects a network block with neither token nor token_env", () => {
    expect(
      reason({ ...network, network: { url: "https://api.example.com/lookup" } })
    ).toMatch(/bearer token/);
  });

  it("rejects a non-URL", () => {
    expect(reason({ ...network, network: { url: "not-a-url", token: "t" } })).toMatch(/url/);
  });

  // id_type lives inside `source`, which network has no business carrying:
  // ids are strings we sent and compare exactly.
  it("rejects a leftover source block", () => {
    expect(
      reason({ ...network, source: { name: "customers", id_column: "id", id_type: "int" } })
    ).toMatch(/source/);
  });

  it("rejects a leftover connection block", () => {
    expect(reason({ ...network, connection: { host: "db" } })).toMatch(/connection/);
  });

  it("rejects a leftover backend", () => {
    expect(reason({ ...network, backend: "postgres" })).toMatch(/backend/);
  });
});

describe("mode: mock", () => {
  it("takes no configuration", () => {
    expect(userLookupSchema.parse({ mode: "mock" })).toEqual({ mode: "mock" });
  });

  it.each(["backend", "source", "connection", "network", "fields", "batch"])(
    "rejects %s — a mock that looks configured is worse than one that obviously is not",
    (key) => {
      expect(reason({ mode: "mock", [key]: {} })).toMatch(new RegExp(key));
    }
  );
});

describe("the discriminator", () => {
  it("rejects an unknown mode", () => {
    expect(reason({ mode: "carrier-pigeon" })).toMatch(/mode/);
  });

  it("rejects a missing mode", () => {
    expect(reason({ backend: "postgres" })).toMatch(/mode/);
  });
});

describe("batch", () => {
  it("defaults", () => {
    const cfg = userLookupSchema.parse({ ...database, batch: {} });
    if (cfg.mode !== "database") throw new Error("narrowing");
    expect(cfg.batch).toEqual({ max_ids_per_query: 1000, dedupe: true });
  });

  it("caps max_ids_per_query so one chunk cannot become the whole campaign", () => {
    expect(reason({ ...database, batch: { max_ids_per_query: 50_000 } })).toMatch(
      /max_ids_per_query/
    );
  });

  it("rejects zero", () => {
    expect(reason({ ...database, batch: { max_ids_per_query: 0 } })).toMatch(
      /max_ids_per_query/
    );
  });
});
