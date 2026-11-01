# Tileserver-RS demo container — usage

This directory defines the **local-development tileserver-rs instance** backing
the `Tileserver-RS` demo category of the sandbox app. It mirrors the role
`deploy/titiler` plays for the TiTiler demos; the motivation here is to
demonstrate **server-side COG rendering and in-process caching** with a plain,
proven raster source.

## What it is

- **Image:** built locally from `../../../tileserver-rs` — a single-binary Rust
  tile server (axum + GDAL). The `stac` feature (implies `raster`/GDAL) stays
  enabled in the build args.
- **Two sources** (see `config.toml`): `manila-rgb`, a true-color RGB COG, and
  `eugw-lcmh`, a STAC dynamic mosaic. See [`DEMOS.md`](DEMOS.md) for what each
  source is, why it was chosen, and the asset verification notes.
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
The runtime (binary + shared libs + GDAL/PROJ data + CA bundle) is downloaded at
**build time** from a versioned GitHub release on the fork, then verified by
sha256 before extraction:

```
https://github.com/twosix-code/tileserver-rs/releases/download/gisat-v2.39.0/tileserver-gisat.tar.gz
```

So from the repository root it is just:

```sh
docker compose -f deploy/tileserver/docker-compose.yml up -d --build

curl http://localhost:8080/health
```

The image (`tileserver-rs-demo:local`) is `debian:12-slim` carrying the GDAL
shared-library chain. The build needs **network** (to fetch the release asset).
To pin a different release, pass `--build-arg TILESERVER_RELEASE_TAG=<tag>`
(and `TILESERVER_ASSET_SHA256=<sha256>`). See
[Building the image](#building-the-image) for details.

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
re-encoded variants were cached). The local integration branch
(`integration/demo-fixes`) fixes this:

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

No compilation happens in Docker. The image is `debian:12-slim` plus the
runtime fetched from the fork's GitHub release — the container runs the **exact
binary** published for the pinned tag.

**Build-time flow** (`tileserver-runtime/Dockerfile`):

1. `apt-get install curl ca-certificates` (transient — only to download the
   asset; removed with the apt lists).
2. `curl` the release asset for `TILESERVER_RELEASE_TAG`, then
   **verify its sha256** against `TILESERVER_ASSET_SHA256` (a bad/truncated
   download fails the build loudly).
3. Extract and install `runtime-libs/`, `gdal-data/`, `ca-certs/`,
   `nsswitch.conf`, and the binary; `ldconfig`.

The build context is [`./tileserver-runtime/`](tileserver-runtime/) — it holds
only the `Dockerfile` and `nsswitch.conf`. The **vendored inputs are NOT in the
context** (`.gitignore`d *and* `.dockerignore`d — ~219 MB of `.so`/`.db` files
that age badly and are no longer needed locally).

| Build arg | Default | Meaning |
|---|---|---|
| `TILESERVER_RELEASE_TAG` | `gisat-v2.39.0` | the release to fetch |
| `TILESERVER_ASSET_SHA256` | `eb948886…831b8e` | expected sha256 of `tileserver-gisat.tar.gz` |

Pin a different release:

```sh
docker compose -f deploy/tileserver/docker-compose.yml build \
  --build-arg TILESERVER_RELEASE_TAG=gisat-v2.40.0 \
  --build-arg TILESERVER_ASSET_SHA256=<sha256>
```

**The runtime is deliberately NOT the upstream Dockerfile's `ubuntu:24.04`**
(glibc 2.39 / `libgdal34t64`): the binary is built against Debian 12's glibc
2.36 / `libgdal32`, so the SONAMEs would not resolve there.

### Publishing a new runtime release

The release asset is the whole runtime context `tar`red up. On a Debian 12 host
that has GDAL — the same host that built the binary:

```sh
cd tileserver-rs && ./build-native.sh && cd -
./deploy/tileserver/collect-runtime-libs.sh          # populates the context
# pack the runtime context under a `tileserver-gisat/` top-level dir
# (the Dockerfile extracts with --strip-components=1):
tar -czf /tmp/tileserver-gisat.tar.gz \
  -C deploy/tileserver --transform 's,^tileserver-runtime,tileserver-gisat,' \
  tileserver-runtime
sha256sum /tmp/tileserver-gisat.tar.gz               # -> TILESERVER_ASSET_SHA256
```

`collect-runtime-libs.sh` collects, from `ldd` of the binary and `/usr/share`:

| Into | From | Why |
|---|---|---|
| `runtime-libs/` | `ldd` (114 `.so`) | the shared libs the binary links |
| `gdal-data/gdal/` | `/usr/share/gdal` | GDAL data — pkg `gdal-data`, **not** a dep of `libgdal32` |
| `gdal-data/proj/` | `/usr/share/proj` | `proj.db` CRS database — pkg `proj-data`, **not** a dep of `libproj25` |
| `tileserver-rs` | the built binary | what the image runs |

Then create a GitHub release on `twosix-code/tileserver-rs` with tag
`gisat-v<ver>`, attach `/tmp/tileserver-gisat.tar.gz`, and bump the two build
args (`TILESERVER_RELEASE_TAG`, `TILESERVER_ASSET_SHA256`) in the Dockerfile.

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
- **Updating:** bump the Dockerfile's `TILESERVER_RELEASE_TAG` (and
  `TILESERVER_ASSET_SHA256`) to a newer fork release, then
  `docker compose -f deploy/tileserver/docker-compose.yml up -d --build`. To
  rebuild the runtime from source, see
  [Publishing a new runtime release](#publishing-a-new-runtime-release).
