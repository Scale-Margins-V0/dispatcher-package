# Building the dispatcher image and publishing to GitHub Container Registry

**Audience:** Us. This is the internal release runbook — what the image contains, how to build it reproducibly, how to push it to GHCR, and every failure we have actually hit.

**The image is public.** `ghcr.io/scale-margins-v0/scalemargin-dispatcher` can be
pulled by anyone, with no credentials. That is deliberate: it removes the entire
per-client registry-access apparatus, which used to be the most support-heavy
part of onboarding. Two consequences to hold onto:

- **Never bake a secret into the image.** Anyone can `docker pull` it and read
  every layer. Config arrives at runtime through `.env` and mounted files, and
  §2.1 keeps `.env` out of the build context — that is now a public-disclosure
  control, not just hygiene.
- **Version history is public.** Tags, sizes and push dates are visible to
  anyone. Nothing sensitive, but worth knowing before you push a tag named after
  a client.

---

## 1. What the image is

|               |                                                                                 |
| ------------- | ------------------------------------------------------------------------------- |
| Base          | `node:22-slim` (Debian)                                                         |
| Build         | Two-stage — `pnpm run build:server` in stage 1, production deps only in stage 2 |
| Entrypoint    | `node dist/index.js`                                                            |
| Port          | `3100`                                                                          |
| Healthcheck   | Built in — `GET /health` via Node's `fetch` (the slim image has no `curl`)      |
| Writable path | `/app/data`                                                                     |
| Approx size   | ~476 MB                                                                         |

### What ships inside

```
/app
  dist/            compiled server (tsc)
  drizzle/         state-DB migrations, run automatically at boot
  node_modules/    production dependencies only
  package.json
  data/            writable runtime directory
```

### What deliberately does NOT ship

| Not in the image               | Why                                                                            | Consequence                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `admin-dist/` (the console UI) | Deliberate — clients manage the dispatcher through Atlas, not a second console | `GET /admin` returns `503 {"error":"Dispatcher admin UI has not been built"}`; `/admin/api/*` stays mounted          |
| `config/dispatch.yaml`         | Client-specific — which table, which columns                                   | **Without it the dispatcher silently falls back to the MOCK user lookup** and resolves fabricated recipients. See §7 |
| `config/events.yaml`           | Optional; built-in defaults apply                                              | Fine to omit                                                                                                         |
| `.env`                         | Secrets belong to the deployment                                               | Container will not boot without the two required vars                                                                |

---

## 2. Before your first build

### 2.1 `.dockerignore`

Already in the repo — do not delete it. Without one, `docker build` uploads the
entire working tree as build context: `node_modules/`, `.git/`, `data/*.db`, and
**`.env`**. That is slow, and it puts real credentials into the build context
and the layer cache.

It also excludes `admin/` and `admin-dist/`, since the image builds the server
only. If you ever build a console-bearing image, you must remove `admin`
from the ignore file _as well as_ restoring the Dockerfile lines — miss the
first and `COPY admin/` fails with "file not found".

Verify it is working — context should be kilobytes, not megabytes:

```bash
docker build --no-cache --progress=plain -t ctx-test . 2>&1 | grep -m1 "transferring context"
# => "transferring context: 1.01kB"   ✅
# => "transferring context: 412.7MB"  ❌ the ignore file is not being applied
```

### 2.2 Tooling

```bash
docker --version              # 24+
docker buildx version         # required for multi-arch — §4
gh --version                  # 2.40+ — used for login and package admin
```

`gh` is optional for pushing (a PAT works too) but it is the least fiddly way to
get a token, and §5 uses it.

---

## 3. Build locally and smoke-test

Always build with the metadata args. They populate `GET /api/v1/data-plane/build`,
which is what Atlas uses as its connection probe — an image built without them
reports `unknown` for everything and makes support impossible.

```bash
VERSION=$(node -p "require('./package.json').version")   # 0.3.0
GIT_SHA=$(git rev-parse --short HEAD)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TAG="dispatcher:${VERSION}"

docker build \
  --build-arg DISPATCHER_VERSION="${VERSION}" \
  --build-arg DISPATCHER_GIT_SHA="${GIT_SHA}" \
  --build-arg DISPATCHER_BUILD_TIME="${BUILD_TIME}" \
  --build-arg DISPATCHER_IMAGE_TAG="${TAG}" \
  -t "${TAG}" .
```

Smoke-test before pushing anything. This runs with SQLite and no client
database, which is enough to prove the image boots and migrates:

```bash
docker run --rm -p 3100:3100 \
  -e SCALEMARGIN_DISPATCH_SECRET=local-test-secret \
  -e SCALEMARGIN_ANALYTICS_SECRET=local-test-secret \
  -e FROM_EMAIL=noreply@yourdomain.test \
  "${TAG}"
```

Then, in another terminal:

```bash
curl -s localhost:3100/health                    # {"status":"ok"}
curl -s localhost:3100/api/v1/internal/ready     # checks + migrations applied
```

**Four things to confirm in the boot log**, because each corresponds to a
support ticket we would otherwise get later:

1. No `[FATAL]` lines.
2. Migrations ran — a fresh SQLite file is created without error.
3. `Dispatcher started` appears with the port and provider.
4. **No `FROM_EMAIL is not set` warning.** If you see it, the image is fine but
   the run is misconfigured — every send from that deployment will be rejected by the provider. We have hit this in production; it cost a day of debugging because the warning only reached the terminal.

---

## 4. Architecture — the mistake that costs the most time

**Build on an Apple Silicon Mac and you get an `arm64` image.** Cloud Run, GKE
Autopilot and most client VMs are `amd64`. The push succeeds, the pull succeeds,
and the container dies instantly with:

```
exec /usr/local/bin/node: exec format error
```

Always build explicitly for the target, or build both:

```bash
# Single-arch, targeting the usual deployment
docker buildx build --platform linux/amd64 -t "${TAG}" --load .

# Multi-arch (both) — must push directly, --load cannot hold two platforms
docker buildx build --platform linux/amd64,linux/arm64 -t "${IMAGE}" --push .
```

First time only, create a builder that supports multi-platform:

```bash
docker buildx create --name dispatcher-builder --use --bootstrap
```

Multi-arch builds emulate the foreign platform under QEMU and take roughly 3–4×
as long. For routine releases, `linux/amd64` alone is the right default; build
`arm64` too only when a client is on Graviton or an M-series host.

---

## 5. GitHub Container Registry — one-time setup

There is no registry to create. GHCR materializes a package the first time you
push to a path under your org, so the whole setup is: authenticate, push once,
then flip the package to public.

```bash
export OWNER=scale-margins-v0        # MUST be lowercase — see §10
export IMAGE=ghcr.io/${OWNER}/scalemargin-dispatcher
```

> **Lowercase or nothing.** The GitHub org is `Scale-Margins-V0`, but Docker
> image references may not contain uppercase. `ghcr.io/Scale-Margins-V0/…`
> fails with `invalid reference format`. Always write the owner lowercase; it
> resolves to the same org.

### 5.1 Authenticate

For a human on a laptop, `gh` already holds a token — reuse it:

```bash
gh auth login --scopes write:packages,read:packages
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin
```

If you would rather use a Personal Access Token, create a **classic** PAT with
`write:packages` (which implies `read:packages`) at
<https://github.com/settings/tokens>:

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Two things that catch people:

- Use a **classic** PAT. Fine-grained tokens can do packages, but org package
  permissions on them are inconsistent enough that it is not worth the debugging.
- The username is your **GitHub username**, not the org name and not an email.
  The token is what actually authorizes; the username merely has to be a real
  account.

Credentials land in `~/.docker/config.json` and persist across reboots.

### 5.2 Make the package public — the step everyone forgets

**A newly pushed package is private**, regardless of the repository's
visibility. Nothing warns you. The first sign is a client reporting
`denied: denied` on a pull that works perfectly for you, because your Docker
credentials are cached and theirs do not exist.

Push once (§6), then flip it — this is a **one-time** action, and every
subsequent push keeps the setting:

1. <https://github.com/orgs/scale-margins-v0/packages>
2. Click **scalemargin-dispatcher** → **Package settings**
3. **Danger Zone** → **Change visibility** → **Public** → type the package name
   to confirm

Verify from outside your own credentials — this is the only check that proves
a client can pull. A throwaway config directory ignores your cached login
entirely:

```bash
docker --config /tmp/anon-$$ pull ghcr.io/scale-margins-v0/scalemargin-dispatcher:0.3.0
```

Or without pulling 476 MB, ask the registry for an anonymous token:

```bash
curl -sS "https://ghcr.io/token?scope=repository:scale-margins-v0/scalemargin-dispatcher:pull&service=ghcr.io" \
  | jq -r '.token' | head -c 20
# a token   ✅ public
# null      ❌ still private
```

### 5.3 Access, for the record

| Who              | Needs            | How                                                     |
| ---------------- | ---------------- | ------------------------------------------------------- |
| Release engineer | `write:packages` | Classic PAT, or `gh auth token` (§5.1)                  |
| CI               | Nothing extra    | `secrets.GITHUB_TOKEN` + `permissions: packages: write` |
| Anyone pulling   | Nothing at all   | The package is public — §8                              |

Public packages do not consume the org's package storage or bandwidth quota, so
there is no cost argument for keeping this private.

---

## 6. Tag and push

The full image path is always:

```
ghcr.io/OWNER/IMAGE:TAG        # owner lowercase, always
```

```bash
export IMAGE="ghcr.io/scale-margins-v0/scalemargin-dispatcher"

docker buildx build \
  --platform linux/amd64 \
  --build-arg DISPATCHER_VERSION="${VERSION}" \
  --build-arg DISPATCHER_GIT_SHA="${GIT_SHA}" \
  --build-arg DISPATCHER_BUILD_TIME="${BUILD_TIME}" \
  --build-arg DISPATCHER_IMAGE_TAG="${VERSION}" \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:${GIT_SHA}" \
  -t "${IMAGE}:latest" \
  --push .
```

### Tagging policy

| Tag       | Meaning                                                      | Clients should use                                                       |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `0.3.0`   | Immutable release. **Never re-push an existing version tag** | ✅ Yes — always pin                                                      |
| `a5d5797` | Git SHA. Exact provenance for support                        | For debugging a specific build                                           |
| `latest`  | Most recent release. Moves                                   | ❌ No — an unattended `docker compose pull` becomes an unplanned upgrade |

**GHCR has no immutable-tag setting.** GAR could refuse a re-push of an existing
version tag; GHCR cannot. Nothing stops you overwriting `0.3.0` with different
bits, and clients pinned to it would silently get the new image on their next
`pull`. Tag immutability here is a discipline, not a control:

- Releases go through the tag-triggered workflow (§9), never a laptop push.
- Re-pushing a released version is a **no**. Cut `0.3.1`.
- The `${GIT_SHA}` tag is your escape hatch — it is unique per build, so if you
  ever need to prove which bits a client is running, ask for the SHA tag.

Check whether a version tag already exists before pushing it:

```bash
docker buildx imagetools inspect "${IMAGE}:${VERSION}" >/dev/null 2>&1 \
  && echo "❌ ${VERSION} already published — bump the version" \
  || echo "✅ free"
```

### Verify what you pushed

```bash
gh api "/orgs/scale-margins-v0/packages/container/scalemargin-dispatcher/versions" \
  --jq '.[:5][] | "\(.metadata.container.tags | join(", "))\t\(.created_at)"'

# Confirm the architecture is what you think it is
docker buildx imagetools inspect "${IMAGE}:${VERSION}" | grep -A1 Platform

# Confirm build metadata made it in
docker run --rm \
  -e SCALEMARGIN_DISPATCH_SECRET=x -e SCALEMARGIN_ANALYTICS_SECRET=x \
  -p 3100:3100 -d --name verify "${IMAGE}:${VERSION}"
sleep 5 && curl -s localhost:3100/api/v1/internal/ready | head -c 300
docker rm -f verify
```

---

## 7. The config gotcha, stated once more

`config/dispatch.yaml` is **not** in the image. If the client does not mount it:

- `loadDispatchConfigFromDisk()` logs _"No dispatch config found — falling back
  to the built-in MOCK user lookup"_;
- every recipient resolves to a fabricated record;
- sends "succeed" and the campaign looks healthy in Atlas.

This is the single most damaging misconfiguration in the whole deployment,
because nothing errors. The client compose file mounts it, and the client doc
makes it step one — but if you are debugging a deployment where the numbers look
right and the mail is wrong, check this first:

```bash
docker compose exec dispatcher ls -l /app/config/dispatch.yaml
docker compose logs dispatcher | grep -i "MOCK user lookup"
```

---

## 8. Giving a client pull access

**There is nothing to do.** The package is public, so the client pulls with no
login, no key file, no token and no expiry:

```bash
docker pull ghcr.io/scale-margins-v0/scalemargin-dispatcher:0.3.0
```

This replaced a per-client service-account regime that generated most of our
onboarding support load: expired tokens, wrong `docker login` username, keys
mailed to the wrong person, credentials that silently stopped working on a
host nobody had logged into for months. All of it is gone. The client doc
now simply names a tag.

What we give a client at onboarding is therefore just: the image tag to pin, the
two `SCALEMARGIN_*` secrets, and their `DISPATCHER_ATLAS_KEY`. No registry
credential is ever issued.

### The one exception: air-gapped clients

For a client with no outbound access to `ghcr.io` at all, export a tarball:

```bash
docker save "${IMAGE}:${VERSION}" | gzip > dispatcher-${VERSION}.tar.gz
sha256sum dispatcher-${VERSION}.tar.gz > dispatcher-${VERSION}.tar.gz.sha256
```

Client side:

```bash
sha256sum -c dispatcher-0.3.0.tar.gz.sha256
gunzip -c dispatcher-0.3.0.tar.gz | docker load
```

Send the checksum over a different channel from the file — a tarball is the one
delivery path with no registry-side integrity check, so that hash is the only
thing standing between them and a tampered image.

Their compose file then references the local tag with no registry prefix:

```yaml
image: scalemargin-dispatcher:0.3.0
```

Slow, manual, and every upgrade repeats the whole exercise. Confirm they
genuinely cannot reach `ghcr.io` before agreeing to it — "our policy is no
public registries" is usually satisfiable with a pull-through proxy or a
one-time mirror into their internal registry, both of which are less work
forever after than tarballs.

### If we ever make the package private again

Flip visibility back in Package settings, then invite each client's GitHub
account to the package with **Read** access (Package settings → Manage Actions
access / Invite teams or people). They authenticate with a classic PAT scoped to
`read:packages`. Per-client revocation works, but you are back to a credential
per client and the support load that comes with it — do not do this without a
reason that survives being written down.

---

## 9. CI — the release workflow that already exists

**Do not hand-push a release.** `.github/workflows/release.yml` is the release
path. It is already wired to GHCR and needs no secrets beyond the one GitHub
injects for free.

Cutting a release is one command:

```bash
git tag dispatcher-v0.3.1
git push origin dispatcher-v0.3.1
```

That triggers the workflow, which:

1. derives `0.3.1` from the tag (and fails the build if the tag is malformed);
2. logs in to `ghcr.io` with `secrets.GITHUB_TOKEN`;
3. builds with all four `--build-arg` values, stamping version, SHA and time;
4. pushes `0.3.1`, `v0.3.1` and `latest`;
5. creates a GitHub Release with `CHANGELOG.md` as the body.

The auth is the part worth understanding, because it is what removed the
Workload Identity Federation setup we used to need:

```yaml
permissions:
  packages: write # this line is the entire credential story

- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
```

`GITHUB_TOKEN` is minted per run, scoped to this repository, and expires when
the job ends. There is no long-lived key in repository secrets, and nothing to
rotate. If you remove the `permissions:` block the token becomes read-only and
the push fails with `denied` — that is the first thing to check if a release
job that used to work suddenly cannot push.

### Three known gaps in the current workflow

Stated plainly so nobody assumes CI is protecting them from these:

| Gap                                                                                       | Consequence                                                                                   | If it bites                                                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **No test gate.** The job builds and pushes without running `pnpm test` or `tsc --noEmit` | A broken build can publish successfully, and `latest` moves to it                             | Run the §11 checklist locally before tagging. Better: add `needs:` on a test job    |
| **`latest` moves unconditionally**                                                        | Tagging a prerelease repoints `latest` at it                                                  | Do not tag prereleases with `dispatcher-v*` until this is guarded                   |
| **`docker build`, not `buildx --platform`**                                               | Image is whatever `ubuntu-latest` is — amd64 today, implicitly. No arm64 variant is published | Fine for current clients (§4). A client on Graviton needs a manual multi-arch build |

The first is the one that actually costs something. Until it is fixed, "green
locally" is a human responsibility, not an enforced one.

---

## 10. Troubleshooting

### Registry and publishing

| Symptom                                                       | Cause                                                                  | Fix                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `invalid reference format: repository name must be lowercase` | Uppercase in the image path — `ghcr.io/Scale-Margins-V0/…`             | Lowercase the owner: `scale-margins-v0` (§5)                                     |
| `denied: denied` on push                                      | Token lacks `write:packages`, or you logged in with a fine-grained PAT | Re-login with a classic PAT (§5.1)                                               |
| `denied: denied` in a GitHub Actions run                      | The workflow is missing `permissions: packages: write`                 | Add it — §9                                                                      |
| `unauthorized: authentication required` on push               | Not logged in to `ghcr.io`, or the token expired                       | Log in again — §5.1                                                              |
| **A client gets `denied` on pull, but it works for you**      | **The package is still private.** Your cached credentials hide it      | Flip visibility to Public — §5.2. Verify with the anonymous token check          |
| `name unknown` on pull                                        | Package never pushed, or the name is misspelled                        | `gh api /orgs/scale-margins-v0/packages?package_type=container`                  |
| Package page shows no repo or README                          | The `org.opencontainers.image.source` label is missing                 | It is set in the Dockerfile — confirm it survived an edit                        |
| A released version tag got overwritten                        | GHCR cannot enforce tag immutability                                   | Nothing to recover. Cut a new patch version; use the SHA tag for provenance (§6) |

### Build and runtime

| Symptom                                                  | Cause                                                    | Fix                                                |
| -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `exec format error` on start                             | arm64 image on an amd64 host                             | Rebuild with `--platform linux/amd64` (§4)         |
| Build context is hundreds of MB                          | No `.dockerignore`                                       | §2.1                                               |
| `Dispatcher state-DB migrations not found for dialect …` | `drizzle/` missing from the image                        | Restore `COPY drizzle/ ./drizzle/`                 |
| `[FATAL] Missing required env vars`                      | `SCALEMARGIN_*_SECRET` unset                             | They are mandatory; the process exits by design    |
| Container healthy, every send rejected                   | `FROM_EMAIL` unset → `noreply@example.com`, unverifiable | Set `FROM_EMAIL` to a verified sender              |
| Campaign reports success, wrong recipients               | `config/dispatch.yaml` not mounted → mock lookup         | §7                                                 |
| `pnpm install --frozen-lockfile` fails in build          | `pnpm-lock.yaml` out of sync with `package.json`         | Run `pnpm install` locally and commit the lockfile |
| `/admin` returns 503                                     | **Expected.** The console is not shipped                 | Nothing to fix. Use `/api/v1/data-plane/*`         |

---

## 11. Release checklist

Local, before you tag — CI does not check any of the first four (§9):

- [ ] `pnpm test` green, `npx tsc --noEmit` clean
- [ ] Version bumped in `package.json`; changeset added; `CHANGELOG.md` updated (it becomes the release body)
- [ ] `.dockerignore` present, context is kilobytes (§2.1)
- [ ] Local smoke test: `/health`, `/api/v1/internal/ready`, no `[FATAL]`, no `FROM_EMAIL` warning
- [ ] Version tag not already published (§6)

Then:

- [ ] `git tag dispatcher-v0.3.1 && git push origin dispatcher-v0.3.1`
- [ ] Workflow green; GitHub Release created
- [ ] `docker buildx imagetools inspect` confirms the platform
- [ ] **Anonymous pull works** — `docker --config /tmp/anon pull ghcr.io/scale-margins-v0/scalemargin-dispatcher:0.3.1` (§5.2). First release only, but free to re-check
- [ ] Client-facing release note names the exact tag to pin
