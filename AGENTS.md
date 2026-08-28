# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single Node.js/TypeScript service (the **ScaleMargin Dispatch Handler**): an Express API plus a bundled React/Vite admin console served from the same process. There is no separate backend/frontend to run. Node 22 and `pnpm@9.15.4` are already provided; the startup update script runs `pnpm install`.

Standard commands live in `package.json` scripts and are documented in `README.md` and `docs/testing.md`. Use those as the source of truth. Quick reference:

- Lint/build: `pnpm run build` (runs `tsc` for the server plus `tsc` + `vite build` for the admin UI; there is no separate lint step).
- Tests: `pnpm test` (all), `pnpm run test:unit`, `pnpm run test:integration`. Integration tests use SQLite and ephemeral ports — no external services required.
- Run (dev): `pnpm run dev:local` starts the server on port `3100` with `LOCAL_DEV=1`, which fills in insecure placeholder `SCALEMARGIN_*` HMAC secrets so the app boots without real Atlas secrets. Use `pnpm run dev` only when you have real secrets in `.env`.
- Admin UI hot-reload (optional): `pnpm run dev:admin` serves `http://localhost:5173/admin/` and proxies `/admin/api` to port `3100`; you must also have the server (`pnpm run dev:local`) running. When not using Vite, the server serves the pre-built admin from `admin-dist/`, so run `pnpm run build` first if you want the console at `http://localhost:3100/admin`.

Non-obvious gotchas discovered during setup:

- With no `.env`, the app boots zero-config: state DB defaults to SQLite at `./data/dispatcher.db`, and a missing `config/dispatch.yaml` falls back to a built-in **mock** user-lookup. `data/` is gitignored.
- Admin console is **invite-only** (no self-registration). On first boot with an empty DB it seeds an owner using `DISPATCHER_ADMIN_EMAIL` (default `admin@scalemargins.tech`) and `DISPATCHER_ADMIN_PASSWORD` (min 12 chars). If `DISPATCHER_ADMIN_PASSWORD` is unset, a random password is generated and written to `data/initial-admin-credentials.txt`. Set both in `.env` for a known login. This seeding only happens against an empty DB — delete `data/` to re-seed.
- Set `DISPATCHER_TELEMETRY_DISABLED=1` in local `.env` to avoid PostHog network calls during development.
- Email sends require real SES/SendGrid credentials; without them dispatch is accepted/queued but actual sends fail. The dispatch API, admin console, variables, and event pipeline are all testable locally without an email provider.
