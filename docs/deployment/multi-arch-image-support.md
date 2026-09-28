# Publishing the dispatcher image for all platforms

**Status:** implemented for releases only — `main` publishes `linux/amd64` + `linux/arm64` (QEMU, option §4); `acme` dev images stay `linux/amd64`. The native-runner matrix below is still the upgrade path if build time matters.

Today the image is `linux/amd64` only. A client on Graviton, Ampere, an
M-series Mac or a Raspberry Pi either cannot run it or runs it under emulation.
This is what it takes to publish `linux/amd64` **and** `linux/arm64` from one
tag, what it costs, and what it does not cost.

---

## 1. Where the limit is

One line, `.github/workflows/build-and-push.yml:239`:

```yaml
- name: Build and push
  uses: useblacksmith/build-push-action@v2
  with:
    platforms: linux/amd64      # ← here
```

Everything downstream of that is architecture-agnostic. There is no other
blocker in the repository.

Symptom a client sees on an ARM host:

```
The requested image's platform (linux/amd64) does not match the detected
host platform (linux/arm64/v8) and no specific platform was requested
```

Docker Desktop emulates and carries on. `containerd` on a bare ARM node
usually refuses with `exec format error`.

---

## 2. What was actually verified

The usual reason multi-arch is painful is native modules. This project has
exactly one — `better-sqlite3` — and the runtime image (`node:22-slim`) ships
no compiler, so if there were no arm64 prebuild the build would **fail**, not
merely be slow.

It was tested rather than assumed:

| Check | Result |
| --- | --- |
| `better-sqlite3@11.10.0` installs on `linux/arm64` | ✅ 4s, via `prebuild-install` — no compile |
| Full `Dockerfile` builds for `linux/arm64` | ✅ **8.3s** |
| Built image reports its architecture | ✅ `arm64 linux` |
| Built image boots | ✅ `"msg":"Dispatcher started"` |

```bash
docker buildx build --platform linux/arm64 -t dispatcher-arm64-test:local --load .
#   …  8.300 total
docker run --rm dispatcher-arm64-test:local node -e "console.log(process.arch)"
#   arm64
```

`better-sqlite3`'s install script is `prebuild-install || node-gyp rebuild`.
The prebuild exists for `linux-arm64`, so the second half never runs. **There
is no compilation step to go wrong.**

---

## 3. The change

Build each architecture on its own native runner, then stitch the two digests
into one manifest list. Blacksmith rents arm64 metal, so no emulation is
involved.

### 3.1 Replace the single `build` job with a matrix

```yaml
  build:
    name: Build ${{ matrix.platform }} (${{ needs.meta.outputs.channel }})
    needs: [meta, test]
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: true          # a half-built manifest is worse than no release
      matrix:
        include:
          - platform: amd64
            runner: blacksmith-4vcpu-ubuntu-2404
          - platform: arm64
            runner: blacksmith-4vcpu-ubuntu-2404-arm
    steps:
      - uses: actions/checkout@v4

      # One cache-key PER ARCH. A shared key has the two runners evicting
      # each other's layers on every build.
      - name: Set up Blacksmith Docker builder
        uses: useblacksmith/setup-docker-builder@v2
        with:
          cache-key: dispatcher-package-internal/dispatcher-image-${{ matrix.platform }}

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # Pushes BY DIGEST and carries no tag. Tags are applied once, in the
      # merge job — two jobs racing to write `:latest` would leave it pointing
      # at whichever finished last, i.e. a single-arch image.
      - name: Build and push by digest
        id: build
        uses: useblacksmith/build-push-action@v2
        with:
          context: .
          platforms: linux/${{ matrix.platform }}
          outputs: type=image,name=${{ env.IMAGE_BASE }},push-by-digest=true,name-canonical=true,push=true
          provenance: false
          build-args: |
            DISPATCHER_VERSION=${{ needs.meta.outputs.version }}
            DISPATCHER_GIT_SHA=${{ github.sha }}
            DISPATCHER_BUILD_TIME=${{ needs.meta.outputs.build_time }}
            DISPATCHER_IMAGE_TAG=${{ needs.meta.outputs.image }}:${{ needs.meta.outputs.version }}

      - name: Export digest
        run: |
          mkdir -p /tmp/digests
          digest='${{ steps.build.outputs.digest }}'
          test -n "$digest" || { echo "::error::build produced no digest"; exit 1; }
          touch "/tmp/digests/${digest#sha256:}"

      - uses: actions/upload-artifact@v4
        with:
          name: digests-${{ matrix.platform }}
          path: /tmp/digests/*
          if-no-files-found: error
          retention-days: 1
```

### 3.2 Add a `merge` job

```yaml
  merge:
    name: Merge manifest & tag
    needs: [meta, build]
    runs-on: blacksmith-2vcpu-ubuntu-2404
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: /tmp/digests
          pattern: digests-*
          merge-multiple: true

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Create manifest list and push
        working-directory: /tmp/digests
        env:
          TAGS: ${{ needs.meta.outputs.tags }}
        run: |
          set -euo pipefail
          tag_args=()
          while IFS= read -r t; do
            [ -n "$t" ] && tag_args+=(-t "$t")
          done <<< "$TAGS"

          digest_args=()
          for f in *; do digest_args+=("${IMAGE_BASE}@sha256:${f}"); done
          # Two architectures, two digests. Anything else means a matrix leg
          # silently did not publish, and a one-arch manifest would ship.
          if [ "${#digest_args[@]}" -ne 2 ]; then
            echo "::error::expected 2 digests, found ${#digest_args[@]}"
            exit 1
          fi

          docker buildx imagetools create "${tag_args[@]}" "${digest_args[@]}"

      - name: Verify both architectures are in the manifest
        run: |
          set -euo pipefail
          out=$(docker buildx imagetools inspect "${IMAGE_BASE}:${{ needs.meta.outputs.version }}")
          echo "$out"
          echo "$out" | grep -q "linux/amd64" || { echo "::error::amd64 missing"; exit 1; }
          echo "$out" | grep -q "linux/arm64" || { echo "::error::arm64 missing"; exit 1; }
```

### 3.3 Two one-line follow-ups

- `release` job: `needs: [meta, build]` → `needs: [meta, merge]`. Otherwise a
  git tag can be cut against a manifest that was never assembled.
- `.github/actionlint.yaml`: add the `-arm` runner labels, or lint fails with
  *"label blacksmith-4vcpu-ubuntu-2404-arm is unknown"*.

```yaml
    - blacksmith-2vcpu-ubuntu-2404-arm
    - blacksmith-4vcpu-ubuntu-2404-arm
    - blacksmith-8vcpu-ubuntu-2404-arm
    - blacksmith-16vcpu-ubuntu-2404-arm
```

With those added, `actionlint` over all workflows exits 0.

---

## 4. Why not just `platforms: linux/amd64,linux/arm64`

That one-line version works, but the arm64 half runs under **QEMU emulation**
on an x64 runner — roughly 3–4× slower, and it is the approach Blacksmith
explicitly steers away from.

Blacksmith's documentation describes transparent cross-runner fan-out, where a
single job with both platforms is split across native builders automatically,
as **forthcoming**. When it ships, the whole matrix above collapses back to one
line. Until then, the matrix is the reliable route.

---

## 5. Pricing

Blacksmith's published per-minute rates:

| Platform | Rate |
| --- | --- |
| Ubuntu x64 | **$0.004 / min** |
| Ubuntu ARM | **$0.0025 / min** |

**ARM is cheaper than x64** — about 38% less. All plans include **3,000 free
minutes per month**.

### Measured against a real run

From the last release build (`33860338853`), billed job time:

| Job | Runner | Duration |
| --- | --- | --- |
| Resolve version and tags | 2vcpu x64 | 7s |
| Test | 4vcpu x64 | 34s |
| Build & push | 4vcpu x64 | **32s** |
| Tag & release | 2vcpu x64 | 10s |
| | | **83s total** |

### After the change

The two build jobs run **in parallel**, so the arm64 job adds no wall-clock
time — only the merge job does.

| | x64 minutes | ARM minutes | Cost |
| --- | --- | --- | --- |
| **Today** | 83s ≈ 1.38 | — | ~$0.0055 |
| **After** | 103s ≈ 1.72 | 32s ≈ 0.53 | ~$0.0082 |

**Delta: about +$0.003 per build**, or roughly **+50%** on a very small base.
At a hundred builds a month that is **under $1**. The free tier alone covers
roughly 1,300 builds a month at the new size.

### Caveats on those numbers

- Blacksmith's pricing page shows a **flat per-minute rate that does not vary
  by vCPU size**. Most competitors multiply by vCPU. If your plan does apply a
  multiplier, scale the x64 figures by 4 and the ARM figures by 4 — the
  conclusion does not change, because ARM stays the cheaper of the two.
- Billing rounding (per-second vs per-minute) is not stated. At 30-second jobs,
  per-minute rounding would roughly double the effective cost — still cents.
- **GHCR storage is free for public packages**, so the second architecture adds
  no registry cost. A private package would roughly double the stored bytes
  per tag.

### The cost of *not* doing it

One client on Graviton who cannot deploy is worth more than a lifetime of this
line item.

---

## 6. Risks

| | Risk | Mitigation |
| --- | --- | --- |
| 1 | `useblacksmith/build-push-action@v2` may not accept the `outputs:` input for push-by-digest | It is a fork of `docker/build-push-action`, which does. **Verify on the first `acme`-channel run** before relying on it for a release |
| 2 | The org may not have ARM runners enabled | Check the Blacksmith dashboard first. If not, the matrix leg queues forever rather than failing fast |
| 3 | A matrix leg fails and a single-arch manifest ships | `fail-fast: true`, the digest-count check, and the post-merge `imagetools inspect` assertion. Three independent guards |
| 4 | Doubled BuildKit cache on the sticky NVMe disk | One `cache-key` per arch, as above. Add `max-cache-size-mb` if it grows |
| 5 | Build time regression goes unnoticed | The arm64 leg is on the critical path only if it is slower than amd64. Locally it built in 8.3s |

---

## 7. Verifying after the first run

```bash
docker buildx imagetools inspect ghcr.io/scale-margins-v0/scalemargin-dispatcher:<version>
```

Expect two entries:

```
Manifests:
  Name: …@sha256:…          Platform: linux/amd64
  Name: …@sha256:…          Platform: linux/arm64
```

Then, from an ARM host, the real test:

```bash
docker pull ghcr.io/scale-margins-v0/scalemargin-dispatcher:<version>
docker run --rm ghcr.io/scale-margins-v0/scalemargin-dispatcher:<version> \
  node -e "console.log(process.arch)"
# arm64 — with no platform warning
```

`test/smoke-health.sh` in this repository already exercises the full stack and
will exercise the native image once it is published.

---

## 8. Rollback

Revert the workflow file. The manifest-list tag is replaced on the next push,
and previously published single-arch tags are untouched — clients pinned to an
older version are unaffected either way.

---

## 9. Doc updates this unlocks

Three places currently tell clients the image is amd64-only. All become wrong
once this ships:

- `docs/deployment/build-and-publish.md` §4 — the local multi-arch section, and
  the note that ARM is built "only when a client is on Graviton or an M-series
  host"
- `README.md` / `docs/deployment/client-deployment.md` — the `exec format
  error` troubleshooting row
- The Notion deployment guides — the "published image is `linux/amd64`" note in
  *Before you start*
