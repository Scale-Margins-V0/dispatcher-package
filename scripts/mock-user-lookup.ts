import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type FixtureRow = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_no: string | null;
  company_name: string | null;
};

const app = express();
app.use(express.json());

const PORT = Number.parseInt(process.env.PROFILE_MOCK_PORT || "4310", 10);
const TOKEN = process.env.PROFILE_API_TOKEN;
const fixturePath = join(
  process.cwd(),
  "scripts",
  "seed",
  "fixtures",
  "scalemargin-test-users.json"
);

function loadFixtures(): FixtureRow[] {
  const raw = readFileSync(fixturePath, "utf8");
  return JSON.parse(raw) as FixtureRow[];
}

app.post("/v1/users:batchGet", (req, res) => {
  if (TOKEN) {
    const auth = req.header("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  const userIds = Array.isArray(req.body?.user_ids)
    ? (req.body.user_ids as string[])
    : [];
  const byId = new Map(loadFixtures().map((row) => [row.user_id, row]));
  const users = userIds
    .map((userId) => byId.get(userId))
    .filter((row): row is FixtureRow => Boolean(row))
    .map((row) => ({
      id: row.user_id,
      user_id: row.user_id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      phone_no: row.phone_no,
      company_name: row.company_name,
    }));
  return res.json({ users });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[mock-user-lookup] listening on http://127.0.0.1:${PORT}`);
  console.log("[mock-user-lookup] POST /v1/users:batchGet");
});
