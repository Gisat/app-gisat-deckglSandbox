# TiTiler caching stack (nginx + TiTiler) — usage

This directory defines a **local-development TiTiler instance with an nginx
disk tile-cache in front of it**. It is the caching counterpart of the plain
instance in [`deploy/titiler/`](../titiler/USAGE.md) and is meant to run
**side by side with it** so the two can be compared (cache HIT latency vs.
always-render, upstream load, client `Cache-Control` behaviour).

## What it is

- **Two services** (same compose file):
  - `titiler` — [`ghcr.io/developmentseed/titiler:latest`](https://github.com/developmentseed/titiler)
    (2 uvicorn workers), listening on **container-internal port `8081`**,
    started with `--root-path=/api/v1/titiler`.
  - `nginx` (`nginx:1.27-alpine`) — the only host-exposed service, publishing
    **host port `8001`**. It reverse-proxies `/api/v1/titiler/…` to TiTiler and
    caches rendered tiles on disk (named volume `tile-cache`, persistent
    across restarts).
- **What nginx caches:** only URIs whose path matches `/tiles/` (the
  `$no_cache` guard in `nginx.conf`). Metadata/info/statistics requests pass
  through uncached. `X-Cache-Status: MISS|HIT` is added to every response.
- **Cache profile:** `proxy_cache_valid 200 301 302 1h` (404 = 1m),
  `inactive=14d`, `max_size=10g`, `levels=1:2`, `use_temp_path=off`.
  Cache key = `$scheme$request_method$host$uri$is_args$args` → **the full
  query string is part of the tile identity** (`url=`, `bidx=`, `rescale=`,
  `colormap=` variants are separate cache entries).
- **Why the 1-hour window:** `TITILER_API_CACHECONTROL=public, max-age=3600`
  tells clients *and* nginx how long a rendered tile stays valid. nginx
  prefers the upstream `Cache-Control` over `proxy_cache_valid` for its own
  validity, so both clocks agree (render time + 1 h). Raise it if your COGs
  change rarely, lower it if they change often.
- **Data:** `./data:/data:ro` is mounted for *local* COGs; remote `https://` /
  `s3://` COG URLs work without any mount (the demo COGs are fetched by
  TiTiler itself via GDAL `/vsicurl/`).

## Ports — and running alongside the plain instance

The two stacks are separate compose projects and do **not** conflict:

| Stack | Command (repo root) | Host ports | TiTiler inside |
| --- | --- | --- | --- |
| plain | `docker compose -f deploy/titiler/docker-compose.yml up -d` | `8000` → TiTiler | uvicorn :8000 |
| caching | `docker compose -f deploy/titiler-caching/docker-compose.yml up -d` | `8001` → nginx | uvicorn :8081 (internal, not published) |

Host ports used: **8000** (plain) and **8001** (caching nginx) — disjoint.
Container names, networks, and the cache volume are project-scoped
(`titiler-*` vs `titiler-caching-*`), so both can run at the same time
**without any port change**. The caching stack's TiTiler on `8081` is only
reachable through nginx (`http://localhost:8001/…`); if you ever want it
directly on the host too, add `ports: ["8081:8081"]` to the `titiler`
service — `8081` is currently free.

## Quick start

```sh
# from the repository root
docker compose -f deploy/titiler-caching/docker-compose.yml up -d
```

Verify it is up (nginx health passthrough — never cached):

```sh
curl http://localhost:8001/healthz
# healthy
```

Stop / restart / logs / teardown:

```sh
docker compose -f deploy/titiler-caching/docker-compose.yml stop     # stop (keep containers)
docker compose -f deploy/titiler-caching/docker-compose.yml start    # start again
docker compose -f deploy/titiler-caching/docker-compose.yml restart  # restart
docker compose -f deploy/titiler-caching/docker-compose.yml logs -f  # follow logs
docker compose -f deploy/titiler-caching/docker-compose.yml down     # stop + remove containers (cache volume survives)
docker compose -f deploy/titiler-caching/docker-compose.yml down -v  # … and delete the tile cache volume
```

`nginx` only starts after TiTiler's healthcheck passes (`depends_on:
condition: service_healthy`).

## API base path

Everything sits under the nginx prefix — use this as your base URL:

```
http://localhost:8001/api/v1/titiler
```

nginx rewrites `/api/v1/titiler/…` → `…` before proxying; uvicorn's
`--root-path` keeps the generated docs consistent with the prefix.

## Using it from the CLI

All routes are standard TiTiler 2.x (same as the plain instance). The
essential pattern:

```
GET /api/v1/titiler/cog/tiles/{TileMatrixSetId}/{z}/{x}/{y}.png?url=<urlencoded COG URL>&<params>
```

### 1. Health check

```sh
curl http://localhost:8001/healthz
```

### 2. Metadata of a COG

```sh
COG="https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/WET_SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif"

curl "http://localhost:8001/api/v1/titiler/cog/info?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")"
```

### 3. Fetch a single tile — and watch the cache warm up

```sh
TILE="http://localhost:8001/api/v1/titiler/cog/tiles/WebMercatorQuad/6/47/26.png?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&bidx=1&rescale=0,300"
for i in 1 2 3; do
  curl -s -o /dev/null -D - "$TILE" | grep -iE '^(HTTP|x-cache-status|cache-control)' | tr -d '\r' | tr '\n' ' '; echo
done
# req 1: HTTP/1.1 200 OK X-Cache-Status: MISS cache-control: public, max-age=3600
# req 2: HTTP/1.1 200 OK X-Cache-Status: HIT  cache-control: public, max-age=3600
# req 3: HTTP/1.1 200 OK X-Cache-Status: HIT
```

### 4. Automated cache verification

```sh
bash deploy/titiler-caching/test-cache.sh            # default Nepal Wet-Snow COG
COG_URL="<other-cog>" bash deploy/titiler-caching/test-cache.sh
```

Verifies `MISS → HIT → HIT` for one tile and that the query string is part of
the cache key (`rescale=0,300` / `0,100` are separate entries).

### 5. Per-band statistics (for picking `rescale` ranges)

```sh
curl "http://localhost:8001/api/v1/titiler/cog/statistics?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&bidx=1"
```

### 6. Point / bounds queries

```sh
curl "http://localhost:8001/api/v1/titiler/cog/point?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&lon=85.08&lat=27.8"

curl "http://localhost:8001/api/v1/titiler/cog/bounds?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")"
```

### 7. Interactive docs / OpenAPI

- Swagger UI: <http://localhost:8001/api/v1/titiler/docs>
- OpenAPI JSON: <http://localhost:8001/api/v1/titiler/openapi.json>

## Comparing with the plain instance

Both stacks serve the *same* TiTiler app; only the entry point differs.
Requests with identical COG + params are directly comparable:

```sh
# plain (always renders):    http://localhost:8000/cog/tiles/...
# caching (renders once):    http://localhost:8001/api/v1/titiler/cog/tiles/...
```

Timing example — fetch the same tile from both, twice each:

```sh
Q="url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&bidx=1&rescale=0,300"
for url in \
  "http://localhost:8000/cog/tiles/WebMercatorQuad/6/47/26.png?$Q" \
  "http://localhost:8001/api/v1/titiler/cog/tiles/WebMercatorQuad/6/47/26.png?$Q"; do
  echo "== $url"
  for i in 1 2; do
    curl -s -o /dev/null -w "  req $i: %{http_code}  %{time_total}s\n" "$url"
  done
done
```

Expected: the plain instance costs the same on every request; the caching
stack's first request (MISS) is comparable to plain, the second (HIT) comes
from nginx disk and is much faster. Repeat with a fresh browser tab /
`curl -H 'Cache-Control: no-cache'` to simulate a client that ignores
`max-age` — nginx still answers HIT and TiTiler only renders cold tiles.
Note that with the 1 h window, a HIT older than ~1 h re-renders once (then
serves from disk again for the next hour).

The sandbox web app keeps talking to the plain instance
(`VITE_TITILER_URL=http://localhost:8000`, see `.env.example`). To point the
app at the caching stack instead, set
`VITE_TITILER_URL=http://localhost:8001/api/v1/titiler` (full prefix
included — the app appends `/cog/…` paths) and restart the Vite dev server.

## Terrarium encoder (Mapzen-style elevation tiles)

This stack also ships a **Terrarium elevation-tile encoder** — a Mapzen-style
pipeline that is *separate from* (and sibling to) TiTiler:

- **Role:** reads the same public float32 DEM COG directly via rasterio
  windowed reads (`/vsicurl/`) and packs each `WebMercatorQuad {z}/{x}/{y}`
  tile in the Mapzen **Terrarium** RGB format (`encoded = (elev + CLAMP)*256`;
  R = high byte, G = middle, B = low). No reprojection — the COG is EPSG:3857.
- **Where it lives:** `deploy/titiler-caching/terrarium-encoder/`
  (`terrarium_encoder.py` + `Dockerfile`), built from a `python:3.12-slim`
  image (rasterio + GDAL, fastapi, uvicorn, pillow, numpy).
- **Topology:** the `terrarium` service exposes **no host port** — it is
  reached only through this stack's **same nginx**, at
  `/api/v1/terrarium/{z}/{x}/{y}.png`, and its tiles are cached by that same
  nginx (the `/terrarium/` location gets the same `proxy_cache` treatment as
  `/tiles/`).
- **Why this matters vs. TiTiler's grayscale path:** TiTiler renders a
  single-band COG as **grayscale** (R=G=B), so a Terrarium decoder there
  collapses to ~256 levels. The encoder genuinely packs float resolution across
  the RGB channels, so the canonical Terrarium decoder on the client recovers
  **sub-metre precision**: `height = R*256 + G + B/256 - CLAMP` with
  `CLAMP = 32768` (canonical Mapzen), set via `ENCODER_CLAMP` in the caching
  compose file (the DEM spans 0..5631 m).

Fetch a tile (MISS → HIT as it warms like TiTiler):

```sh
BASE=http://localhost:8001/api/v1/terrarium
for i in 1 2 3; do
  curl -s -o /dev/null -D - "$BASE/8/80/140.png" \
    | grep -iE '^(HTTP|x-cache-status|cache-control)' | tr -d '\r' | tr '\n' ' '; echo
done
# req 1: HTTP/1.1 200 OK X-Cache-Status: MISS cache-control: public, max-age=3600
# req 2: HTTP/1.1 200 OK X-Cache-Status: HIT
# req 3: HTTP/1.1 200 OK X-Cache-Status: HIT
```

Notes:

- The encoder `CLAMP` (m) in `docker-compose.yml` (`ENCODER_CLAMP`) and the client
  `ELEVATION_DECODER.offset` in `src/maps/TiTilerDemo/TerrariumTerrain.jsx`
  must stay equal (both 32768).
- The encoder caps `ENCODER_Z_MAX` at 14 (the COG's native ~30 m GLO-30
  detail); beyond that it is upsampling with no added precision.
- The encoder's cache match is `/terrarium/` (distinct from TiTiler's
  `/tiles/`), so the two producers cache independently in the same volume.

## Caching behaviour at a glance

| Aspect | Value |
| --- | --- |
| Cached | only URIs matching `/tiles/` (render endpoints) |
| Cache key | `scheme + method + host + URI + full query string` |
| Freshness | 1 h (`proxy_cache_valid` + `max-age=3600`, one shared clock) |
| Eviction (LRU) | 14 d inactive, 10 GB max, disk layout `levels=1:2` |
| Concurrency | `proxy_cache_lock` + `proxy_cache_background_update` (one render per cold tile, stale-while-refresh) |
| Observation | `X-Cache-Status: MISS/HIT` response header |
| Purge | stock nginx has no purge endpoint — deterministic MD5 keys, see the purge snippet in [`NGINX-CacheConcepts.md`](NGINX-CacheConcepts.md) (same directory) |

## Notes & troubleshooting

- **Don't try `http://localhost:8081`** — TiTiler's port is internal to the
  compose network. The host entry point is nginx on `8001` only.
- **Path prefix is mandatory:** requests must start with `/api/v1/titiler/`
  to match nginx's `location` (except the exact `/healthz` passthrough).
- **`X-Cache-Status` only appears on proxied paths**; the `/healthz`
  passthrough has no cache header.
- **Cache volume:** named volumes are project-scoped, so this stack uses
  `titiler-caching_tile-cache`. If the folder was moved from a differently
  named directory, the stack starts with a **cold cache** (new empty volume);
  the old volume remains orphaned until pruned (`docker volume prune`).
- **Query-string order/encoding matters** — it is part of the cache key, so
  `rescale=0,300` vs `rescale=0,100` (or reordered params) are different
  entries by design.
- **First tile of a COG is slower** (render + store); subsequent HITs are
  served from disk. `proxy_cache_lock` keeps a single upstream request per
  cold tile even under concurrent demand.
- **Client caching:** `Cache-Control: public, max-age=3600` makes compliant
  clients (browsers, GIS apps) keep tiles for 1 h locally — combined with the
  nginx disk cache, TiTiler renders a tile at most once per unique URL per
  hour.
- **CORS is open by default** in the TiTiler image (`cors_origins="*"`), so
  browser use works; the compose file keeps telemetry off.
- **Workers:** 2 uvicorn workers here (vs 1 on the plain instance) — keep in
  mind when comparing upstream behaviour.
