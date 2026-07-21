---
"scalemargin-dispatch-handler": minor
---

Replace the single shared-credential admin login with real multi-user authentication (Better Auth): individual accounts, roles, and organization-based members + invitations, all persisted in the state database. The console is now invite-only with a **Settings** area (Members, Invitations, Account, Organization); invitations produce a copyable link (emailed automatically when a provider is configured) and a brand-new invitee sets their name/password via the accept-invite page. On first boot a default `ScaleMargin` owner is seeded — password from `DISPATCHER_ADMIN_PASSWORD` or generated and revealed once (log + `data/initial-admin-credentials.txt`). New env: `DISPATCHER_ADMIN_EMAIL`, `BETTER_AUTH_SECRET`, `DISPATCHER_PUBLIC_URL`; `DISPATCHER_ADMIN_USER` / `DISPATCHER_ADMIN_SESSION_SECRET` are removed.
