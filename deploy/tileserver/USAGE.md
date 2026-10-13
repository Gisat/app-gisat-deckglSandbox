# Tileserver-RS demo container — usage

This directory defines the **local-development tileserver-rs instance** backing
the `Tileserver-RS` demo category of the sandbox app. It mirrors the role
`deploy/titiler` plays for the TiTiler demos, but the motivation here is to
demonstrate **STAC discovery, mosaicing, and in-process caching**.

## What it is

- **Image:** built locally from `../../tileserver-rs` (branch
  `feat/identity-raster-cache`) — a single-binary Rust tile server (axum +
  GDAL). The branch adds identity raster-tile caching to the global `[cache]`,
  which upstream `main` does not have (there, only Accept-Encoding re-encode
  variants are cached). The `stac` feature (implies `raster`/GDAL) is enabled
  in the build args.
- **Two sources** (see `config.toml`):
  - `worldcereal` — the **same COG** as the TiTiler WorldCereal demo
    (`WorldCereal_GST-10/project/demo/merged_cog.tif`), served with a
    server-side **discrete colormap** identical to
    `deploy/titiler/colormaps/worldcereal_active.json` (0 = gray, 100 = green,
    254/255 = transparent). A plain `cog` source because the public WorldCereal
    STAC API is **dead** (`stac.worldcereal.org` NXDOMAIN, checked 2026-10-13;
    `hub.esa-worldcereal.org` is a web SPA, not STAC).
  - `sentinel2-mosaic` — a **true STAC source**: Earth Search Sentinel-2 L2A
    (`sentinel-2-l2a`, `visual` asset), `dynamic = true` + `max_items = 5` →
    every tile triggers a STAC `POST /search` with the tile's WGS-84 bbox and
    up to 5 intersecting items are rendered concurrently and **composited**
    (mosaic; `pixel_selection = "first"`).
- **Caching:** `[cache]` enabled (512 MB, TTL 3600 s). With the local build
  the rendered PNG of every canonical tile request is cached in-process —
  repeat requests (same source/z/x/y) are served from memory. The TTL trades
  freshness vs cost: dynamic STAC tiles freeze for the TTL window.
- **Data:** both sources are remote (COG via GDAL `/vsicurl/`, Sentinel-2 via
  Earth Search) — no local data download is needed.

The sandbox web app talks to this container over HTTP on port `8080` through
the Vite dev-server proxy `/tileserver` → `http://localhost:8080` (COEP-safe,
same-origin — same pattern as the TiTiler stacks).

## Quick start

```sh
# from the repository root
docker compose -f deploy/tileserver/docker-compose.yml up -d --build
```

The first build takes a while (Rust release build). Verify it is up:

```sh
curl http://localhost:8080/health
```

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
curl -s http://localhost:8080/data/worldcereal.json | jq .
curl -s http://localhost:8080/data/sentinel2-mosaic.json | jq .
```

### 3. A WorldCereal tile (in-bounds: lon 26.5, lat 5.9 → z4 9/7)

```sh
curl -s -o /tmp/wc.png -w "%{http_code} %{content_type} %{size_download}B %{time_total}s\n" \
  "http://localhost:8080/data/worldcereal/4/9/7.png"
file /tmp/wc.png   # -> PNG image data
```

### 4. A Sentinel-2 mosaic tile (in-bounds: lon 26.75, lat 5.0 → z8 147/124)

```sh
# Cold: STAC search + up to 5 concurrent COG renders + composite + PNG encode.
# Repeat (within cache TTL): served from the in-process [cache] — watch
# %{time_total} drop and RUST_LOG show "cache" activity.
curl -s -o /tmp/s2.png -w "%{http_code} %{content_type} %{size_download}B %{time_total}s\n" \
  "http://localhost:8080/data/sentinel2-mosaic/8/147/124.png"
file /tmp/s2.png   # -> PNG image data (true-color visual imagery)
```

### 5. Demonstrate the cache (timing)

```sh
TILE="http://localhost:8080/data/sentinel2-mosaic/8/147/124.png"
for i in 1 2 3; do curl -s -o /dev/null -w "req $i: %{time_total}s\n" "$TILE"; done
# req 1: seconds (STAC search + remote COG reads + warp + PNG)
# req 2/3: milliseconds (in-process cache hit)
```

### 6. Built-in web UI

<http://localhost:8080/> — MapLibre viewer with the source dashboard.

## Configuration map

| Piece | Where |
| --- | --- |
| WorldCereal COG source + discrete colormap | `config.toml` → `[[sources]]` `worldcereal` |
| Sentinel-2 STAC dynamic mosaic source | `config.toml` → `[[sources]]` `sentinel2-mosaic` |
| Global raster defaults (resampling, tile size) | `config.toml` → `[raster]` |
| In-process tile cache | `config.toml` → `[cache]` |
| GDAL `/vsicurl/` tuning env | `docker-compose.yml` → `environment` |

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

The compose `build.context` is `../../../tileserver-rs` (sibling repo, resolved from this compose file's directory; the checkout must be on the `feat/identity-raster-cache` branch). Notes:

- The repo has **uninitialized submodules** (`crates/mbgl-sys/vendor/maplibre-native`,
  `.claude/skills/rust-skills`). The Dockerfile downloads pre-built MapLibre
  Native static libs from GitHub releases and does **not** need the vendored
  submodule — but `docker build` copies `crates/mbgl-sys` including the (empty)
  vendor dir, which is fine. If the build complains about a missing submodule
  path, initialize it once:
  `git -C ../../../tileserver-rs submodule update --init crates/mbgl-sys/vendor/maplibre-native`
- Build args: `FEATURES: "frontend stac"` (stac implies raster/GDAL).
- The first build compiles ~700 crates; subsequent builds reuse the layer
  cache as long as `Cargo.lock` does not change.

## Performance notes

- **WorldCereal (remote COG):** cold tiles are network-bound (GDAL range
  requests to eu-central-1 Linode); warm tiles come from the GDAL block cache
  + the in-process tile cache. GDAL tuning is in the compose env.
- **Sentinel-2 mosaic (dynamic STAC):** each cold tile = 1 STAC `/search`
  (Earth Search, ~100-300 ms) + concurrent COG range-reads of up to 5 assets.
  `pixel_selection = "first"` short-circuits once the canvas is opaque. The
  in-process cache makes repeat requests milliseconds.
- **TTL:** `[cache] ttl_seconds = 3600` freezes dynamic STAC tiles for an
  hour; lower it (or restart the container) for fresher imagery.

## Notes & troubleshooting

- **Ports:** container publishes `8080:8080`. Change the left side if `8080`
  is taken (and update the vite proxy target + `endpoints.js` accordingly).
- **CORS:** `cors_origins = ["*"]` in `config.toml`; the app proxy is
  same-origin anyway.
- **Out-of-bounds tiles** return 404 — normal (per-tile errors for tiles
  outside the source bounds/zoom are expected and stay silent in the app).
- **No persistence:** the container is stateless; the `[cache]` is RAM-only
  (restart clears it — by design for this demo).
- **Updating:** `git -C ../../tileserver-rs fetch origin && git -C
  ../../tileserver-rs pull --ff-only` (on `feat/identity-raster-cache` or
  `main`), then rebuild: `docker compose -f deploy/tileserver/docker-compose.yml up -d --build`.
