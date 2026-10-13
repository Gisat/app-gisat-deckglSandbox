# TiTiler DEMO — single-TiTiler stack

Local-development deployment for the **`TiTiler DEMO`** category of the sandbox
(Nepal snow, Uganda multiband, Manila RGB, WorldCereal, GHS population, Misicuni
terrain, Terrarium terrain, Float32 terrain).

It runs **one TiTiler instance**, reachable two ways:

| Mode | URL | Path |
| --- | --- | --- |
| **Direct / uncached** ("plain") | `http://localhost:8000` | browser/app → `titiler:8000` |
| **Cached** (through nginx) | `http://localhost:8001/api/v1/titiler/…` | app → `nginx:8001` → `titiler:8000` |

It is the **same container** in both cases. nginx is a proxy + disk tile cache in
front of it, not a second renderer. That is the point of this stack: it replaces
running `deploy/titiler` **and** `deploy/titiler-caching` side by side (which
started two TiTiler containers) with a single one that serves both the plain and
the cached demo paths.

The two **elevation encoders** (`terrarium`, `float32`) are included because the
terrain demos need them. They are **not** TiTiler instances — they read the DEM
COG directly with rasterio and are reached only through nginx.

## Services

| Service | Image / build | Role | Reached at |
| --- | --- | --- | --- |
| `titiler` | `ghcr.io/developmentseed/titiler:latest` | the single COG tile renderer | host **:8000** (direct) **and** nginx `/api/v1/titiler/` |
| `nginx` | `nginx:1.27-alpine` | reverse proxy + disk tile cache | host **:8001** |
| `terrarium` | `../titiler-caching/terrarium-encoder` | Mapzen Terrarium RGB elevation tiles | nginx `/api/v1/terrarium/` |
| `float32` | `../titiler-caching/float32-encoder` | raw headerless little-endian float32 elevation tiles | nginx `/api/v1/float32/` |

Colormaps are reused from `../titiler/colormaps/` (mounted at `/colormaps`);
encoder sources are reused from `../titiler-caching/` (referenced as build
contexts). Nothing is duplicated.

> Relationship to the other stacks: `deploy/titiler/` is the plain-only stack and
> `deploy/titiler-caching/` is the nginx stack; running both yields **two**
> TiTiler containers. `deploy/titiler-combined/` is the recommended single-instance
> alternative and exposes the **same host ports the app already expects**
> (`8000` plain, `8001` cached), so it is a drop-in replacement.

## Quick start

```sh
# from the repository root
docker compose -f deploy/titiler-combined/docker-compose.yml up -d --build
```

Verify everything is up:

```sh
curl http://localhost:8000/healthz                       # direct TiTiler       -> 200
curl http://localhost:8001/healthz                       # nginx -> TiTiler     -> 200
curl http://localhost:8001/api/v1/terrarium/healthz      # terrarium encoder    -> 200
curl http://localhost:8001/api/v1/float32/healthz        # float32 encoder      -> 200
```

Lifecycle (all `docker compose -f deploy/titiler-combined/docker-compose.yml …`):

```sh
… stop            # stop containers, keep them
… start           # start again
… restart         # restart
… logs -f         # follow logs
… down            # remove containers (cache volume survives)
… down -v         # remove containers AND the tile cache
```

After editing `nginx.conf` (bind-mounted): `up -d` then `restart nginx` —
compose does not recreate nginx on mounted-file changes.

## Using it from the CLI

Standard TiTiler 2.x routes. The essential pattern:

```
GET /cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=<urlencoded COG URL>&<params>
```

```sh
COG="https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/WET_SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif"
ENC() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

# DIRECT (uncached) — hit TiTiler on :8000, no /api/v1/titiler prefix
curl "http://localhost:8000/cog/info?url=$(ENC "$COG")"
curl -o tile.png "http://localhost:8000/cog/tiles/WebMercatorQuad/6/47/26.png?url=$(ENC "$COG")&bidx=1&rescale=0,300&colormap_name=nepal_snow_viridis"

# CACHED — same routes under the nginx prefix on :8001
curl "http://localhost:8001/api/v1/titiler/cog/info?url=$(ENC "$COG")"
curl -D - -o tile.png "http://localhost:8001/api/v1/titiler/cog/tiles/WebMercatorQuad/6/47/26.png?url=$(ENC "$COG")&bidx=1&rescale=0,300&colormap_name=nepal_snow_viridis" | grep -i x-cache-status
```

- Swagger UI: direct <http://localhost:8000/docs> · cached <http://localhost:8001/api/v1/titiler/docs>
- Point / bounds / statistics: `/cog/point`, `/cog/bounds`, `/cog/statistics` (same, cached only passes tiles).

## Caching

Only through nginx (`:8001`). Direct access (`:8000`) never caches.

- Cached URIs: paths matching `/tiles/`, `/terrarium/`, or `/float32/`. Metadata /
  info / healthz pass through uncached.
- Cache key = `scheme + method + host + URI + full query string`, so `rescale=`,
  `bidx=`, `colormap_name=`, … are separate entries by design.
- Freshness 1 h (`TITILER_API_CACHECONTROL=public, max-age=3600` honoured;
  `proxy_cache_valid` fallback). Eviction `inactive=14d`, `max_size=10g`.
  `proxy_cache_lock` → one render per cold tile.
- Every proxied response carries `X-Cache-Status: MISS|HIT`.
- Cache survives restarts (named volume `tile-cache`); `down -v` clears it.

Warm-up check:

```sh
for i in 1 2 3; do
  curl -s -o /dev/null -D - "http://localhost:8001/api/v1/terrarium/8/80/140.png" \
    | grep -iE '^(HTTP|x-cache-status)' | tr -d '\r' | tr '\n' ' '; echo
done
# MISS, then HIT, HIT
```

## Elevation encoders (not TiTiler)

Both read the public float32 EPSG:3857 GLO-30+geoid DEM COG (Misicuni, 0..5631 m)
via rasterio windowed reads with `/vsicurl/`, bilinear resampling,
`ENCODER_Z_MIN=1`..`ENCODER_Z_MAX=14`.

- **Terrarium** `/api/v1/terrarium/{z}/{x}/{y}.png` — Mapzen RGB packing
  (`encoded = (elev + CLAMP)*256`); client decode `height = R*256 + G + B/256 - CLAMP`.
  `ENCODER_CLAMP=32768` must equal `ELEVATION_DECODER.offset` in
  `src/maps/TiTilerDemo/TerrariumTerrain/index.jsx`.
- **float32** `/api/v1/float32/{z}/{x}/{y}.f32` — headerless little-endian
  float32, row-major north-up, 256×256 → **exactly 262,144 bytes**, metres. NaN /
  masked / out-of-footprint filled with `0.0`. nginx gzips it.

```sh
curl -s http://localhost:8001/api/v1/float32/8/80/140.f32 | wc -c   # 262144
```

## How the app reaches it

The page is served under COEP `require-corp`, which blocks direct cross-origin
fetches to `localhost:8000` / `localhost:8001`. The Vite dev server therefore
proxies both, same-origin (see `vite.config.js`):

| App endpoint (switcher) | Vite proxy | Reaches |
| --- | --- | --- |
| **TiTiler (plain)** | `/titiler-plain` → `http://localhost:8000` (prefix stripped) | the single TiTiler, uncached |
| **TiTiler + cache** | `/titiler/api` → `http://localhost:8001` (prefix stripped) | nginx → same TiTiler, cached |

`src/maps/TiTilerDemo/shared/endpoints.js` holds these two base URLs. Leave
`VITE_TITILER_URL` **unset** for local dev (it would add a cross-origin `custom`
endpoint that COEP blocks). The terrarium/float32 demos target
`/titiler/api/v1/{terrarium,float32}` directly.

```sh
npm install
npm run dev        # app on :5173
```

### Production (behind an nginx front door)

The app image serves static files only (`serve_web.py`) and has no proxy, so in
production an **outer nginx** must route the two same-origin prefixes. Put that
proxy on the **same docker network** as the app and this stack and route by
docker **service name**; then only the proxy is published to the host
(e.g. `-p 3000:80`) and neither TiTiler nor the tile-cache nginx needs a host
port:

| Public path | Front-door route | Reaches (docker service) |
| --- | --- | --- |
| `/` | — | app (`app:5000`) |
| `/titiler-plain/…` | strip `/titiler-plain/` | `titiler:8000` (uncached) |
| `/titiler/api/…` | `/titiler/api/` → `/api/` | `nginx:80` (cached; also `/api/v1/terrarium/`, `/api/v1/float32/`) |

A ready example is [`nginx.production.example.conf`](nginx.production.example.conf)
— a site-style snippet for the proxy's `http {}` block (`/etc/nginx/conf.d/`).
The front door only **routes**; tile caching stays in this stack's nginx
(`nginx.conf`). The stack's default `ports` (8000/8001) are only needed when the
proxy runs **outside** docker — clear them when everything shares the network
(the example file's footer shows the host-port variant for that case).

## Colormaps

Registered server-side (short `colormap_name` so tile queries stay cacheable),
from `../titiler/colormaps/`:

| colormap_name | Demo |
| --- | --- |
| `nepal_snow_viridis` | Nepal Snow Cover |
| `uganda_blues_transparent` | Uganda Multiband (LUC) |
| `worldcereal_active` | WorldCereal Active Cropland |
| `ghs_pop_transparent_low` | GHS Population Density |
| *(none / grayscale)* | Misicuni Terrain (DEM), Manila RGB |

After adding/editing a colormap, restart the TiTiler so `COLORMAP_DIRECTORY`
re-scans:

```sh
docker compose -f deploy/titiler-combined/docker-compose.yml up -d --force-recreate titiler
```

## Troubleshooting

- **Ports:** `8000` (TiTiler direct) / `8001` (nginx) must be free. If taken,
  remap and point the app at them: change the compose `ports`, then update the
  Vite proxy targets in `vite.config.js`. (On the NAS dev host `8000`/`8001` are
  used by the ainstruct MCP stack — remap e.g. to `8002`/`8003`.)
- **`host not found in upstream`** from nginx: an upstream container was not up
  when nginx started. nginx waits for all three via `depends_on: service_healthy`;
  if you start services individually, start `titiler`/`terrarium`/`float32` first.
- **CORS:** `TITILER_API_CORS_ORIGIN=*` is set; the app proxy is same-origin anyway.
- **First tile slower:** remote COG reads (GDAL range requests / in-memory cache).
- **No persistence for TiTiler:** stateless; only the nginx `tile-cache` volume
  persists.
