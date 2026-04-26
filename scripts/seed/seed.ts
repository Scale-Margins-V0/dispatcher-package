/**
 * Idempotent seed: DROP/CREATE users + insert fixtures.
 * Usage: pnpm run seed:sqlite | seed:mysql | seed:postgres
 *
 * Connection env mirrors the dispatch handler (see .env.example).
 */

import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

type FixtureRow = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_no: string | null;
  company_name: string | null;
};

function parseDialect(): "mysql" | "postgres" | "sqlite" {
  const raw = process.argv.find((a) => a.startsWith("--dialect="))?.split("=")[1];
  if (raw === "mysql" || raw === "postgres" || raw === "sqlite") return raw;
  console.error("Usage: tsx scripts/seed/seed.ts --dialect=mysql|postgres|sqlite");
  process.exit(1);
}

function loadFixtures(): FixtureRow[] {
  const raw = readFileSync(join(__dirname, "fixtures", "users.json"), "utf8");
  return JSON.parse(raw) as FixtureRow[];
}

function loadSchema(dialect: string): string {
  return readFileSync(join(__dirname, "schema", `${dialect}.sql`), "utf8");
}

async function seedMysql(fixtures: FixtureRow[]): Promise<void> {
  const pool = await createPool({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    user: process.env.DB_USER || "root",
    password:
      process.env.DB_PASSWORD ??
      (process.env.DB_ALLOW_EMPTY_PASSWORD === "true" ? "" : ""),
    database: process.env.DB_NAME || "mysql",
    multipleStatements: true,
  });
  try {
    await pool.query(loadSchema("mysql"));
    const stmt = `INSERT INTO users (user_id, first_name, last_name, email, phone_no, company_name)
      VALUES (?, ?, ?, ?, ?, ?)`;
    for (const row of fixtures) {
      await pool.execute(stmt, [
        row.user_id,
        row.first_name,
        row.last_name,
        row.email.trim(),
        row.phone_no,
        row.company_name,
      ]);
    }
    console.log(`[seed] Inserted ${fixtures.length} rows into MySQL`);
  } finally {
    await pool.end();
  }
}

async function seedPostgres(fixtures: FixtureRow[]): Promise<void> {
  const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    user: process.env.DB_USER || "postgres",
    password:
      process.env.DB_PASSWORD ??
      (process.env.DB_ALLOW_EMPTY_PASSWORD === "true" ? "" : ""),
    database: process.env.DB_NAME || "postgres",
  });
  try {
    await pool.query(loadSchema("postgres"));
    const stmt = `INSERT INTO users (user_id, first_name, last_name, email, phone_no, company_name)
      VALUES ($1, $2, $3, $4, $5, $6)`;
    for (const row of fixtures) {
      await pool.query(stmt, [
        row.user_id,
        row.first_name,
        row.last_name,
        row.email.trim(),
        row.phone_no,
        row.company_name,
      ]);
    }
    console.log(`[seed] Inserted ${fixtures.length} rows into Postgres`);
  } finally {
    await pool.end();
  }
}

function seedSqlite(fixtures: FixtureRow[]): void {
  const file =
    process.env.DB_FILE || join(__dirname, "..", "..", "data", "dispatch.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec(loadSchema("sqlite"));
    const stmt = db.prepare(
      `INSERT INTO users (user_id, first_name, last_name, email, phone_no, company_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of fixtures) {
      stmt.run(
        row.user_id,
        row.first_name,
        row.last_name,
        row.email.trim(),
        row.phone_no,
        row.company_name
      );
    }
    console.log(`[seed] Inserted ${fixtures.length} rows into SQLite at ${file}`);
  } finally {
    db.close();
  }
}

const dialect = parseDialect();
const fixtures = loadFixtures();

if (dialect === "sqlite") {
  seedSqlite(fixtures);
  process.exit(0);
}

if (dialect === "mysql") {
  await seedMysql(fixtures);
  process.exit(0);
}

await seedPostgres(fixtures);
process.exit(0);
