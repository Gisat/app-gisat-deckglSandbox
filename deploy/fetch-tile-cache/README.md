# fetch-tiles.mjs

Download every tile of a `{z}/{x}/{y}` endpoint over a bounding box into a single
**MBTiles** archive — for offline use, export, QA, or pre-warming a tile cache.

Zero dependencies: Node's built-in `fetch`, `node:sqlite` and `zlib` only. No
`sqlite3` CLI, no GDAL, no tippecanoe.

```sh
node fetch-tiles.mjs \
  --tiles-url="http://localhost:8080/data/io-lulc/{z}/{x}/{y}.png" \
  --bbox=11.2,47.9,11.9,48.4 --zoom-levels=9-11 \
  --output=io-lulc.mbtiles
```

Start with `--dry-run` — see [Always plan first](#always-plan-first).

---

## 1. What it does

Given a tile URL template, a geographic box and a zoom range, the tool:

1. **plans** the exact tile coordinates to fetch (and prints the count),
2. **fetches** them with a bounded worker pool, in one or more passes,
3. **writes** them into an MBTiles archive with correct TMS row ordering,
4. **verifies** by reporting what actually landed, per zoom.

Tiles the source does not have are recorded in a **miss list** instead of being
silently forgotten, so the archive's coverage is explainable.

---

## 2. Key concepts

### 2.1 A tile pyramid

Web maps split the world into a quadtree. At zoom `z` the world is `2^z × 2^z`
tiles; each step down quadruples the count. Tile `(z, x, y)` covers a fixed
geographic area:

```
x = floor( (lon + 180) / 360 * 2^z )
y = floor( (1 - asinh(tan(lat)) / π) / 2 * 2^z )
```

Two consequences drive everything here:

- **Cost explodes ~4× per zoom.** For `bbox=0,30,30,60`:

  | zoom | tiles |
  |---|---|
  | z10 | 10,836 |
  | z11 | 42,921 |
  | z12 | 171,342 |
  | z13 | 684,366 |
  | z14 | 2,736,098 |
  | **z3–14 total** | **3,649,272** |

  That is a batch job, not a script run. Hence `--dry-run`.

- **`lat_max` is the NORTH edge and maps to the SMALLEST y.** Getting this
  backwards yields an empty or vertically inverted range. The tool asserts the
  correct direction in `--selftest`.

### 2.2 XYZ vs TMS — the flip that silently breaks archives

Tile servers address tiles as **XYZ** (y grows southward from the north pole).
MBTiles stores rows as **TMS** (y grows northward from the south pole):

```
tile_row = 2^z - 1 - y
```

Skip the flip and you get a file that **opens fine in every reader and is upside
down**. This tool applies the flip in exactly one place (the tile sink), and
`--selftest` pins `flipY(11, 710) === 1337`.

### 2.3 bbox ordering

`--bbox=w,s,e,n` — longitude_min, latitude_min, longitude_max, latitude_max, in
EPSG:4326 degrees. Swapped latitude or longitude pairs are normalised, and values
beyond the WebMercator limit (±85.05112878) are rejected.

### 2.4 Raw bbox by default, `--debug-bbox` to clamp

The default crawls **the box you asked for**, nothing more:

```
source  : <not consulted: raw bbox> (--debug-bbox intersects with source bounds)
bbox    : 0,30,30,60
```

`--debug-bbox` intersects that box with the source's advertised TileJSON
`bounds` and clamps zooms to its `minzoom`/`maxzoom`, printing what changed:

```
source  : http://localhost:8080/data/io-lulc.json
bbox    : 11.2,47.9,11.9,48.4   (requested 0,30,30,60)
clipped bbox 0,30,30,60 -> source bounds 11.2,47.9,11.9,48.4
```

Same request, same source: **3,649,272 tiles raw vs 1,592 inside the advertised
bounds** — a 2300× difference. Both produce a near-identical archive, because
out-of-coverage tiles are skipped or dropped as blank; the difference is how
many pointless requests you pay for.

Use `--debug-bbox` when you want the honest coverage picture, or when you suspect
the advertised `bounds` overstate what the source really has.

### 2.5 Passes, not per-tile retries

Within a pass, each tile gets **exactly one request**. Anything that fails lands
on the miss list, and pass N+1 re-fetches only that list:

```
pass 1/2: 38 tiles queued
  pass 1/2  38/38 20.4 t/s  stored=38 blank=0 404=0 http=0 net=0
pass 1: no misses, stopping early
```

Why not retry immediately? Against a renderer, an instant retry usually hits the
same broken state (cold COG, upstream hiccup) and just burns the timeout twice.
A fresh pass moments later does not. Measured with a server that 500s on the
first request per tile and succeeds afterwards: pass 1 lost 4 tiles, pass 2
recovered all 4.

Miss categories are kept distinct because they mean different things:

| category | meaning | retried next pass? |
|---|---|---|
| `404` | no tile here (outside coverage, below minzoom) | **no** — deterministic |
| `http` | 5xx or other non-200 | yes |
| `net` | timeout / connection failure | yes |
| *(blank)* | fetched fine, fully transparent | never — not a miss |

Passes stop early when nothing retryable remains.

### 2.6 Blank tiles: alpha, not brightness, not bytes

A tile server often answers an out-of-coverage request with **200 and a rendered
blank tile**. Blankness cannot be read off the status code, and *not* off the
size — measured blanks on this server at 1,909 B and out-of-footprint tiles at
various sizes.

It also cannot be read off brightness. A real tile in this dataset is **0.87 %
non-black with only 153 opaque pixels out of 65,536** — any "mostly black means
empty" heuristic deletes it.

The tool decodes the PNG and checks the **alpha channel**: blank only if every
pixel is fully transparent (colour type 4/6 with all alpha bytes zero, or palette
+tRNS mapping everything to alpha 0). Anything undecidable — RGB without alpha,
interlaced, 1/2/4-bit, malformed, truncated, not a PNG — is treated as **not
blank**, so a real tile is never discarded on a parser bug.

Cost is 1.6–2.1 ms per tile, against 230 ms–5 s of network latency: negligible.

### 2.7 MBTiles layout

Readers expect exactly this, including **both** unique indexes (without them
`INSERT OR REPLACE` cannot dedupe):

```sql
CREATE TABLE metadata (name TEXT, value TEXT);
CREATE UNIQUE INDEX name ON metadata (name);
CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER,
                    tile_row INTEGER, tile_data BLOB);
CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
```

During a crawl the archive runs in **WAL** mode (crash safety, batched commits
every 500 rows) so a killed run leaves a readable file. At the end it is
checkpointed and switched back to `journal_mode=DELETE`, because a WAL-mode
archive makes *every* reader create `-wal`/`-shm` files beside it — turning a
one-file deliverable into three.

---

## 3. CLI reference

### Required

| flag | meaning |
|---|---|
| `--tiles-url=<url>` | Template containing `{z}`, `{x}`, `{y}`, e.g. `http://host/data/src/{z}/{x}/{y}.png` |
| `--bbox=<w,s,e,n>` | Box in WGS84 degrees. Optional with `--from-misses` |
| `--zoom-levels=<spec>` | `3-14`, `0-5,8,10-12`, `14-3`. Optional with `--from-misses` |
| `--output=<file>` | Destination `.mbtiles` |

### Fetching

| flag | default | meaning |
|---|---|---|
| `--concurrency=<n>` | `8` (max 32) | Parallel requests. Server render pools are typically ~16; going past that only queues |
| `--passes=<n>` | `2` | Total passes. Pass N+1 fetches only retryable misses from pass N |
| `--timeout=<ms>` | `30000` | Per-request timeout. Raise for cold remote-COG renders, which exceed 30 s |
| `--header=<"K: V">` | — | Extra request header; repeatable |

### Clipping

| flag | default | meaning |
|---|---|---|
| `--debug-bbox` | off | Intersect bbox with source TileJSON bounds; clamp zooms to its min/max; report changes |
| `--tilejson=<url>` | derived | TileJSON source for `--debug-bbox` (`.../src/{z}/{x}/{y}.png` → `.../src.json`) |

### Output control

| flag | default | meaning |
|---|---|---|
| `--skip-empty` / `--no-skip-empty` | drop | Drop fully transparent tiles |
| `--resume` / `--no-resume` | resume | Continue an existing archive, or abort if the file exists |
| `--force` | off | Delete the archive plus `-wal`/`-shm` sidecars and start over |
| `--misses=<file>` | `<output>.misses.txt` | Where the miss list is written |
| `--from-misses=<file>` | — | Crawl **only** the listed tiles; ignores `--bbox`/`--zoom-levels` |

### Inspection

| flag | meaning |
|---|---|
| `--dry-run` | Print the plan and exit, touching nothing |
| `--verbose` | Log each failed tile as it happens |
| `--selftest` | 72 offline assertions (tile math, TMS flip, PNG decode); no network |
| `--blank-check=<file>` | Explain the blank verdict for one saved PNG |
| `-h`, `--help` | Usage |

### Exit codes

| code | meaning |
|---|---|
| `0` | Archive written. 404s and dropped blanks are normal, not errors |
| `1` | Fatal (I/O, database, unexpected exception) |
| `2` | Bad arguments, empty plan, or refusing to overwrite |
| `3` | Archive written but some tiles still failed after all passes (`http`/`net`) |

Exit `3` is what a scheduled job should alert on. Exit `0` with a non-empty miss
list means "coverage ends here", not "something broke".

---

## 4. Always plan first

`--dry-run` prints the exact per-zoom counts and exits without creating,
truncating or opening anything:

```sh
node fetch-tiles.mjs \
  --tiles-url="http://localhost:8080/data/io-lulc/{z}/{x}/{y}.png" \
  --bbox=0,30,30,60 --zoom-levels=3-14 \
  --output=io-lulc.mbtiles --dry-run
```

```
source  : <not consulted: raw bbox> (--debug-bbox intersects with source bounds)
bbox    : 0,30,30,60
zooms   : 3-14

  z3  x     4-    4 (    1)  y     2-    3 (    2)  =         2 tiles
  ...
  z14 x  8192- 9557 ( 1366)  y  4757- 6759 ( 2003)  =   2736098 tiles
TOTAL 3,649,272 tiles
estimate: none yet - first run for this bbox; the crawl reports a live rate
```

No ETA is invented before the first tile; the live crawl reports the real rate.
Add `--debug-bbox` to see what the same request costs once clamped to the
source's footprint.

---

## 5. Examples

### 5.1 A small area — the normal case

```sh
node fetch-tiles.mjs \
  --tiles-url="http://localhost:8080/data/io-lulc/{z}/{x}/{y}.png" \
  --bbox=11.2,47.9,11.9,48.4 --zoom-levels=9-11 \
  --output=munich.mbtiles
```

```
TOTAL 38 tiles

pass 1/2: 38 tiles queued
  pass 1/2  38/38 20.4 t/s  stored=38 blank=0 404=0 http=0 net=0  eta=0s
pass 1: no misses, stopping early

archive : munich.mbtiles
passes  : 1/2 (1.9s)
tiles   : 38 stored / 38 planned
payload : 0.95 MB
file    : 1.00 MB
by zoom : z9=4  z10=9  z11=25
unresolved: none
```

### 5.2 Trimmed to the source's real footprint

```sh
# 3,649,272 tiles raw, or 1,592 clamped to the advertised bounds
node fetch-tiles.mjs --tiles-url=".../{z}/{x}/{y}.png" \
  --bbox=0,30,30,60 --zoom-levels=3-14 \
  --output=io-lulc.mbtiles --debug-bbox
```

### 5.3 Cold remote source — raise the timeout

Rendering a tile from a remote COG can take seconds; the default 30 s is too
tight for z3–z6, where one tile fans out over many source files.

```sh
node fetch-tiles.mjs --tiles-url=".../{z}/{x}/{y}.png" \
  --bbox=11.2,47.9,11.9,48.4 --zoom-levels=3-14 \
  --output=io-lulc.mbtiles --debug-bbox \
  --timeout=120000 --concurrency=16
```

Match `--concurrency` to the server's render pool. Beyond it, requests only
queue — and never measure throughput on a re-run: an in-process tile cache makes
the second crawl ~30× faster without touching the source.

### 5.4 Resume an interrupted crawl

```sh
# crashed, killed, or out of patience — just run it again
node fetch-tiles.mjs --tiles-url=".../{z}/{x}/{y}.png" \
  --bbox=11.2,47.9,11.9,48.4 --zoom-levels=9-11 \
  --output=munich.mbtiles
```

```
resuming: 20 tiles already stored
```

Already-stored tiles are read back and skipped. `--no-resume` aborts instead of
continuing; `--force` wipes the archive and sidecars and starts clean.

### 5.5 A manual extra pass against the miss list

```sh
# 1) a first pass that leaves misses behind
node fetch-tiles.mjs --tiles-url=".../{z}/{x}/{y}.png" \
  --bbox=11.2,47.9,11.9,48.4 --zoom-levels=9 --output=m.mbtiles --passes=1
# exit 3; m.mbtiles.misses.txt holds the failures

# 2) retry exactly those, whenever you like
node fetch-tiles.mjs --tiles-url=".../{z}/{x}/{y}.png" \
  --output=m.mbtiles --from-misses=m.mbtiles.misses.txt
```

The list is plain text — greppable, editable, committable:

```
# unresolved misses after 1 pass(es) from http://127.0.0.1:8126/flaky/{z}/{x}/{y}.png
# z/x/y category
9/271/177 http
9/271/178 http
```

Delete lines you no longer care about, or feed subsets elsewhere. When a run
ends with no misses, a stale list from an earlier run is removed rather than
left to mislead.

### 5.6 Re-tile from a different source

```sh
node fetch-tiles.mjs \
  --tiles-url="https://tiles.example.com/ortho/{z}/{x}/{y}.webp" \
  --bbox=14.2,49.9,14.6,50.2 --zoom-levels=12-16 \
  --output=ortho.mbtiles --format=webp
```

`format` is inferred from the URL suffix (`png`, `jpg`, `webp`, `avif`);
override with `--format` when the URL lies. A wrong value makes readers reject
the archive.

---

## 6. Verifying the result

Never trust file size alone. Use the server's own CLI:

```sh
tileserver-rs inspect -v out.mbtiles      # human readable, counts per zoom
tileserver-rs inspect --json out.mbtiles  # machine readable
tileserver-rs inspect --tile 11/1087/710 out.mbtiles   # decode one tile
```

Compare the per-zoom counts against the `--dry-run` plan. Any gap is the
404/no-coverage count, which is expected — not a failure.

For an exact end-to-end check, `--tiles-url` and `--from-misses` together let you
re-fetch a known set and diff the result.

---

## 7. Troubleshooting

**`--dry-run` reports millions of tiles.** Your bbox is far larger than the
source's footprint. Add `--debug-bbox` to see the clamped number, or narrow the
box / drop the low zooms.

**Everything returns 404 at low zoom.** You are below the source's `minzoom`;
`--debug-bbox` clamps automatically. A fast 404 (~0.5 ms, no upstream call)
across a whole level is this, not a bug — do not "retry" it.

**`error: unknown option: --no-clip`.** Clipping is opt-in now:
`--clip`/`--no-clip` were replaced by `--debug-bbox`.

**A tile you expected is missing.** Check the miss list, then
`--blank-check=<saved.png>` to see whether it was dropped as transparent. If the
verdict surprises you, that's a bug worth reporting — the detector is meant to be
conservative.

**The archive opens upside down.** It shouldn't: the TMS flip is applied in one
place and pinned by `--selftest`. If it happens, run `--selftest` first to rule
out a modified copy.

**Throughput looks amazing on the second run.** That's the server's tile cache,
not your concurrency setting. Benchmark cold.

---

## 8. Limits

- **PNG is decoded; nothing else is inspected.** JPEG/WebP blanks are stored as
  real tiles — `--skip-empty` only understands PNG.
- **Interlaced PNGs are never treated as blank** (no Adam7 de-interlacing).
- **No reprojection.** One bbox, EPSG:4326, XYZ scheme in.
- **No tile merging, dedupe or re-encoding.** Payloads are stored byte-for-byte.
- **Single process.** Concurrency is in-process; there is no distributed crawl.
- **`--from-misses` derives its bounds from the tiles themselves** unless
  `--bbox` is given, so a subset pass writes subset bounds into the metadata.

---

## 9. Self-test

```sh
node fetch-tiles.mjs --selftest     # 72 assertions, no network, ~80 ms incl. node startup
```

Covers tile-range math at 12 zooms, north/south and boundary semantics, clamping,
zoom/bbox parsing, the TMS flip, and PNG decoding across colour types, bit
depths, palette+tRNS, all five scanline filters, and malformed input. Run it
after changing anything in the math or the decoder.

---

## 10. Design summary

| decision | reason |
|---|---|
| Raw bbox by default | Never silently alter what was asked for; `--debug-bbox` is explicit |
| `--dry-run` first-class | Cost grows ~4× per zoom; 3.6M tiles is a batch job |
| Passes, not per-tile retries | Immediate retries hit the same broken state; a later pass does not |
| 404 not retried | Deterministic negative, not a transient failure |
| Miss list as a file | Coverage stays explainable and re-runnable by hand |
| Alpha-based blank detection | Brightness and byte-size both misclassify real sparse tiles |
| WAL during, `DELETE` after | Crash-safe crawling, single-file delivery |
| Verification via `inspect` | File size proves nothing about counts, zooms or orientation |
