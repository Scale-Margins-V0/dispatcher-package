/**
 * Local mock profile API — CLI entry that listens on PROFILE_MOCK_PORT (default 4310).
 * Core routes live in `src/http-profile-mock-app.ts` (shared with HTTP integration tests).
 *
 * Usage: `PROFILE_MOCK_TOKEN=test-secret pnpm run dev:http-profile-mock`
 * Wire the handler via `config/dispatch.http-mock.example.yaml` (see docs/testing.md).
 */

import { createHttpProfileMockApp } from "../src/http-profile-mock-app.js";

const PORT = parseInt(process.env.PROFILE_MOCK_PORT || "4310", 10);
const PATH = process.env.PROFILE_MOCK_PATH || "/v1/users:batchGet";
const TOKEN = process.env.PROFILE_MOCK_TOKEN;
const REQUEST_ID_FIELD =
  process.env.PROFILE_MOCK_REQUEST_FIELD || "user_ids";
const RESPONSE_ROOT = process.env.PROFILE_MOCK_RESPONSE_ROOT || "users";
const RESPONSE_ID_FIELD = process.env.PROFILE_MOCK_RESPONSE_ID_FIELD || "id";

const app = createHttpProfileMockApp();

app.listen(PORT, () => {
  console.log(`[http-profile-mock] listening on http://127.0.0.1:${PORT}`);
  console.log(`[http-profile-mock] POST ${PATH}`);
  console.log(
    `[http-profile-mock] body: { "${REQUEST_ID_FIELD}": ["sm-001", ...] }`
  );
  console.log(
    `[http-profile-mock] response: { "${RESPONSE_ROOT}": [ { "${RESPONSE_ID_FIELD}", "email", "first_name", ... "contact": { "primaryEmail" } } ] }`
  );
  if (TOKEN) {
    console.log(`[http-profile-mock] auth: Bearer ${TOKEN.slice(0, 4)}…`);
  } else {
    console.log(
      "[http-profile-mock] auth: disabled (set PROFILE_MOCK_TOKEN to require Bearer)"
    );
  }
  console.log(
    `[http-profile-mock] health: GET http://127.0.0.1:${PORT}/health`
  );
});
