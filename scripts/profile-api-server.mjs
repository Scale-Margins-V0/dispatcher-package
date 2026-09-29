/**
 * Local profile API for testing API variables — plain Node.js, no dependencies.
 *
 *   GET /api/profile?user_id=sm-001        → that user's profile as nested JSON
 *   GET /health                            → { ok: true }
 *
 * Any user_id returns a profile: the fixture user from
 * scripts/seed/fixtures/users.json when it exists (sm-001 … sm-022), otherwise
 * one made up from the id — the same id always gives the same data. The
 * response nests values the way a real CRM would, so templates can use paths
 * like {{profile.user.info.firstname}}, and carries an offer id per user for
 * testing an API variable's Save response (offer.id).
 *
 *   PROFILE_API_PORT=4000 PROFILE_API_TOKEN=secret node scripts/profile-api-server.mjs
 *
 * With PROFILE_API_TOKEN set, requests need `Authorization: Bearer <token>`.
 */

import http from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PROFILE_API_PORT || 4000);
const TOKEN = process.env.PROFILE_API_TOKEN || "";
const users = new Map(
  JSON.parse(readFileSync(new URL("./seed/fixtures/users.json", import.meta.url), "utf8")).map((u) => [u.user_id, u])
);

const FIRST = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Saanvi", "Vihaan", "Ananya"];
const LAST = ["Sharma", "Patel", "Iyer", "Khan", "Reddy", "Gupta", "Nair", "Das"];
const COMPANY = ["Acme Corp", "Globex", "Initech", "Umbrella", "Stark Industries"];

/** A stable made-up user for an id that is not in the fixtures. */
function madeUp(userId) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const first = FIRST[h % FIRST.length];
  const last = LAST[(h >>> 3) % LAST.length];
  return {
    user_id: userId,
    first_name: first,
    last_name: last,
    email: `${first}.${last}.${h % 1000}@example.com`.toLowerCase(),
    phone: `917016185829`,
    company_name: COMPANY[(h >>> 5) % COMPANY.length],
  };
}

function profile(u) {
  return {
    user: {
      id: u.user_id,
      info: {
        firstname: u.first_name,
        lastname: u.last_name,
        full_name: `${u.first_name} ${u.last_name}`,
        email: u.email,
        phone: u.phone_no,
        company: u.company_name,
      },
    },
    offer: { id: `OF-${u.user_id}`, code: "GOLD", rate: 9.5 },
  };
}

/** Headers as logged — a credential's value never reaches the console. */
const loggedHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, /^(authorization|cookie|x-api-key)$/i.test(k) ? "••••" : v])
  );

http
  .createServer((req, res) => {
    const started = Date.now();
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // Every incoming request, whatever the path.
      console.log(`\n→ ${new Date().toISOString()} ${req.method} ${req.url}`);
      console.log("  headers:", JSON.stringify(loggedHeaders(req.headers)));
      if (body) console.log("  body:", body);

      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
        console.log(`← ${status} (${Date.now() - started}ms) ${text}`);
      };

      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") return send(200, { ok: true });
      if (url.pathname !== "/api/profile" || req.method !== "GET") return send(404, { error: "not found" });
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
      const userId = url.searchParams.get("user_id");
      if (!userId) return send(400, { error: "user_id is required" });
      return send(200, profile(users.get(userId) ?? madeUp(userId)));
    });
  })
  .listen(PORT, () => {
    // How to call it, before any request arrives.
    const example = `http://localhost:${PORT}/api/profile?user_id=sm-001`;
    console.log(`profile API listening on http://localhost:${PORT}\n`);
    console.log("Example request:");
    console.log(`  curl ${TOKEN ? `-H "Authorization: Bearer ${"<PROFILE_API_TOKEN>"}" ` : ""}"${example}"\n`);
    console.log("Example response (200):");
    console.log(JSON.stringify(profile(users.get("sm-001") ?? madeUp("sm-001")), null, 2).replace(/^/gm, "  "));
    console.log("\nAny user_id works — an unknown id gets a made-up user. Waiting for requests…");
  });
