# tileserver-rs OOM — handoff

**Date:** 2026-10-15
**Status:** Updated after probe. **Core "unbounded leak" claim REVISED — see PROBE RESULT below.**
**Repo:** `/home/node/.openclaw/work/gits/Gisat/DynamicServerSideTiles`
**Component:** `tileserver-rs` (Rust) serving `manila-rgb` COG

---

## PROBE RESULT (2026-10-15 23:47, supersedes the TL;DR where they conflict)

Ran `crates/cog-leak-probe` — a standalone binary that opens the remote COG once via bare
`gdal::Dataset::open`, holds it, and samples its OWN RSS every 3 s for 180 s. **Zero tileserver
code, zero dataset_cache, zero tile requests.** Daemon env copied exactly.

```
open: 46,244 ms   bands=4  overviews=8   rss=567,880 kB (568 MB)
RSS at t=0, 49, 78, 118, 178 s -> 567,880 kB  (perfectly FLAT, exit 0)
```

**Bare GDAL open + hold does NOT grow.** That falsifies the old hypothesis
("GDAL retains ~512 MB per overview level unbounded"). The 568 MB is a one-time open cost
(tile-cache-sized region + GDAL side caches), stable indefinitely.

### What actually happens under load (from `/tmp/tsr-rss.csv`, 3 s sampler)

| when | RSS | note |
|---|---|---|
| 22:25 fresh start | 584,620 kB | before any tile request |
| 22:38-22:42 load | 730 MB -> **2,918,716 kB (2.92 GB) peak** | z9 tile sweep, ntile 0->42 |
| 22:43 load ends | 1,110,264 kB | settles |
| 23:45-23:56 idle | **1,038,812 kB, FLAT for 11+ min** | 0 conns, 0 tile reqs |

The server is **idle at 1.04 GB and rock-steady — no idle creep.** The 2.92 GB peak was
transient, concurrent with the sweep, and came back down. Bounded working-set behaviour,
NOT the unbounded runaway described below.

### The 2 large anonymous regions (server smaps, idle)
```
511,560 kB rss / 630,872 kB size   7f506ce6e000-...  rw-p 0
449,300 kB rss / 629,732 kB size   7f50dcf62000-...  rw-p 0
```
Two ~616 MB virtual / ~500 MB resident anon regions = the 512 MB tile cache + one GDAL
side-cache region. Matches the probe's single 568 MB. Not thousands of 512 MB regions.

### Verdict
- **No unbounded leak reproduced** in bare GDAL, nor in the current binary at idle.
- Current binary (md5 `edd50775...`, running pid 14241) == `target/release/tileserver-rs`
  built 21:32, so it **includes** `5353d79` RGBA fix + `2caf069` overview cache + the
  uncommitted byte-weighted `dataset_cache.rs`.
- The byte-weighted cache (DEFAULT_MAX_BYTES = 256 MB) is **compiled in** and the server holds
  1.04 GB steady — plausibly why it no longer runs away. But see the eviction gap below.

### OPEN GAP: moka eviction is lazy and `run_pending_tasks()` is never called in prod
`grep run_pending_tasks` -> only `dataset_cache.rs:293/312/315`, all inside `#[cfg(test)]`.
Moka's byte-weighted eviction runs lazily; without a periodic `run_pending_tasks()` the byte
cap is not actively enforced. Idle RSS (1.04 GB) exceeds DEFAULT_MAX_BYTES (256 MB), so the
byte cap is NOT being observed at idle (some of that 1.04 GB is the separate 512 MB tile
cache + GDAL side caches, which this cap never covered). Next step: either call
`run_pending_tasks()` on an interval, or confirm moka 0.12.16 auto-drains on insert — then
re-test with a sustained multi-zoom sweep to confirm the 9.7 GB runaway is actually gone.

### Toolchain note (this container, Debian 12)
Pure system build (no conda): `pnpm install` + `pnpm run generate`, then
`CARGO_BUILD_JOBS=4 cargo build --release --features "frontend stac raster"`.
Rust via rustup (cargo 1.99.1); system libclang-14 at `/usr/lib/llvm-14/lib/libclang.so`,
libgdal-dev 3.6.2, gcc 12.2.0. Binary fully system-linked, 0 conda refs.

---

## TL;DR (ORIGINAL — superseded where it conflicts with PROBE RESULT above)

`tileserver-rs` grows without bound under sustained tile load and is OOM-killed at ~9.7 GB RSS
on a 15.6 GB host. Verified cause: **one tile source allocates and retains ~512 MB regions
(one per GDAL overview level opened) with no effective eviction.**

My earlier claim that the leak was fixed was **wrong** — it was a snapshot from a quiet moment.

---

## Verified evidence

### The crash
- Server reached **RSS = 9,679,996 kB (9.7 GB)**, `VmSwap = 344 MB`.
- Process then **died**; launcher shell died with it; port 8080 closed.
- Memory recovered to free ~9.2 GB after death → the kernel reclaimed a single large process.
- `journalctl -k` / `dmesg` unreadable in this container → **no confirmed OOM-killer line**, but
  memory profile makes mechanism unambiguous (host had 3.6 GB/4 GB swap consumed, PSI full avg10 ≈ 3).
- Earlier symptom: a wedged instance (pid 37074) answered `/health` 200 but tile requests timed out
  at 120 s with **zero outbound sockets** while worker threads sat in `do_sys_poll`. Same root cause,
  different failure face.

### Region growth (attribution test)
| Moment | RSS | Regions >100 MB |
|---|---|---|
| Fresh start, **before any tile request** | 578 MB | **1** (~512 MB) |
| After z8→z17 sweep | 2.66 GB | **5** (~512 MB each) |
| Under sustained load | **9.7 GB** | (grows further) |

- All five regions are **anonymous, 4 kB pages, THP not backing them** (`rw-p 00000000 00:00 0`).
- The 1 region at startup = the **512 MB tile cache** (`[cache] max_size_mb = 512`).
- The extra 4 appear **only during render** → per-overview GDAL dataset entries.

### What was ruled out
- **Tile cache is NOT the growth.** Lowering `max_size_mb` 512 → 64 changed RSS by nothing
  (2.66 GB either way, still 5 regions). Config was restored to 512.
- **GDAL per-dataset caching alone is not it.** A fresh `gdalinfo -stats` on the same COG peaks at
  **329 MB**, not 512 MB × N.
- Not THP inflation; not multiple tileserver instances (only 1 was running).

---

## What I changed this session

### 1. Env mitigation — `deploy/tileserver/run-native.sh` (APPLIED, in effect)
```
CPL_VSIL_CURL_CACHE_SIZE=67108864   # 512MB -> 64MB
VSI_CACHE=FALSE
VSI_CACHE_SIZE=0
```
Also present: `GDAL_CACHEMAX=200`, `GDAL_BAND_BLOCK_CACHE=HASHSET`,
`CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif,.TIF,.tiff`.
**Effect:** lowered the ceiling somewhat (original runaway was 7.8 GB and climbing at ~40 MB/s),
did NOT stop the growth.

### 2. Code fix — `crates/tileserver-rs/src/sources/dataset_cache.rs` (UNCOMMITTED, compiled in)
- Converted the dataset cache from entry-count to **byte-weighted** eviction:
  `with_max_bytes(capacity, ttl, max_bytes)`, `entry_cost_bytes()`,
  `DEFAULT_MAX_BYTES = 256 * 1024 * 1024`.
- `global()` now uses `with_max_bytes(...)`.
- Diff: `109 insertions(+), 12 deletions(-)`.
- **It is compiled into the running binary** (running exe == rebuilt exe, 19:03 build, 30 MB).
- **It does NOT constrain the growth.** Suspected cause: **moka evicts lazily** and needs
  `run_pending_tasks()` / periodic maintenance, OR the growth is not in `dataset_cache` at all.

> Correction: I earlier said this fix "wasn't in the binary" because `strings` found no new
> symbols. That was a **bad check** — the identifiers are inlined / not string literals.
> The source diff proves the change is present and compiled.

---

## Build notes (for whoever continues)

- Rebuilt binary: `tileserver-rs/target/release/tileserver-rs` (30,270,160 bytes, 19:03).
- Pre-fix backup binary existed at ~41,295,880 bytes (different size — flag if diffing build config).
- Toolchain: builds against **conda GDAL 3.6.2** (`/home/node/conda-env`), not the 3.13.3 in the build env.
  clang/bindgen wired via sysroot. `LD_LIBRARY_PATH=/home/node/conda-env/lib`,
  `GDAL_DATA=/home/node/conda-env/share/gdal`, `PROJ_DATA=/home/node/conda-env/share/proj`.
- Config: `deploy/tileserver/config.toml` (`[cache] max_size_mb = 512`, `ttl_seconds = 3600`).
  Backup of the 512 value at `/tmp/config.toml.bak-512`.
- Start: `cd deploy/tileserver && ./run-native.sh --foreground` (first COG open takes ~40 s).

---

## Recommended next steps (not done)

1. ~~Profile under valgrind/heaptrack~~ — DONE via `cog-leak-probe`; bare GDAL is flat, so
   massif on GDAL would only re-confirm. Profiling now belongs on the *tileserver* render path
   under a sustained sweep, not on GDAL open.
2. ~~Read the render path for unbounded per-overview structures~~ — `2caf069` added the
   per-(path, level) cache; byte-weighted eviction is in the working tree but uncommitted and
   `run_pending_tasks()` is never called in prod (see OPEN GAP). Verify eviction is real.
3. **Remaining:** commit the byte-weighted `dataset_cache.rs`, wire a periodic
   `run_pending_tasks()` (or confirm moka auto-drain), then run a **sustained multi-zoom sweep**
   and confirm RSS plateaus ~1 GB instead of climbing to 9.7 GB. Only then is the leak "fixed".
4. **Stopgap still valid:** hard RSS cap (`MemoryMax`/cgroup) so it recycles before it OOMs
   the host — cheap insurance regardless of the final fix.

---

## Session metadata warning

This session's exec/process context repeatedly reported stale PIDs as "running"
(e.g. `ember-lobster` pid 26614, `fresh-dune` pid 37072, `nimble-shore` pid 38061).
Every one was verified via `/proc/<pid>` and was **gone**. Do not trust reported PIDs
without a direct `/proc` check.
