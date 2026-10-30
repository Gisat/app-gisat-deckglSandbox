# Tileserver-RS demo container — usage

This directory defines the **local-development tileserver-rs instance** backing
the `Tileserver-RS` demo category of the sandbox app. It mirrors the role
`deploy/titiler` plays for the TiTiler demos; the motivation here is to
demonstrate **server-side COG rendering and in-process caching** with a plain,
proven raster source.

## What it is

- **Image:** built locally from `../../../tileserver-rs` (branch
  `feat/identity-raster-cache`) — a single-binary Rust tile server (axum +
  GDAL). The branch adds identity raster-tile caching to the global `[cache]`,
  which upstream `main` does not have (there, only Accept-Encoding re-encode
  variants are cached). The `stac` feature (implies `raster`/GDAL) stays
  enabled in the build args.
- **Two sources** (see `config.toml`):
  - `manila-rgb` — the **same true-color RGB COG** as the TiTiler "Manila
    RGB" demo (`Manila_S2_Composite_2020022_Mercator_RGB_COG_DEFLATE.tif`,
    uint8 3-band, EPSG:3857, ~500 MB, DEFLATE). True RGB → no colormap; the
    Source renders the three bands straight to a PNG tile. This is the
    simplest possible tileserver-rs COG demo.
  - `eugw-lcmh` — the **true STAC + mosaic demo** (added 2026-10-27).
    `EUGW_LCMH` on the openEO/VITO STAC API (`https://stac.openeo.vito.be`)
    is a **spatial tile grid**: each item is one 1500×1500 COG (EPSG:3035,
    1-band uint8 land-cover classes), ~146k items over Europe. `dynamic = true`
    runs a per-tile bbox `POST /search`, renders the returned items
    concurrently and composites them into a seamless class raster. Rendered
    with the GHLC class colormap (`[sources.colormap]`, discrete,
    `rescale_mode = "none"`, nodata 255 → transparent).

  > **Why this STAC demo works where the retired one did not.** The previous
  > `sentinel2-mosaic` source (Earth Search Sentinel-2 L2A, `dynamic = true` +
  > `max_items = 5` + `pixel_selection = "first"`) served mostly-black tiles
  > at low zoom: it was a **temporal** collection, the top-5 newest scenes
  > for its region are 89–99 % cloud, and `first` composites by STAC order,
  > not cloud cover. `EUGW_LCMH` is a **spatial** grid — every item shares one
  > datetime and carries no `eo:cloud_cover`, so `first` simply means "the
  > first adjacent tile", which is exactly what a mosaic wants. A
  > `worldcereal` COG entry had also been removed earlier — it failed at
  > startup registration (GDAL `GDALOpenEx` returned NULL, "Failure writing
  > output to destination") and the public WorldCereal STAC API is dead.

  > **Verified against the asset bytes 2026-10-27:** real COG (128×128 tiles,
  > full overview pyramid 1500→750→375→188→94, IFD before data,
  > `accept-ranges: bytes`, 206 on Range); 1-band uint8, `GDAL_NODATA=255`;
  > asset role is `data` (NOT Earth Search's `visual`). Colormap values
  > cross-checked against decoded pixels of a real item (values 1–7, 9, 255
  > present, matching the GHLC value scheme).
- **Caching:** `[cache]` enabled (512 MB, TTL 3600 s). With the local build
  the rendered PNG of every canonical tile request is cached in-process —
  repeat requests (same source/z/x/y) are served from memory.
- **Data:** the source is a **remote** COG (Gisat object storage, HTTP range
  reads via GDAL `/vsicurl/`) — no local data download is needed. Cold tiles
  are slower than local files (range reads across the network); the in-process
  cache makes repeats milliseconds.

The sandbox web app talks to this container over HTTP on port `8080` through
the Vite dev-server proxy `/tileserver-api` → `http://localhost:8080`
(COEP-safe, same-origin — same pattern as the TiTiler stacks).

## Quick start

The container runs the **prebuilt native binary** — no compilation in Docker.
The build context is [`./tileserver-runtime/`](tileserver-runtime/), which ships
the binary and the runtime libs, so the build needs **no network**. Refresh the
binary after a rebuild, then start:

```sh
# from the repository root
cp tileserver-rs/target/release/tileserver-rs \
   deploy/tileserver/tileserver-runtime/tileserver-rs
docker compose -f deploy/tileserver/docker-compose.yml up -d --build

curl http://localhost:8080/health
```

The image (`tileserver-rs-demo:local`) is `debian:12-slim` carrying the GDAL
shared-library chain — seconds to build. See
[Building the image](#building-the-image) for the online/offline split.

Stop / restart / logs / teardown:

```sh
docker compose -f deploy/tileserver/docker-compose.yml stop     # stop (keep container)
docker compose -f deploy/tileserver/docker-compose.yml start    # start again
docker compose -f deploy/tileserver/docker-compose.yml restart  # restart
docker compose -f deploy/tileserver/docker-compose.yml logs -f  # follow logs
docker compose -f deploy/tileserver/docker-compose.yml down     # stop + remove container
```

## Using it from the CLI

### 1. Health check

```sh
curl http://localhost:8080/health
```

### 2. TileJSON (bounds/zoom derived from the source)

```sh
curl -s http://localhost:8080/data/manila-rgb.json | jq .
```

### 3. An in-bounds Manila tile (center lon 120.94, lat 13.86 → z8 214/118)

```sh
# Cold: GDAL /vsicurl/ range reads of the remote COG + warp + PNG encode.
# Repeat (within cache TTL): served from the in-process [cache] — watch
# %{time_total} drop.
curl -s -o /tmp/manila.png -w "%{http_code} %{content_type} %{size_download}B %{time_total}s\n" \
  "http://localhost:8080/data/manila-rgb/8/214/118.png"
file /tmp/manila.png   # -> PNG image data (true-color RGB imagery)
```

### 4. Demonstrate the cache (timing)

```sh
# Use a tile section 3 did NOT fetch, so req 1 is genuinely cold (remote COG
# reads + warp + PNG encode). Timing the section-3 tile instead makes req 1 a
# warm cache hit (sub-ms noise) — the classic confound. Pick an in-bounds
# neighbor (z8/214/118 = center of the Manila view).
TILE="http://localhost:8080/data/manila-rgb/8/214/118.png"
for i in 1 2 3; do curl -s -o /dev/null -w "req $i: %{time_total}s\n" "$TILE"; done
# req 1: hundreds of ms to seconds (cold render over HTTP range reads)
# req 2/3: sub-ms (in-process cache hit)
```

### 5. Built-in web UI

<http://localhost:8080/> — MapLibre viewer with the source dashboard.

## Configuration map

| Piece | Where |
| --- | --- |
| Manila RGB COG source | `config.toml` → `[[sources]]` `manila-rgb` |
| EUGW LCMH STAC mosaic source + colormap | `config.toml` → `[[sources]]` `eugw-lcmh` + `[sources.colormap]` |
| Global raster defaults (resampling, tile size) | `config.toml` → `[raster]` |
| In-process tile cache | `config.toml` → `[cache]` |
| Renderer pool (burst/load tuning) | `config.toml` → `[render]` |
| GDAL `/vsicurl/` tuning env (container) | `tileserver-runtime/Dockerfile` → `ENV` |
| GDAL `/vsicurl/` tuning env (no Docker) | `tileserver-rs/run-native.sh` → exports |

The GDAL tuning values are **identical across every surface** (64 MB
`CPL_VSIL_CURL_CACHE_SIZE`, `VSI_CACHE=FALSE`, `GDAL_CACHEMAX=200`, HTTP/2
multiplexing, `GTIFF_SRS_SOURCE=EPSG`). See
[`knowhow/Manila-RGBA-COG-Development-Summary.md`](knowhow/Manila-RGBA-COG-Development-Summary.md)
for why each is set that way.

## Running without Docker (`run-native.sh`)

On a host without Docker (as here), start the **same prebuilt binary** bare-metal:

```sh
cd tileserver-rs
./run-native.sh                # foreground (Ctrl-C stops)
./run-native.sh --daemon       # background, logs to ./run-native.log
./run-native.sh --stop         # stop the daemon
```

The script lives in the **tileserver-rs** repo (next to `build-native.sh`) and
locates this directory's `config.toml` automatically; override with
`CONFIG=/path/to/config.toml`. It bakes in the same GDAL `/vsicurl/` env as the
container, so tile output and timing match the binary-variant container.

## Why the local build (not `ghcr.io/...:latest`)

Upstream tileserver-rs `main` (v2.38.0) does not consult the global `[cache]`
for canonical raster tile requests — `get_raster_tile_with_params` called the
COG/generic paths directly, bypassing the cache (only Accept-Encoding
re-encoded variants were cached). The local `feat/identity-raster-cache`
branch fixes this:

- COG branch: canonical requests (no `?resampling=`, 256 px tile) consult and
  populate `[cache]` with the same key shape/metrics as vector sources.
- Generic tail (STAC, vector-under-raster-feature): routes through the
  manager's cached `get_tile()`.

If you want to run the published image instead (accepting no raster caching):

```yaml
services:
  tileserver:
    image: ghcr.io/vinayakkulkarni/tileserver-rs:latest   # no [cache] for PNG tiles
    # (delete the build: block)
```

## Building the image

No compilation happens in Docker. The build context is
[`./tileserver-runtime/`](tileserver-runtime/) — **self-contained**, mirroring
`deploy/titiler-caching/<encoder>/`: it holds the Dockerfile plus the generated
build inputs (binary, runtime libs, GDAL/PROJ data). Nothing outside the app
repo is read.

**The generated inputs are NOT committed** (`.gitignore`d — ~219 MB of vendored
`.so`/`.db` files that age badly). Regenerate them on a Debian 12 host that has
GDAL — the same host that built the binary:

```sh
cd tileserver-rs && ./build-native.sh && cd -
./deploy/tileserver/collect-runtime-libs.sh
```

The script collects, from `ldd` of the binary and `/usr/share`:

| Into | From | Why |
|---|---|---|
| `runtime-libs/` | `ldd` (112 `.so`) | the shared libs the binary links |
| `gdal-data/gdal/` | `/usr/share/gdal` | GDAL data — pkg `gdal-data`, **not** a dep of `libgdal32` |
| `gdal-data/proj/` | `/usr/share/proj` | `proj.db` CRS database — pkg `proj-data`, **not** a dep of `libproj25` |
| `tileserver-rs` | the built binary | what the image runs |

**Offline vs online:** the default path installs nothing from the network — the
libs and data are `COPY`d from the context. To build online instead (smaller
context), uncomment the `apt-get` block in `tileserver-runtime/Dockerfile`,
delete `runtime-libs/` + `gdal-data/`, and add `gdal-data proj-data` to the
install list.

The image is `debian:12-slim` + those files, so the container runs the **exact
binary** `run-native.sh` runs. Note the runtime is deliberately **not** the
upstream Dockerfile's `ubuntu:24.04` (glibc 2.39 / `libgdal34t64`): the binary is
built against Debian 12's glibc 2.36 / `libgdal32`, so the SONAMEs would not
resolve there. Notes:

## Performance notes

- **Manila COG (remote):** each cold tile = GDAL `/vsicurl/` range reads of
  the ~500 MB COG (overviews used at low zoom) + warp to WebMercator + PNG
  encode. The first request for a region pays the network cost; the
  in-process cache makes repeat requests milliseconds.
- **TTL:** `[cache] ttl_seconds = 3600` freezes rendered tiles for an hour;
  lower it (or restart the container) for fresher output.

## Notes & troubleshooting

- **Ports:** container publishes `8080:8080`. Change the left side if `8080`
  is taken (and update the vite proxy target + `endpoints.js` accordingly).
- **CORS:** `cors_origins = ["*"]` in `config.toml`; the app proxy is
  same-origin anyway.
- **Out-of-bounds tiles** return 404 — normal (per-tile errors for tiles
  outside the source bounds are expected and stay silent in the app).
- **maxzoom:** COG sources report metadata `maxzoom: 22` (tileserver-rs
  ignores `config.toml maxzoom` for TileJSON); the deck.gl demo layer caps its
  own `maxZoom` (15, near the COG's native ~z14-15 resolution). Use
  `src/maps/TileserverRS/ManilaRGB.jsx` for the client-side cap; `verify.sh`
  only checks in-bounds tiles at sane zooms.
- **No persistence:** the container is stateless; the `[cache]` is RAM-only
  (restart clears it — by design for this demo).
- **Updating:** `git -C ../../../tileserver-rs fetch origin && git -C
  ../../../tileserver-rs pull --ff-only` (on `feat/identity-raster-cache` or
  `main`), then rebuild: `docker compose -f deploy/tileserver/docker-compose.yml up -d --build`
  (or, for the binary variant, re-run `tileserver-rs/build-native.sh` first).
