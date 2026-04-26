import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type FixtureRow = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_no: string | null;
  company_name: string | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixtures(): FixtureRow[] {
  const raw = readFileSync(
    join(__dirname, "fixtures", "scalemargin-test-users.json"),
    "utf8"
  );
  return JSON.parse(raw) as FixtureRow[];
}

export function runScaleMarginSeed(fileOverride?: string): void {
  const file =
    fileOverride ||
    process.env.DB_FILE ||
    join(__dirname, "..", "..", "data", "dispatch.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone_no TEXT,
      company_name TEXT
    );`);
    const stmt = db.prepare(`
      INSERT INTO users (user_id, first_name, last_name, email, phone_no, company_name)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        first_name=excluded.first_name,
        last_name=excluded.last_name,
        email=excluded.email,
        phone_no=excluded.phone_no,
        company_name=excluded.company_name
    `);
    const fixtures = loadFixtures();
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
    console.log(
      `[seed-scalemargin] Upserted ${fixtures.length} rows into SQLite at ${file}`
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  runScaleMarginSeed();
}
