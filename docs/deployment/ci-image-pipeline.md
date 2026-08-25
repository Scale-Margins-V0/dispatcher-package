# CI image pipeline — building on Blacksmith, publishing to GHCR

**Audience:** Us. How images get built and versioned, why the versioning works
the way it does, and what to do when it misbehaves.

The workflow is `.github/workflows/build-and-push.yml`. Everything below
describes that one file.

---

## 1. The shape of it

Two branches, two channels, one workflow.

<!-- prettier-ignore -->
| You push to | Image | Tags | Version bumped? | Git tag + Release? |
| --- | --- | --- | --- | --- |
| `main` | `ghcr.io/scale-margins-v0/scalemargin-dispatcher` | `1.4.0`, `1.4`, `1`, `latest`, `sha-a5d5797` | Yes | Yes |
| `acme` | `ghcr.io/scale-margins-v0/scalemargin-dispatcher-**dev**` | `dev-a5d5797`, `dev` | No | No |
| any other branch you add to the trigger | `…-**dev**` | `dev-a5d5797` only | No | No |

**Only `main` can cut a release.** The channel test is `!= main`, not
`== acme` — so a branch you temporarily add to the trigger list to test the
pipeline produces a dev image and nothing else. Written the other way round, a
test push would mint a version, tag the repo and open a GitHub Release.

The moving `:dev` pointer is only moved by `acme`. A scratch branch writes its
immutable `dev-<sha>` tag and stops there, so it can never repoint what the
acme deployment pulls.

Both run: **resolve version → test → build → push**, and `main` adds a
**tag & release** job at the end.

### Why `on: push` and not `pull_request: closed`

A merged PR *is* a push to the target branch. `on: push` catches merges without
the `types: [closed]` + `if: github.event.pull_request.merged` boilerplate, and
it also catches direct pushes and hotfixes — which you want, because "the image
exists for every commit on main" is a much easier promise to reason about than
"the image exists for every commit that arrived via a PR".

### Why dev is a separate package

`scalemargin-dispatcher-dev` is a **different GHCR package** from the release
image, not just a different tag on the same one. That matters because the
release package is **public** (see `build-and-publish.md` §5.2). If dev builds
were tags on that package, every unreleased commit on `acme` would be publicly
pullable. A separate package stays private with no extra effort — it is private
by default and you simply never flip it.

Cost: the dev package needs a pull credential wherever it is consumed. See §6.

---

## 2. Blacksmith

The jobs run on Blacksmith runners instead of `ubuntu-latest`:

```yaml
runs-on: blacksmith-4vcpu-ubuntu-2404
```

and the Docker build uses Blacksmith's builder pair:

```yaml
- uses: useblacksmith/setup-docker-builder@v2
  with:
    cache-key: dispatcher-package-internal/dispatcher-image

- uses: useblacksmith/build-push-action@v2
  with:
    push: true
    tags: ${{ needs.meta.outputs.tags }}
```

Three things to understand about this:

**There is no `cache-from` / `cache-to`, and that is deliberate.** With
`docker/build-push-action` you would export the layer cache to the GHA cache or
to the registry and pull it back on the next run — over the network, every time.
`setup-docker-builder` instead mounts a persistent NVMe "sticky disk" at
`/var/lib/buildkit`, so the layer cache is simply *already there*. Adding
`cache-from` on top of it would reintroduce the network round-trip you just
removed.

**`cache-key` scopes the cache.** One key per build target. Two different
Dockerfiles in one repo should use two keys, or they will evict each other's
layers. Ours is `dispatcher-package-internal/dispatcher-image`.

**It degrades rather than fails.** If Blacksmith cannot set up (outage,
misconfigured org), the action falls back to a local builder — slower, but the
build still completes. Set `nofallback: true` if you would rather it fail loudly
than silently lose the cache.

The big win is the `pnpm install --frozen-lockfile` layer. It is the slowest
step in the Dockerfile and it only changes when `pnpm-lock.yaml` does, so on a
normal code-only commit it is a cache hit.

> **The runner labels must exist in your Blacksmith org.** If Blacksmith is not
> enabled for `Scale-Margins-V0`, the jobs sit in "Waiting for a runner" and
> eventually time out — they do not fall back to GitHub's runners. §7 has the
> one-line fix if you need to run without Blacksmith.

---

## 3. Versioning — the actual question

> *Can tags be automatic, or do we do it manually? Can it be optional, and
> default to bumping the version if not passed?*

Yes to all three, and you get all three at once. The rule is:

```
explicit version input   →  use it
explicit bump input      →  apply that level
neither (the normal case) →  read the commit messages and decide
```

### 3.1 Automatic: derived from your commit messages

This repo already writes Conventional Commits — `feat(api): …`,
`refactor(logging): …`, `fix(dispatch): …`. The workflow reads every commit
since the last `dispatcher-v*` tag and picks the level:

<!-- prettier-ignore -->
| Found in commits since last release | Bump | 0.3.0 becomes |
| --- | --- | --- |
| `feat!:` or `BREAKING CHANGE:` in a body | major | `1.0.0` |
| any `feat:` / `feat(scope):` | minor | `0.4.0` |
| anything else — `fix`, `chore`, `refactor`, `docs` | patch | `0.3.1` |

**This is why the default is patch, not minor.** You asked for "+1 minor if
nothing is passed". I would push back on that one, and here is the concrete
reason: most merges to `main` are fixes and refactors. If every merge bumped the
minor you would be at `0.30.0` within a quarter, and the number would tell a
client nothing — a minor bump is supposed to mean "there is something new in
here". Deriving from commits gives you the minor bump automatically **on exactly
the merges that added a feature**, which is what you actually wanted. If you
disagree, §3.4 has the one-line change.

### 3.2 The pre-1.0 guard

While the version is `0.x`, a derived breaking change bumps the **minor**, not
the major:

```
0.3.0  +  feat(api)!: drop the v0 endpoint   →   0.4.0     (not 1.0.0)
```

Going to `1.0.0` is a statement that the API is stable and clients can rely on
it. That should be a decision someone makes, not something a `!` in a commit
message does on a Tuesday. Cutting `1.0.0` is still one click — §3.3.

The guard only applies to *derived* bumps. An explicit `bump: major` always
does what it says.

### 3.3 Manual: when you want to decide

**Actions → Build & publish image → Run workflow**, on the `main` branch:

<!-- prettier-ignore -->
| Input | Leave blank | Or set it to |
| --- | --- | --- |
| `version` | derived from `bump` | An exact version — `1.0.0`, `2.3.4`. Wins over everything |
| `bump` | `auto` (reads commits) | `patch` / `minor` / `major` |

Cutting `1.0.0` deliberately: run the workflow with `version: 1.0.0`, or with
`bump: major`.

From the CLI:

```bash
gh workflow run build-and-push.yml --ref main -f version=1.0.0
gh workflow run build-and-push.yml --ref main -f bump=minor
```

### 3.4 If you want a different default

One line in `build-and-push.yml`, in the `else` branch of the derivation:

```bash
else
  LEVEL=patch      # <- change to `minor` for "always +1 minor"
fi
```

Whatever you change, run the self-check afterwards:

```bash
./scripts/test-version-bump.sh
```

It extracts the derivation block **out of the workflow file** and runs it
against 16 cases with a stubbed git history — so it tests the shipped logic, not
a copy of it. It already caught one real bug during development: the pre-1.0
guard checked whether the bump input was empty, but a `push` event sends `auto`
rather than an empty string, so a single `feat!:` commit would have taken
`0.3.0` straight to `1.0.0`.

### 3.5 Where the version actually lives

**Git tags are the source of truth**, not `package.json`. The workflow reads the
highest `dispatcher-v*` tag to decide what "current" is, and only falls back to
`package.json` when no tag exists.

`package.json` is then updated to match and committed back to `main` as
`chore(release): 1.4.0 [skip ci]`, so the two never drift. That commit cannot
retrigger the pipeline: **pushes made with `GITHUB_TOKEN` do not start new
workflow runs** — the `[skip ci]` marker is belt-and-braces on top of that
guarantee.

Ordering is deliberate: **build and push the image first, then tag.** A git tag
with no image behind it is a worse state to be in than an image that is a minute
late getting tagged, because the first looks like a successful release to
everyone reading the tag list.

---

## 4. What runs, in order

```
  meta ──────┐
             ├──► build ──► release   (release job: main only)
  test ──────┘
```

**`meta`** — resolves channel, version, image name and the full tag list. Pure
computation, no side effects, so when a release comes out wrong this is the job
whose log tells you why. It fails early if the computed tag already exists.

**`test`** — `pnpm install`, `tsc --noEmit`, `pnpm test`. Runs in parallel with
`meta`. **This is the gate the old `release.yml` did not have**: that workflow
built and pushed without running the test suite, so a broken build could publish
and move `latest` onto it.

**`build`** — Blacksmith builder, one `docker build`, pushed with every tag at
once. All four `DISPATCHER_*` build args are passed, so
`GET /api/v1/data-plane/build` reports real values instead of `unknown`.

**`release`** — `main` only. Bumps `package.json`, commits, tags, opens a GitHub
Release with the commit list as the body.

`concurrency` queues runs on the same ref rather than cancelling them. Two
concurrent pushes to `main` would otherwise compute the same next version and
the second would die on a duplicate tag. Queueing (not cancelling) also avoids
killing a job mid-push, which can leave a partially written manifest.

---

## 5. One-time setup

- [ ] **Blacksmith installed** on the `Scale-Margins-V0` org — see §5a. Free
      tier, no card, but **an org owner has to click install**. Nothing works
      until this is done.
- [ ] **Workflow write permissions.** Settings → Actions → General → Workflow
      permissions → *Read and write*. The `release` job pushes a commit and a
      tag; without this it fails at `git push` with `403`.
- [ ] **Branch protection on `main`.** If `main` requires PRs, the bot's
      `chore(release):` push is rejected. Either allow
      `github-actions[bot]` to bypass, or drop the commit-back (§3.5) and let
      the tag be the only record.
- [ ] **Make the release package public** — once, after the first successful
      push to `main`. `build-and-publish.md` §5.2. The **dev** package stays
      private.
- [ ] **First run.** Push a trivial commit to `main` and watch it produce
      `0.3.1`, since the last tag is `dispatcher-v0.3.0`.

---

## 5a. Setting up Blacksmith

### What it costs

**3,000 runner-minutes a month, free, no credit card.** Past that it is
metered per minute, and cheaper than GitHub's own runners:

<!-- prettier-ignore -->
| Runner | Blacksmith | GitHub equivalent |
| --- | --- | --- |
| 2 vCPU Ubuntu x64 | $0.004/min | $0.008/min |
| Ubuntu ARM | $0.0025/min | — |
| Windows x64 | $0.008/min | — |
| macOS M4 | $0.08/min | — |

A full run of this pipeline is roughly 8–10 runner-minutes (`meta` and
`release` are trivial; `test` and `build` are the cost). That puts the free tier
at about **300 pushes a month** across `main` and `acme` combined — comfortably
more than this repo generates. And the per-minute rate is only half the saving:
the sticky-disk layer cache means the `build` job is doing far less work per run
than it would on `ubuntu-latest`.

### What you have to do

There are **no secrets, no PAT and no runner registration token**. Blacksmith's
GitHub App cannot read your org or repo secrets — GitHub does not expose that
permission to third-party apps at all, so this is a structural guarantee rather
than a promise. Job requests are forwarded to Blacksmith's control plane by
webhook, and it only acts on jobs whose `runs-on` carries one of its labels.

1. Go to <https://app.blacksmith.sh> and sign in with GitHub.
2. Install the app on the **`Scale-Margins-V0` organization**, granting it
   access to `dispatcher-package-internal` (or all repos).
3. That is it. Push, and jobs with a `blacksmith-*` label get picked up.

Two constraints worth knowing before you start:

- **It is org-only.** Blacksmith does not work on personal repositories.
- **An org owner has to install it.** The app operates at org level, so a repo
  admin generally cannot self-serve — GitHub restricts installs that request
  org-level permissions to owners. If you are not an owner of
  `Scale-Margins-V0`, you will be asking someone who is.

### If jobs sit in the queue

<!-- prettier-ignore -->
| Symptom | Likely cause |
| --- | --- |
| Queued forever, never starts | App not installed, or this repo not in its access list |
| Queued a few minutes then starts | Permissions still propagating after install |
| Dashboard shows no orgs | SSO session not authenticated — sign in to the org's SSO in GitHub, then refresh |
| Nothing reaches Blacksmith at all | Org IP allowlist blocking the control plane |

There is **no fallback to GitHub-hosted runners**. An unlabelled or
unrecognised `runs-on` simply never gets a machine. If you need to unblock
yourself before the install lands, §7 has the downgrade.

---

## 5b. Testing the pipeline on acme

### Before you push anything

**Blacksmith must be enabled for the org.** If it is not, the jobs sit in
"Waiting for a runner" until they time out — they do **not** fall back to
GitHub's runners. Check <https://github.com/organizations/Scale-Margins-V0/settings/actions/runners>
or just look at whether any other repo in the org already uses a
`blacksmith-*` label. §7 has the two-line downgrade to `ubuntu-latest` if you
want to test the rest of the pipeline first.

**`.dockerignore` must be committed.** It is currently untracked — it exists
only in a working tree. Without it in the branch, `actions/checkout` leaves a
`.git` directory that goes straight into the build context, and the
"context: 1.01kB" check in `build-and-publish.md` §2.1 stops meaning anything.

**The test job gates the build.** `tsc --noEmit` and the full vitest suite run
before anything is pushed. Run them locally first — a red suite means no image
and a confusing failure on a pipeline you are trying to validate.

```bash
npx tsc --noEmit && npx vitest run
```

### Option A — scratch branch first (recommended)

Safer than going straight at `acme`, because it does not touch the acme GKE
deployment and does not move the `:dev` tag.

```bash
# add your branch to the trigger, temporarily
#   on: push: branches: [main, acme, my-test-branch]

git add .github/workflows/build-and-push.yml .github/actionlint.yaml \
        .dockerignore Dockerfile scripts/test-version-bump.sh
git commit -m "ci: GHCR build pipeline"
git push origin my-test-branch
```

You get `…-dev:dev-<sha>` and nothing else. Remove the branch from the trigger
list once it goes green.

### Option B — straight at acme

The workflow file has to exist **on the branch you are pushing to** — GitHub
reads the workflow from the pushed ref, not from `main`. So the first push to
`acme` is what installs it.

```bash
git checkout acme && git pull
git checkout <your-branch> -- \
  .github/workflows/build-and-push.yml .github/actionlint.yaml \
  .dockerignore Dockerfile scripts/test-version-bump.sh \
  docs/deployment/ci-image-pipeline.md
git commit -m "ci: build and publish dev image to GHCR"
git push origin acme
```

> ⚠️ **`deploy-acme.yml` fires on the same push.** You will get two builds of
> the same commit — this one to GHCR, and the existing Cloud Build to
> `gcr.io` — and the second one **rolls the acme GKE deployment**. That is a
> real deploy, not a dry run. If you only want to exercise the image build,
> use Option A. §8 covers collapsing the two.

### Watching it

```bash
gh run watch          # or: gh run list --branch acme --limit 3
gh run view --log-failed
```

The `meta` job's log is where to look first if the tags come out wrong — it
prints the resolved channel, version and tag list before anything is built.

### Verifying the result

The package is private, so log in before pulling:

```bash
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin

SHA=$(git rev-parse --short=7 HEAD)
docker pull ghcr.io/scale-margins-v0/scalemargin-dispatcher-dev:dev-${SHA}
```

Confirm the build metadata actually landed — this is the whole point of the
four `--build-arg` values, and it is the first thing support asks for:

```bash
docker run --rm -d --name dev-verify -p 3100:3100 \
  -e SCALEMARGIN_DISPATCH_SECRET=x \
  -e SCALEMARGIN_ANALYTICS_SECRET=x \
  ghcr.io/scale-margins-v0/scalemargin-dispatcher-dev:dev-${SHA}

sleep 5
curl -s localhost:3100/health                       # {"status":"ok"}
curl -s localhost:3100/api/v1/internal/ready | jq   # migrations applied
docker rm -f dev-verify
```

`version`, `git_sha` and `build_time` must be real values. `unknown` anywhere
means the build args did not reach the Dockerfile.

Then check the package exists and is **private**:

```bash
gh api /orgs/scale-margins-v0/packages/container/scalemargin-dispatcher-dev \
  --jq '{name, visibility}'
```

---

## 6. Consuming the dev image

The dev package is private, so anything pulling it needs a credential — unlike
the public release image.

For the GKE `acme` namespace, that means an image pull secret:

```bash
kubectl -n acme create secret docker-registry ghcr-dev \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<classic PAT with read:packages>

kubectl -n acme patch serviceaccount default \
  -p '{"imagePullSecrets":[{"name":"ghcr-dev"}]}'
```

Locally:

```bash
docker pull ghcr.io/scale-margins-v0/scalemargin-dispatcher-dev:dev
```

If you would rather not manage that secret, the alternative is to make the dev
package public too — at which point every unreleased commit is public. That is a
real trade, not a formality; the pull secret is the cheaper side of it.

---

## 7. Troubleshooting

<!-- prettier-ignore -->
| Symptom | Cause | Fix |
| --- | --- | --- |
| Jobs stuck on "Waiting for a runner" | Blacksmith not enabled, or the label does not exist in the org | Enable Blacksmith, or swap every `runs-on: blacksmith-*` for `ubuntu-latest` and `useblacksmith/*` for `docker/setup-buildx-action@v3` + `docker/build-push-action@v6` |
| `Tag dispatcher-vX.Y.Z already exists` | A previous run got as far as tagging | Intentional guard. Re-run with an explicit `version` input |
| `release` job fails on `git push` — 403 | Workflow permissions are read-only | Settings → Actions → General → *Read and write* |
| `release` job fails on `git push` — protected branch | Branch protection rejects the bot | Allow `github-actions[bot]` to bypass, or drop the commit-back |
| `denied: denied` pushing to GHCR | `permissions: packages: write` missing or edited out | It is at the top of the workflow — restore it |
| Version jumped further than expected | A `feat!:` or `BREAKING CHANGE:` is in the range | `git log $(git tag -l 'dispatcher-v*' --sort=-v:refname \| head -1)..HEAD --format='%s'` |
| Every build is a cache miss | `cache-key` changed, or another workflow shares it | One key per build target; keep it stable |
| Image reports `unknown` version at `/build` | Build args not reaching the Dockerfile | Check the `build-args:` block in the `build` job |
| Dev deploy pulls `ImagePullBackOff` | No pull secret for the private dev package | §6 |

---

### Running without Blacksmith

If you are blocked waiting on an org owner and want to validate the rest of the
pipeline now, this is the whole downgrade — two substitutions:

```bash
sed -i '' 's/runs-on: blacksmith-[0-9]*vcpu-ubuntu-2404/runs-on: ubuntu-latest/' \
  .github/workflows/build-and-push.yml
```

and in the `build` job, replace the Blacksmith builder pair:

```yaml
- uses: docker/setup-buildx-action@v3

- uses: docker/build-push-action@v6
  with:
    context: .
    push: true
    platforms: linux/amd64
    tags: ${{ needs.meta.outputs.tags }}
    provenance: false
    cache-from: type=gha # <- needed again without the sticky disk
    cache-to: type=gha,mode=max
    build-args: |
      DISPATCHER_VERSION=${{ needs.meta.outputs.version }}
      DISPATCHER_GIT_SHA=${{ github.sha }}
      DISPATCHER_BUILD_TIME=${{ needs.meta.outputs.build_time }}
      DISPATCHER_IMAGE_TAG=${{ needs.meta.outputs.image }}:${{ needs.meta.outputs.version }}
```

Everything else — versioning, tags, the test gate, the release job — is
runner-agnostic and behaves identically. Note the `cache-from`/`cache-to` lines
coming back: without the sticky disk you are back to shipping the layer cache
over the network each run.

---

## 8. Relationship to the other workflows

Three workflows can build an image. That is two too many — read this before
adding a fourth.

<!-- prettier-ignore -->
| Workflow | Trigger | Builds to | Status |
| --- | --- | --- | --- |
| `build-and-push.yml` | push to `main` / `acme` | GHCR | **The one to use** |
| `release.yml` | `dispatcher-v*` tag | GHCR | **Superseded — should be deleted** |
| `deploy-acme.yml` | push to `acme` | `gcr.io` (Cloud Build) + GKE rollout | **Overlaps — needs trimming** |

**`release.yml` is now redundant.** It does strictly less than the new workflow
(no test gate, no version derivation, `docker build` rather than a cached
builder) and it triggers on exactly the tags the new workflow creates. It will
not actually fire — tags pushed with `GITHUB_TOKEN` do not start workflow runs —
but relying on that subtlety to keep a duplicate release path dormant is not a
good place to leave things. Delete it.

**`deploy-acme.yml` still builds its own image.** On every push to `acme` it
runs a second, separate Cloud Build to `gcr.io/...:dev-<sha>` and then rolls the
GKE deployment. So `acme` currently builds the same commit twice, to two
registries. The fix is to strip the build step out of it and have the deploy
step consume the GHCR image this workflow just produced:

```yaml
# in deploy-acme.yml, replacing the "Build & push image" step entirely
- name: Deploy to acme
  run: |
    kubectl -n acme set image deployment/dispatcher \
      dispatcher=ghcr.io/scale-margins-v0/scalemargin-dispatcher-dev:dev-${GITHUB_SHA::7}
```

That needs the pull secret from §6, and the two workflows need ordering —
either merge them into one, or have the deploy wait via
`workflow_run: {workflows: [Build & publish image], types: [completed]}`.
Merging them is the cleaner end state.

**Neither change is made yet** — both touch a live dev deployment path, so they
are written down here rather than done quietly.
