# USAGE — crawl tiles, compile PMTiles, serve them

A three-stage pipeline. Each stage is a separate command with its own failure
modes, and each stage's output is the next stage's input:

```
  XYZ tile endpoint          fetch-tiles.mjs              compile-pmtiles.sh            pmtiles serve
  (tileserver-rs, TiTiler,  ──────────────────▶  .mbtiles  ──────────────────▶  .pmtiles  ──────────────────▶  clients
   any {z}/{x}/{y} server)        (crawl)                     (compile)                       (range requests)
```

- **`.mbtiles`** — SQLite, the crawl format. Good for QGIS, Mapbox Studio, mobile SDKs.
- **`.pmtiles`** — one immutable file, served straight from static storage. Good for the web.

Neither format is "better"; see [`MBTiles-PMTilesComparison.md`](MBTiles-PMTilesComparison.md).
Flag-by-flag detail for the crawler lives in [`README.md`](README.md) — this file
is the walkthrough, that one is the reference.

**Prerequisites.** Node ≥ 22 for the crawler (`node:sqlite` is built in, zero npm
dependencies). `curl` + `tar` for the one-time `go-pmtiles` download. Nothing
else — no GDAL, no sqlite3 CLI, no Go toolchain.

---

## 0. Check the source is alive

Everything below assumes a tile server answering `{z}/{x}/{y}`. For the demo
stack in this repo:

```sh
cd <repo-root>
docker compose -f deploy/tileserver/docker-compose.yml up -d --build
curl -s http://localhost:8080/health
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
  http://localhost:8080/data/manila-rgb/10/855/469.png
```

If that last line is not `200 <some bytes>`, stop — every stage below will
happily produce an empty archive and report success. See
[Empty results](#empty-results-the-main-trap).

---

## 1. Fetch MBTiles

### 1.1 Always plan first

`--dry-run` prints exact per-zoom tile counts, creates nothing and requests
nothing:

```sh
cd deploy/fetch-tile-cache

node fetch-tiles.mjs \
  --tiles-url="http://localhost:8080/data/manila-rgb/{z}/{x}/{y}.png" \
  --bbox=120.90,14.50,121.10,14.70 \
  --zoom-levels=10-13 \
  --output=manila-test.mbtiles --dry-run
```

```
bbox    : 120.9,14.5,121.1,14.7
zooms   : 10-13

  z10 x   855-  856 (    2)  y   469-  470 (    2)  =         4 tiles
  z11 x  1711- 1712 (    2)  y   939-  940 (    2)  =         4 tiles
  z12 x  3423- 3425 (    3)  y  1878- 1881 (    4)  =        12 tiles
  z13 x  6847- 6851 (    5)  y  3757- 3762 (    6)  =        30 tiles
TOTAL 50 tiles
```

Read `TOTAL` before running. Cost grows ~4× per zoom: that 0.2° box is 50 tiles
at z10–13 and roughly 273,000 at z14 alone. A bbox that looks small on a map can
be a multi-hour crawl.

### 1.2 Crawl

```sh
node fetch-tiles.mjs \
  --tiles-url="http://localhost:8080/data/manila-rgb/{z}/{x}/{y}.png" \
  --bbox=120.90,14.50,121.10,14.70 \
  --zoom-levels=10-13 \
  --output=manila-test.mbtiles
```

Measured output:

```
pass 1/2  50/50 123.5 t/s  stored=50 blank=0 404=0 http=0 net=0  eta=0s
pass 1: no misses, stopping early

archive : manila-test.mbtiles
passes  : 1/2
tiles   : 50 stored / 50 planned
payload : 8.86 MB
file    : 8.93 MB
by zoom : z10=4  z11=4  z12=12  z13=30
unresolved: none
```

**Read `stored / planned`, not the exit code.** Exit `0` means "no unresolved
http/net errors" — it does not mean tiles were stored. See
[Empty results](#empty-results-the-main-trap).

Sizes are decimal (`÷ 1e6`); `payload` is tile bytes, `file` adds SQLite pages.

### 1.3 Useful variations

```sh
# clamp the crawl to the source's advertised footprint (static sources only!)
--debug-bbox

# continue an interrupted crawl
--resume                       # the default
--force                        # delete and start over

# network tuning
--concurrency=16               # default 8, max 32
--timeout=120000               # ms; raise for cold remote COGs

# retry only what a previous run missed
--from-misses=manila-test.mbtiles.misses.txt

# keep blank tiles (rarely what you want)
--no-skip-empty
```

⚠️ **`--debug-bbox` on a `dynamic = true` STAC source is wrong.** Such a source
advertises a *demo view* bbox, not its data footprint, so clamping silently
drops real coverage. `io-lulc` in this repo is one. On a static `cog` source
(`manila-rgb`) it is safe and cheap.

### 1.4 Inspect the archive before building on it

```sh
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
console.log(db.prepare("SELECT COUNT(*) n, MIN(zoom_level) lo, MAX(zoom_level) hi, SUM(LENGTH(tile_data)) bytes FROM tiles").get());
console.log(db.prepare("SELECT zoom_level z, COUNT(*) n FROM tiles GROUP BY z ORDER BY z").all());
console.log(db.prepare("SELECT name,value FROM metadata WHERE name IN (?,?,?)").all("format","minzoom","maxzoom"));
db.close();' manila-test.mbtiles
```

`format` is the field that decides the PMTiles tile-type byte later. If it is
missing, stage 2 refuses the archive.

---

## 2. Compile to PMTiles

### 2.1 Run it

```sh
./compile-pmtiles.sh manila-test.mbtiles
```

First run bootstraps the tool:

```
pmtiles not found — downloading go-pmtiles v1.31.2 (go-pmtiles_1.31.2_Linux_x86_64.tar.gz) ...
pmtiles 1.31.2, commit a3e4951..., built at 2026-07-22T18:59:03Z
```

Then, measured:

```
== manila-test.mbtiles -> manila-test.pmtiles
  50 tiles, format=png, z10-13
  round-trip ok: 13 tiles byte-identical to MBTiles
  ok  png  z10-13  50 tiles  50 entries / 50 contents  clustered  dir:gzip  tiles:none
      8.93 MB -> 8.86 MB
```

What each field means:

| field | meaning |
|---|---|
| `50 tiles` | addressed tiles in the archive (after RLE) |
| `50 entries / 50 contents` | 50 directory entries over 50 distinct blobs — **no dedup**. Normal for imagery; a land-cover raster with uniform regions should show fewer contents than entries |
| `clustered` | tile data ordered by TileID, which is what range-request clients want. Must say `clustered` |
| `dir:gzip` | directory + metadata compressed internally (always gzip here) |
| `tiles:none` | per-tile compression. PNG/JPEG are already compressed, so `none` is correct |
| `8.93 MB -> 8.86 MB` | decimal. Expect **~1% smaller**, not dramatically smaller — see [Size expectations](#size-expectations) |

### 2.2 Options

```sh
./compile-pmtiles.sh                        # every *.mbtiles beside the script
./compile-pmtiles.sh a.mbtiles b.mbtiles    # explicit files
./compile-pmtiles.sh --force                # rebuild even if .pmtiles is newer
./compile-pmtiles.sh --sample=0             # skip the round-trip check (fast, less safe)
PMTILES_BIN=/usr/local/bin/pmtiles ./compile-pmtiles.sh
PMTILES_VERSION=1.31.2 ./compile-pmtiles.sh
```

Binary resolution order: `$PMTILES_BIN` → `pmtiles` on `PATH` → `./bin/pmtiles`
→ pinned release download. `./bin/` and all archives are gitignored; the
downloaded binary is ~57 MB and stays put after the first run.

The script writes `<out>.pmtiles.tmp` and renames it only after the archive
passes, so an interrupted run never leaves a truncated file that looks servable.

### 2.3 Verify

```sh
./bin/pmtiles show manila-test.pmtiles
./bin/pmtiles verify manila-test.pmtiles
./bin/pmtiles show --tilejson --public-url=http://localhost:8090 manila-test.pmtiles
```

`show --tilejson` is the fastest way to see what a client will be told: bounds,
min/max zoom, scheme, and the tile URL template.

⚠️ **`verify` after a `header zoom repaired` line will fail, and it is wrong.**
`verify` derives the archive's max zoom the same broken way `convert` does, so it
reports the *repaired* header as invalid (`header MaxZoom=2 does not match max
tile z 0`). Trust the `round-trip ok:` line instead — it extracts real tiles and
compares them byte-for-byte with the MBTiles rows. Details in
[`README.md` §10](README.md#10-compiling-to-pmtiles).

### 2.4 Spot-check one tile by hand

The TMS flip is where archives silently go upside down, so compare bytes, not
filenames:

```sh
Z=13; X=6849; Y=3759
ROW=$(( (1 << Z) - 1 - Y ))          # XYZ y -> MBTiles TMS row

node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const r = db.prepare("SELECT tile_data d FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?")
            .get(+process.argv[2], +process.argv[3], +process.argv[4]);
if (!r) { console.error("no such row"); process.exit(2); }
require("fs").writeFileSync("/tmp/a.png", r.d); db.close();' manila-test.mbtiles $Z $X $ROW

./bin/pmtiles tile manila-test.pmtiles $Z $X $Y > /tmp/b.png
cmp -s /tmp/a.png /tmp/b.png && echo MATCH || echo MISMATCH
```

---

## 3. Serve

### 3.1 Local

`pmtiles serve` takes a **directory** of archives, not a file:

```sh
./bin/pmtiles serve . --port=8090 --interface=127.0.0.1
```

URL shape is `/<archive-basename>/<z>/<x>/<y>.png`:

```sh
curl -o /tmp/t.png -w "%{http_code} %{size_download}\n" \
  http://127.0.0.1:8090/manila-test/13/6849/3759.png
```

Passing a file instead of a directory gives `404 ... not a directory` in the
log — that is the tell, not a missing tile.

Useful flags: `--cache-size=64` (MB, default 64), `--cors=*` (browser clients
from another origin), `--public-url=` (correct TileJSON URLs).

### 3.2 Production / no server at all

The point of PMTiles is that you do not need this section: put the `.pmtiles`
file on S3 / R2 / nginx / GitHub Pages and point a PMTiles-capable client at it
over HTTP range requests. Set `Cache-Control: public, max-age=...` and an `ETag`
at the origin — the archive is immutable, so a new build means a new filename.

```sh
aws s3 cp manila-test.pmtiles s3://<bucket>/tiles/ \
  --content-type application/octet-stream
```

Also supported by `tileserver-rs` (`deploy/tileserver/`) if you want one server
fronting both live COGs and static archives.

### 3.3 Prove the served bytes match the source

```sh
curl -s http://localhost:8080/data/manila-rgb/13/6849/3759.png | md5sum
curl -s http://127.0.0.1:8090/manila-test/13/6849/3759.png | md5sum
```

Identical hashes mean the whole chain is intact: crawl → MBTiles → PMTiles →
HTTP. Verified across four zoom levels on a real 50-tile crawl.

---

## Empty results: the main trap

`fetch-tiles.mjs` exits **0** on a crawl that stored nothing. The exit code
reflects *unresolved errors*, not stored tiles, so it cannot distinguish these
three outcomes:

| summary line | what happened | what to do |
|---|---|---|
| `stored=50 blank=0 404=0` | all good | proceed |
| `stored=0 404=50` | bbox is outside the source's coverage | fix the bbox; `--debug-bbox` shows where the data really is |
| `stored=0 blank=50` | server answered `200` with a fully transparent tile | same — the bbox is outside the data |

The third row is the counter-intuitive one. A tile server may answer
out-of-bounds requests with a **valid, fully transparent PNG** instead of a 404
(tileserver-rs does exactly this). So a bbox *near but just outside* a source
yields 200s, not 404s, and the crawler correctly drops them via the PNG alpha
check. Blank tiles are never written to the miss list, so an absent
`*.misses.txt` is **not** evidence that the crawl found anything.

`compile-pmtiles.sh` catches this before burning a convert: 0 tiles exits with
code `3` and names both causes. It cannot tell you which one happened — only the
crawler's summary counters can, so **save them**. Don't rely on exit codes alone
in a script; assert the `stored=` count.

---

## Size expectations

Converting MBTiles to PMTiles does **not** meaningfully shrink raster archives.
Measured on a real 50-tile PNG crawl (Manila RGB, z10–13):

| | bytes | decimal |
|---|---|---|
| MBTiles file | 8,933,376 | 8.93 MB |
| raw tile payload | 8,861,045 | 8.86 MB |
| PMTiles file | 8,861,576 | 8.86 MB |

- PMTiles is **71,800 B (0.80%) smaller** than the MBTiles file — exactly the
  SQLite page and row overhead being removed
- PMTiles is **531 B larger** than the raw tile payload — that is the fixed 127-byte
  header plus the compressed root directory and the JSON metadata

So the archive is payload + ~0.5 KB of index. Nothing is recompressed or saved
per tile by default.

PNG/JPEG tiles are already DEFLATE-compressed, so a second gzip pass gains
~1.5% on realistic imagery and *adds* bytes on tiny flat tiles (measured:
256×256 imagery 11,712 B → 9,667 B; 1×1 PNG 70 B → 83 B). Real size wins come
from two places:

1. **Dedup** — identical tiles stored once. Big for class rasters with uniform
   regions, irrelevant for unique imagery.
2. **gzip of uncompressed MVT** — vector tiles are not pre-compressed, so this
   is a genuine win.

Choose PMTiles for *serving* (range requests, no backend), not for shrinking
files.

---

## Exit codes at a glance

`fetch-tiles.mjs`:

| code | meaning |
|---|---|
| 0 | no unresolved http/net errors — **tiles may still be 0**, check `stored=` |
| 1 | fatal (I/O, DB, unhandled) |
| 2 | bad arguments |
| 3 | archive written, but some tiles failed after all passes |

`compile-pmtiles.sh`:

| code | meaning |
|---|---|
| 0 | every requested archive converted and round-trip checked |
| 1 | convert / verify / round-trip failed, or an input was missing |
| 2 | setup or usage: no pmtiles binary, no inputs, bad option |
| 3 | at least one input was an empty crawl (0 tiles stored) |
| 4 | at least one input lacked `metadata.format` (would become tile type `0x00`) |
| 5 | at least one input was not a readable MBTiles archive |

With several inputs the highest-seen kind wins: `5 > 4 > 3 > 1 > 0`.

---

## Troubleshooting

**`404 ... not a directory` in the serve log** — you passed an archive file to
`pmtiles serve`. Pass the directory.

**Archive is tiny and `show` reports the wrong zoom** — that is the go-pmtiles
maxzoom bug. `compile-pmtiles.sh` repairs it and prints `header zoom repaired`.
Do not hand-edit; re-run the script.

**`verify` fails with a maxzoom mismatch** — expected after a repair, and a
false positive. See [2.3](#23-verify).

**Crawl is slow at low zooms** — expected. Low zooms fan out over many source
COGs (measured ~8.6 s/tile at z3 vs ~0.2 s at z12). The crawler goes ascending
so this surfaces early rather than at the end.

**`no tiles in MBTiles archive`** — you are running `convert` directly on an
empty crawl. Use `compile-pmtiles.sh`, which refuses earlier with a clearer
message.

**Port 8090 already in use** — `--port=<n>`, or stop the other `pmtiles serve`.

---

## Where to go deeper

| file | covers |
|---|---|
| [`README.md`](README.md) | full `fetch-tiles.mjs` reference: every flag, tile math, passes, blank detection, design rationale |
| [`MBTiles-PMTilesComparison.md`](MBTiles-PMTilesComparison.md) | when to pick which format |
| [`CachingAndServingMapTilePyramids.md`](CachingAndServingMapTilePyramids.md) | why a PMTiles archive usually makes a tile cache redundant |
| `node fetch-tiles.mjs --selftest` | 72 offline assertions on the geometry and PNG decoder |
