# TileserverMemoryPool-IP.md — Implementation Plan

> **Purpose:** implementation plan for the PR #1558 rework — replace the single
> shared overview handle with a **pool of handles per overview level**, so
> concurrent tiles at one zoom render in parallel while the open is still
> cached and memory stays bounded.
>
> **Status:** design fully determined. Root cause confirmed by probe. Ready to
> execute.
>
> **Repo:** `~/.openclaw/work/gits/Gisat/DynamicServerSideTiles/tileserver-rs`
> **Branch:** `fix/dataset-cache-pool` (off `origin/main` @ `5f275adf`)
> **PR:** https://github.com/vinayakkulkarni/tileserver-rs/pull/1558

---

## 0. Context — why this rework exists

PR #1558 originally cached **one** `Arc<Mutex<Dataset>>` per overview level
(`{path}#ovr{level}`). The maintainer measured that this **serialises**
concurrent renders: every tile at one zoom clones the same `Arc` and calls
`blocking_lock()`, holding it for the whole render. Result (his numbers, local
8192² COG, 4 overviews, `hey`, 10 s, 2 rounds):

| Tile | Concurrency | `main` req/s | PR req/s |
|---|---|---|---|
| z2 | 1 | 284 | 550 |
| z2 | 16 | 2,260 | 585 |
| z3 | 1 | 280 | 540 |
| z3 | 16 | 2,290–2,480 | 480–585 |

~2× faster single-request (cached open), ~4× **slower** at 16 concurrent.
Unshippable as-is.

**Maintainer's proposal:** cache a small **pool** of handles per level; a render
takes a free handle and returns it; open a new one only if the pool is below its
limit (`std::thread::available_parallelism()`); the weigher counts the handles
open now so the byte budget stays correct.

**Owner decisions taken (settled):**
1. **Hard bound**, not a soft hint — the pool cannot exceed its limits.
2. **Byte budget is enforced, not merely measured** — the pool refuses to open a
   new handle once the process-wide live byte total would exceed the budget.
3. **Condvar-in-blocking** for the wait (not a semaphore): one lock, one
   counter, one atomic. The wait parks a blocking thread, which is acceptable
   because the pool limit equals hardware parallelism and the wait is short.
4. Acquire/release happens **inside the blocking render task**.

---

## 1. Root cause of the current test hang (CONFIRMED)

`acquire_arc()` calls `open_blocking()` → `Dataset::open` **directly on the
async thread**. Under `#[tokio::test]`'s current-thread runtime this deadlocks
on GDAL's driver-registration lock.

- The old code (`6c470b4`) opened datasets inside `tokio::task::spawn_blocking`
  (a real worker thread); the rewrite moved the open onto the async thread.
- **Probe evidence:** the test prints `PROBE: before first acquire` and never
  reaches `PROBE: after first acquire` — it hangs *inside* the first
  `acquire_arc`, whose only blocking call is `open_blocking()`.
- **Correlation:** the 4 hanging tests are exactly those calling
  `acquire_arc()` from an async body; the 4 passing tests never acquire.

| Test | Result |
|---|---|
| `acquire_release_reuses_handle` | **HANG** |
| `byte_budget_is_enforced` | **HANG** |
| `concurrent_acquires_get_distinct_handles` | **HANG** |
| `miss_on_nonexistent_path_returns_error_and_does_not_cache` | **HANG** |
| `invalidate_drops_base_and_overview_keys` | **FAIL** |
| `base_and_overview_keys_are_distinct_entries` | pass |
| `global_is_stable_across_calls` | pass |
| `hit_returns_same_pool` | pass |
| `weighted_size_counts_live_handles` | pass |

**Fix principle:** the pool's *open* must never run on the async thread. The
condvar wait is fine on a blocking thread. So acquire-and-open both belong in a
blocking context.

---

## 2. Step 0 — Revert probe edits

- Restore `crates/tileserver-rs/src/sources/dataset_cache.rs` from
  `/tmp/dataset_cache.rs.bak` (removes the `eprintln!("PROBE: …")` lines).
- Verify: `grep -c PROBE crates/tileserver-rs/src/sources/dataset_cache.rs` → `0`.

---

## 3. Step 1 — Make `acquire_arc` async (core fix)

**File:** `crates/tileserver-rs/src/sources/dataset_cache.rs`

Change the signature and split the body so the open happens on a blocking
thread:

```rust
pub async fn acquire_arc(self: &Arc<Self>) -> Result<PooledHandle> {
    // Fast path: a free handle needs no I/O — take it on the async thread.
    {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dataset) = state.idle.pop() {
            return Ok(PooledHandle { dataset: Some(dataset), pool: Arc::clone(self) });
        }
    }

    // Slow path: opening (and any waiting) is blocking work — run it off the
    // async thread so GDAL's open cannot stall the runtime.
    let pool = Arc::clone(self);
    tokio::task::spawn_blocking(move || pool.acquire_blocking())
        .await
        .map_err(|e| TileServerError::RasterError(format!("task failed: {e}")))?
}

/// Blocking acquire: open a handle or wait for one. MUST run on a blocking
/// thread (GDAL open + condvar wait are both blocking).
pub(crate) fn acquire_blocking(self: &Arc<Self>) -> Result<PooledHandle> {
    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if let Some(dataset) = state.idle.pop() {
            return Ok(PooledHandle { dataset: Some(dataset), pool: Arc::clone(self) });
        }
        if state.live < self.limit && self.reserve_budget() {
            match self.open_blocking() {
                Ok(dataset) => {
                    state.live += 1;
                    return Ok(PooledHandle { dataset: Some(dataset), pool: Arc::clone(self) });
                }
                Err(e) => {
                    GLOBAL_LIVE_BYTES.fetch_sub(self.cost_bytes, Ordering::AcqRel);
                    return Err(e);
                }
            }
        }
        state = self.returned.wait(state).unwrap_or_else(|e| e.into_inner());
    }
}
```

**Notes:**
- The fast path (idle hit) stays on the async thread — no I/O, no blocking.
- The slow path is one `spawn_blocking` hop. It re-checks `idle` inside (a
  handle may have been returned between the fast-path check and the spawn) —
  that is why `acquire_blocking` repeats the `idle.pop()`.
- `PooledHandle::drop` is unchanged: it locks `state`, pushes to `idle`,
  `notify_one()`. It runs on whatever thread drops the handle (the blocking
  render thread in `cog.rs`), which is correct.

---

## 4. Step 2 — Update the call sites (the crux)

**File:** `crates/tileserver-rs/src/sources/cog.rs` (~line 64, in `from_file`)

```rust
let pool = dataset_cache::global().get_or_open(&path).await?;
let base_handle = pool.acquire_arc().await?;          // was: pool.acquire_arc()?
let dataset: Arc<Mutex<Dataset>> = Arc::new(Mutex::new(base_handle.into_dataset()));
```

**File:** `crates/tileserver-rs/src/sources/dem.rs` (~line 282, in `resolve_dataset`)

```rust
let pool = dataset_cache::global().get_or_open(&path).await?;
let handle = pool.acquire_arc().await?;               // was: pool.acquire_arc()?
Ok(Arc::new(Mutex::new(handle.into_dataset())))
```

**File:** `crates/tileserver-rs/src/sources/cog.rs` (~line 190, inside `spawn_blocking`)

This one is **already** in a blocking closure, so it must call the **blocking**
variant, not the async one:

```rust
Some(pool) => {
    let handle = pool.acquire_blocking()?;            // blocking context — use the sync fn
    render_from(handle.dataset())
}
```

> ⚠️ **This is the subtle part.** `acquire_arc` becomes async, but `cog.rs`'s
> render path is sync inside `spawn_blocking`. It must call `acquire_blocking`
> directly. Getting this wrong reintroduces the hang. One-line distinction, but
> it is the crux of the whole fix.

---

## 5. Step 3 — Fix the `invalidate` test failure

**Symptom:** `invalidate_drops_base_and_overview_keys` fails (0 passed, 1 failed).

**Likely cause:** `invalidate_entries_if` is asynchronous — it registers a
predicate that moka applies on its next maintenance pass. The test calls
`cache.inner.run_pending_tasks().await` after `invalidate`, but the predicate
may need an extra maintenance pass to be evaluated.

**Action:**
1. Read the actual failure output first (only the summary line was seen so far).
2. If entries survive: call `run_pending_tasks()` twice, or switch to explicit
   per-key `invalidate(key)` for base + each `#ovr{n}`.
   - Preferred: keep `invalidate_entries_if` (it handles an unknown level count)
     and add the needed maintenance call.

---

## 6. Step 4 — Update the tests that call `acquire_arc`

All test call sites become `.await`:

- `acquire_release_reuses_handle`: `pool.acquire_arc().await`
- `concurrent_acquires_get_distinct_handles`: `pool.acquire_arc().await`
- `weighted_size_counts_live_handles`: `pool.acquire_arc().await`
- `byte_budget_is_enforced`: `pool.acquire_arc().await`
- `miss_on_nonexistent_path_returns_error_and_does_not_cache`: `pool.acquire_arc().await`

Strengthen the concurrency test per the maintainer's ask: spawn N tasks that
each acquire, hold briefly, release — and assert wall-clock is not serialised
(or assert `live_handles() >= 2` observed concurrently). The current test
acquires sequentially, which does not prove parallelism.

---

## 7. Step 5 — Add the missing tests the maintainer asked for

1. **Overview path in `cog.rs`** — needs a fixture with real overviews. Build
   one with `gdaladdo` or `Dataset::build_overviews`, then assert a low-zoom
   `get_tile` reads from the overview level and produces a valid PNG.
2. **Concurrency test** (Step 4) — N parallel tiles at one level must not run
   one at a time.

---

## 8. Step 6 — Verify

```bash
cd ~/.openclaw/work/gits/Gisat/DynamicServerSideTiles/tileserver-rs
export PATH="$HOME/.cargo/bin:$PATH"

# compile
cargo check --release --features "frontend stac raster"

# all cache tests, single-threaded, with a hard timeout so a hang cannot wedge the shell
timeout 300 cargo test --release --features "frontend stac raster" \
  -p tileserver-rs --lib sources::dataset_cache -- --test-threads=1

# cog tests (overview + render)
timeout 300 cargo test --release --features "frontend stac raster" \
  -p tileserver-rs --lib sources::cog -- --test-threads=1
```

**Gate:** all tests green, zero warnings. Do not proceed to push otherwise.

---

## 9. Step 7 — Ship

1. Squash into the single PR commit (the branch must stay one commit, per the
   staging model).
2. `git push --force-with-lease fork fix/dataset-cache-pool:fix/dataset-cache-byte-bound --no-verify`
   (husky fails on this host; verify manually with the `cargo check` above).
3. Post the PR reply: pool-per-level implemented, byte budget **enforced** (not
   measured), condvar wait on the blocking side, plus the batched fixes (lower
   estimate 64→8 MB, `try_get_with`, `invalidate` drops `#ovr*`), and the two
   new tests.

---

## 10. Design reference — the pool as implemented

### 10.1 Types

```rust
pub struct Pool {
    state: StdMutex<PoolState>,   // idle handles + live count, one lock
    returned: Condvar,            // signalled by PooledHandle::drop
    limit: usize,                 // available_parallelism()
    cost_bytes: u64,              // per-handle byte estimate
    max_bytes: u64,               // process-wide byte budget
    path: String,
    open_options: Vec<String>,    // e.g. OVERVIEW_LEVEL=N
}

struct PoolState {
    idle: Vec<Dataset>,           // free handles
    live: usize,                  // open handles (idle + borrowed)
}
```

### 10.2 Bounds (both enforced)

- **Concurrency:** `live < limit` checked under the same lock before opening.
- **Memory:** `reserve_budget()` — an atomic CAS on the process-global
  `GLOBAL_LIVE_BYTES`; refuses to open when `global + cost > max_bytes`.

### 10.3 Why a condvar and not a semaphore

The pool needs exactly one thing: a way to wait until a handle is free without
holding the lock the returning thread needs. A `Condvar` paired with the state
mutex does precisely that — `wait` atomically releases the mutex while parked,
and `PooledHandle::drop` signals it. A semaphore would add a second primitive, a
second accounting path, and an async/blocking boundary to get right, for no
additional guarantee.

### 10.4 `PooledHandle` and release

```rust
impl Drop for PooledHandle {
    fn drop(&mut self) {
        if let Some(dataset) = self.dataset.take() {
            let mut state = self.pool.state.lock().unwrap_or_else(|e| e.into_inner());
            state.idle.push(dataset);       // return it
            drop(state);
            self.pool.returned.notify_one(); // wake one waiter
        }
        // `live` is NOT decremented: the handle stays open and counted.
        // It is only closed, and its cost released, when the pool is dropped.
    }
}
```

Panic-safe: a render that unwinds still returns its slot, so the pool cannot
leak capacity.

### 10.5 Byte accounting

- `weighted_bytes() = live × cost_bytes` per pool.
- `DatasetCache::weighted_size() = GLOBAL_LIVE_BYTES` (process-wide live total).
- The budget is **enforced** by `reserve_budget()` before every open, not merely
  reported.

### 10.6 Cost estimates

- `OVERVIEW_COST_BYTES = 8 MB` (matches observed ~8 MB per overview dataset in
  RSS measurements; the original 64 MB made a 256 MB budget hold only ~4
  datasets, causing thrash).
- `BASE_COST_BYTES = 16 MB`.
- `DEFAULT_MAX_BYTES = 256 MB`.

---

## 11. Batched smaller fixes (from the maintainer's review)

1. **Lower the overview estimate** 64 MB → 8 MB (done in §10.6).
2. **`try_get_with`** for pool creation — one init per key under concurrent
   misses (done).
3. **`invalidate` drops `{path}#ovr*` keys** — via `invalidate_entries_if` +
   `support_invalidation_closures` (done; test fix pending, §5).
4. **Share one code path** for `get_or_open` / `get_or_open_with_options` (done —
   both delegate to `get_or_open_cached`).

---

## 12. Risk / open items

- **Only real risk:** the async/sync split in §4 — `cog.rs`'s render path must
  call `acquire_blocking`, not `acquire_arc`. Getting this wrong reintroduces
  the hang. One-line distinction, but it is the crux.
- **`invalidate` failure** not yet root-caused (only the summary line was seen).
  §5 starts by reading the actual assertion output.
- **No ambiguity in the design.** The plan is fully determined; nothing needs a
  decision from the owner.

---

## 13. Staging model (do not break)

- **Never develop on `fix/*` PR branches.** They are siblings off `bff0948`,
  one commit each.
- The rework lives on `fix/dataset-cache-pool` (off the new `main` @ `5f275adf`)
  and is force-pushed onto `fix/dataset-cache-byte-bound` as a single commit.
- **Never push to upstream** (`vinayakkulkarni/tileserver-rs`) — only to `fork`.
- Husky fails on this host → `--no-verify`, then verify manually with
  `cargo check --release --features "frontend stac raster"`.
