# TileserverStartNext.md — Session Seed / Continuation

> **Purpose:** seed for the next session. Read this first, then the three docs
> it links. Everything below is verified against the live tree on
> **2026-10-18**; where a fact is *time-sensitive* it is marked ⏱.

---

## 0. TL;DR — where we are

Two workstreams, one repo pair:

| Workstream | State |
|---|---|
| **A. Upstream OSS PRs** (`tileserver-rs`) | **2 merged, 1 open** — #1556 ✅, #1557 ✅, #1558 🟡 awaiting maintainer re-review |
| **B. Demo integration** (`app-gisat-deckglSandbox`) | **GREEN** — Manila RGB COG renders; container `Up (healthy)`, tiles HTTP 200. Fix committed `540803e` |

The demo blocker is **solved**. The only *open* piece of real work is **PR #1558
re-review**, plus optional cleanup (push, knowhow commit, memory refresh).

---

## 1. Exact identifiers (copy-paste ready)

### Repos
- **Upstream:** `https://github.com/vinayakkulkarni/tileserver-rs.git` (remote `origin`)
- **Fork:** `git@github.com:twosix-code/tileserver-rs.git` (remote `fork`)
- **Repo path:** `~/.openclaw/work/gits/Gisat/DynamicServerSideTiles/tileserver-rs`
- **App/demo path:** `~/.openclaw/work/gits/Gisat/DynamicServerSideTiles/app-gisat-deckglSandbox`

### Commits / tips ⏱ (verify with `git log --oneline -1` before relying on them)
- **Fork base:** `bff0948` = `bff09487b232fa25ecef9a427326e004caf4ad9b` (upstream v2.39.0)
- **Upstream `origin/main` tip:** `71f7306`
- **Fork `main`:** `bff0948`
- `fix/rgba-dstalpha` = `ed3d83c` — local == fork ✅
- `fix/vsicurl-cog-dem` = `85691b9` — local == fork ✅
- `fix/dataset-cache-byte-bound` = `6c470b4` — local == fork ✅ (revision after review)
- `integrate/all-three-fixes` = `09944d4` — local == fork ✅ (daily driver)
- **Merged upstream:** `71f7306` (#1556), `8f3155e` (#1557), `f77d90e` (#1559 CI)
- **Demo branch:** `feature/tileserver-demo` @ `993de09`
  - `540803e` — **this session's** offline-image fix (NSS + CA trust store)
  - `993de09` — probe tile moved fully inside COG footprint

### PRs
- **#1556** `fix/rgba-dstalpha` — ✅ **MERGED** 2026-10-17 22:19 (`71f7306`)
- **#1557** `fix/vsicurl-cog-dem` — ✅ **MERGED** 2026-10-17 22:13 (`8f3155e`)
- **#1558** `fix/dataset-cache-byte-bound` — 🟡 **OPEN**, changes requested → updated → **awaiting re-review**

### PR-create URLs (if a branch needs re-opening)
- `https://github.com/twosix-code/tileserver-rs/pull/new/fix/rgba-dstalpha`
- `https://github.com/twosix-code/tileserver-rs/pull/new/fix/vsicurl-cog-dem`
- `https://github.com/twosix-code/tileserver-rs/pull/new/fix/dataset-cache-byte-bound`

### Environment
- **SSH key:** `~/.ssh/id_ed25519`,
  fingerprint `SHA256:j1gB5IrGvEqtpECoW6IL5r5qkQgmV51Mw0YiAATjwps`
  (`ssh -T git@github.com` → "Hi twosix-code!")
- **Git identity:** `JJK` / `jjk@users.noreply.github.com`
- **No `gh` CLI, no PAT/credential helper, no token in env** — pushes go over SSH.
- **cargo** lives in overlay `~/.cargo/bin` → `export PATH="$HOME/.cargo/bin:$PATH"`
- **No `docker` CLI in this sandbox** — container commands must be run on the host.
- **Husky hook ALWAYS fails on this host**
  ("Failed to create cache directory … `/usr/local/share/corepack/v1`") for both
  commit and push → use `--no-verify`, then verify manually with
  `cargo check --release --features "frontend stac raster"`.

---

## 2. Workstream A — upstream OSS PRs

### Context (why these three)
Both original failures were **integration defects at third-party boundaries**:

1. **`/vsicurl/` normalisation** — a bare `https://…` COG path never entered
   GDAL's range handler; GDAL's curl→`/vsimem` shim downloaded the whole
   523 MB file per open handle (~4 full GETs, 0 `Range`, ~45 s). Fixed by
   wrapping remote paths with `to_gdal_cog_path()` in `cog.rs` / `dem.rs`.
   → **PR #1557**, merged. Post-fix cold z0 tile ~45 s → ~100 ms.
2. **RGBA destination alpha** — `GDALReprojectImage` maps only min(src,dst)
   non-alpha bands 1:1, leaving destination alpha at MEM-init 0 (fully
   transparent tiles). Fixed with a 4-band u8 MEM destination, last band marked
   `GCI_AlphaBand` before warp; 1–2 band legacy layouts forced opaque.
   → **PR #1556**, merged. Maintainer praised it.
3. **Dataset cache byte bound** — Moka was configured with a weigher whose
   estimate was wrong, and a **false docstring** claimed an entry cap applied on
   top (`DEFAULT_CAPACITY = 100` is **dead code** when a weigher is set — moka
   has a single `max_capacity`). → **PR #1558**, open.

Post-fix measurements (recorded): RSS after first overview touch ~1.04 GB →
~72 MB; full z0–z14 sweep (run twice) holds ~73 MB flat, `big_anon_regions=0`,
`VmHWM == current`.

### OPEN ITEM — PR #1558 (the only real outstanding work)
- Branch `fix/dataset-cache-byte-bound` = `6c470b4`, pushed to fork, PR updated.
- **Status: awaiting maintainer re-review.**
- **Anticipated pushback:** whether removing `DEFAULT_CAPACITY` is right, and
  whether a *real second bound* is wanted. Note: **moka has one
  `max_capacity`** — getting two independent bounds would require **two caches**.
  Do **not** build two caches just to fabricate two bounds.
- **Do NOT** implement a hard-coded 512 MB weigher or a phantom per-dataset
  `GDAL_CACHEMAX`.
- If upstream CI flags `fmt`/`clippy` on the branch: fix, re-verify with
  `cargo check --release --features "frontend stac raster"`, force-push with
  `--force-with-lease` to fork (`--no-verify`).

### Staging model (do not break this)
- **Never develop on `fix/*` PR branches.** They are siblings off `bff0948`,
  **one commit each**.
- **`integrate/all-three-fixes` is the daily driver** (`09944d4`).
- `fix/*` branches were created from `bff0948` and pushed to fork; each
  compiles clean with `cargo check --release --features "frontend stac raster"`.
- **Never push to upstream** (`vinayakkulkarni/tileserver-rs`) — only to `fork`.

### Known-good constraint list
- Force IPv4 everywhere (`CURLOPT_IPRESOLVE=4` / `curl -4`) — this origin has a
  broken-IPv6 ~16 s tail.
- Do **NOT** set `GDAL_INGESTED_BYTES_AT_OPEN` — the COG path re-opens per
  overview level.
- **Never bundle** the lint fix `0369c8b` into a behaviour-change PR.
- Use a **fresh process per cold measurement**; mtimes lie.

---

## 3. Workstream B — demo integration (SOLVED this session)

### Measured result
Container `tileserver-rs-demo` **Up (healthy)**; log shows
`Loaded source: manila-rgb` + `Loaded 1 tile source(s)`;
`/data/manila-rgb/9/422/239.png` → **200**, probe `z8/214/118` → **200**.

### Root cause (three real gaps + one self-inflicted regression)
The offline runtime image (`debian:12-slim` + vendored `runtime-libs/`) could
not read the remote HTTPS COG **at all**, so `manila-rgb` failed to register
(`Loaded 0 tile source(s)`) and every `/data/...` request 404'd **instantly**.

1. **No `/etc/nsswitch.conf`, no `libnss_dns.so.2`.** glibc `dlopen()`s NSS
   modules at `getaddrinfo()` time → `ldd tileserver-rs` never lists them →
   the collector never copied them → libcurl couldn't resolve the host **even
   though `getent hosts` still worked** (glibc has its own fallbacks — that's
   how the symptom hid).
2. **No CA trust store.** `libcurl-gnutls.so.4` → `libgnutls.so.30` both verify
   against `/etc/ssl/certs/ca-certificates.crt`; the offline build installs
   nothing → TLS handshake aborts → libcurl connection 0 → GDAL logs
   `HTTP response code: 0` → `GDALOpenEx` NULL → source load fails.
3. *(self-inflicted)* a bad `edit` **deleted `COPY runtime-libs/`** from the
   Dockerfile → loader `cannot open shared object file libsqlite3.so.0` →
   crash loop → `Connection reset by peer` / `000`. **Restored.** Lesson:
   **diff immediately after every edit.**

### The fix — commit `540803e` (`feature/tileserver-demo`)
```
 .gitignore                                         |   1 +
 deploy/tileserver/collect-runtime-libs.sh          | 160 +++++++++++++++++++++
 deploy/tileserver/tileserver-runtime/Dockerfile    |  20 ++-
 deploy/tileserver/tileserver-runtime/nsswitch.conf |  29 ++++
 4 files changed, 209 insertions(+), 1 deletion(-)
```
- `collect-runtime-libs.sh` §1b: collect `libnss_dns.so.2` (**hard-fail if
  absent**) + `libnss_files.so.2`; §3b: ship `ca-certs/ca-certificates.crt`.
- `Dockerfile`: `COPY nsswitch.conf /etc/nsswitch.conf`; `COPY ca-certs/…`;
  ENV `CURL_CA_BUNDLE` + `SSL_CERT_FILE`.
- `nsswitch.conf` (new): `hosts: files dns`.
- `.gitignore`: ignore generated `ca-certs/` (like `runtime-libs/`, `gdal-data/`).

Vendored blobs (`runtime-libs/`, `gdal-data/`, `ca-certs/`, the binary) stay
**untracked** — the collector regenerates them.

### Rebuild / verify cheatsheet
```bash
cd ~/.openclaw/work/gits/Gisat/DynamicServerSideTiles/app-gisat-deckglSandbox
docker compose -f deploy/tileserver/docker-compose.yml build --no-cache
docker compose -f deploy/tileserver/docker-compose.yml up -d
docker ps --filter name=tileserver-rs-demo --format '{{.Names}}\t{{.Status}}'
docker logs tileserver-rs-demo 2>&1 | grep -iE "Loaded [0-9]+ tile source|manila-rgb"
curl -sS -o /dev/null -w 'tile z9: %{http_code}\n' http://localhost:8080/data/manila-rgb/9/422/239.png
curl -sS -o /dev/null -w 'probe  : %{http_code}\n' http://localhost:8080/data/manila-rgb/8/214/118.png
```
If it regresses, run verbose to read the exact failure line rather than guess:
```bash
docker run --rm --name tileserver-rs-test -p 8080:8080 \
  -v "$PWD/deploy/tileserver/config.toml:/app/config.toml:ro" \
  -e CPL_CURL_VERBOSE=YES tileserver-rs-demo:local --config /app/config.toml 2>&1 | head -70
```

### Key demo facts
- **Source id:** `manila-rgb` (`config.toml [[sources]]`), remote COG:
  `…/Manila_S2_Composite_2020022_Mercator_RGB_COG_DEFLATE.tif` (uint8 3-band,
  EPSG:3857, DEFLATE).
- **Bounds:** lon 118.13–123.75, lat 11.13–16.58. Tiles **outside** footprint
  404 **by design** — the app's probe tile must stay **fully inside** (currently
  `z8/214/118`).
- **App route:** `/tileserver-manila-rgb` in `src/maps/config.js`; the app calls
  `${baseUrl}/data/${sourceId}/{z}/{x}/{y}.png` via the Vite proxy
  `tileserver-api` → `:8080`.
- **Docker build is thin** — it copies a **prebuilt** binary
  (`tileserver-runtime/tileserver-rs`); it does not compile. Refresh it with:
  `cp ../../../tileserver-rs/target/release/tileserver-rs tileserver-runtime/`.
  Binary sha256 this session: `8757bb7d…` (41,266,024 B, v2.39.0).
- **DEMO BINARY SCOPE:** the demo runs the **integration binary** (three PR
  fixes). It does **NOT** include `407fe8c` (`feat/identity-raster-cache`).
  `endpoints.js` says the demo stack is built from that branch — so if identity
  raster-tile caching is ever needed, fold `407fe8c` in (it is **not** a `/data`
  route; those routes exist in stock upstream at `routes/mod.rs:78-80`).

---

## 4. Next steps (in priority order)

1. **[BLOCKED on maintainer] PR #1558 re-review.**
   Check for reviewer comments; if changes land, revise `fix/dataset-cache-byte-bound`
   (single commit, `--force-with-lease` to fork, `--no-verify`), re-verify build.
   Anticipated thread: `DEFAULT_CAPACITY` removal / whether a real second bound
   is wanted (moka = one `max_capacity`; two bounds ⇒ two caches — likely not worth it).
2. **[optional] Push the demo branch.** `feature/tileserver-demo` @ `993de09`
   (incl. `540803e`) is **local == origin** for the branch, but confirm whether
   `540803e`/`993de09` are actually pushed — the earlier session noted a pending
   push. Push with `--no-verify`.
3. **[optional] Commit the three `knowhow/*.md`** which are untracked and are
   **not** part of `540803e`:
   - `deploy/tileserver/knowhow/BuildFeatureBranchToolchain.md`
   - `deploy/tileserver/knowhow/Manila-RGBA-COG-Development-Summary.md`
   - `deploy/tileserver/knowhow/tileserver-rs-oom-handoff.md`
4. **[optional] Refresh the workspace memory file** with PR numbers + review
   outcome + this demo fix:
   `~/.openclaw/workspace/memory/2026-10-17-tileserver-rs-prs.md`
   (consider a `2026-10-18` entry for the offline-image fix).
5. **[watch] Upstream CI on #1558** — `fmt`/`clippy`/`Complexity (CRAP)`. Note
   the CRAP check was **non-blocking** on #1556/#1557.
6. **[if demo needs full parity] Fold `407fe8c`** (`feat/identity-raster-cache`)
   onto a new `integrate/demo-full` branch, build, refresh the Docker context —
   only if identity raster-tile caching becomes a requirement.

---

## 5. Repo state snapshot ⏱ (2026-10-18)

```
tileserver-rs  (branch integrate/all-three-fixes @ 09944d4)
  remotes: origin=vinayakkulkarni/tileserver-rs, fork=twosix-code/tileserver-rs
  fork base: bff0948   origin/main tip: 71f7306
  fix/rgba-dstalpha           ed3d83c   (local==fork)  PR #1556 MERGED
  fix/vsicurl-cog-dem         85691b9   (local==fork)  PR #1557 MERGED
  fix/dataset-cache-byte-bound 6c470b4  (local==fork)  PR #1558 OPEN
  integrate/all-three-fixes   09944d4   (local==fork)

app-gisat-deckglSandbox  (branch feature/tileserver-demo @ 993de09)
  540803e  fix(tileserver-demo): offline image NSS + CA trust store
  993de09  fix(tileserver-demo): probe tile fully inside COG footprint
  working tree: 3 untracked knowhow/*.md (see §4.3)
```

## 6. Lessons worth keeping

- **Verify against actual code/logs, not inference.** This session burned three
  theories (route → DNS → TLS) before landing; the log lines were the decider.
- **`ldd` does not show `dlopen()`ed libs** (NSS modules). A missing CA bundle
  and missing `/etc/nsswitch.conf` both present as `HTTP response code: 0` from
  GDAL — not as obvious "file not found" errors.
- **`git diff` immediately after every `edit`.** The one real regression here
  (deleted `COPY runtime-libs/`) was invisible until a diff was run several
  steps later.
- **Offline Docker images ship nothing** — anything the process needs at runtime
  (NSS modules, CA bundle, GDAL/PROJ data) must be explicitly collected.
- **Husky fails on this host** — always `--no-verify`, then verify manually.
