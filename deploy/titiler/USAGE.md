# TiTiler demo container — usage

This directory defines a **local-development TiTiler instance** that serves the
COG (Cloud Optimized GeoTIFF) tile demos in the `TiTiler DEMO` category of the
sandbox app (Nepal snow cover, Uganda multiband LUC, Manila RGB).

## What it is

- **Image:** [`ghcr.io/developmentseed/titiler:latest`](https://github.com/developmentseed/titiler)
  — the Development Seed TiTiler 2.x application (FastAPI + uvicorn).
- **Role:** an on-the-fly tile server. It reads a remote COG (public Linode S3
  object) via GDAL `/vsicurl/`, and re-renders it into `{z}/{x}/{y}` PNG tiles
  for the requested band, stretch, and colormap.
- **Why it exists:** the browser cannot decode COGs directly, and the demos need
  TiTiler's server-side processing (`bidx`, `rescale`, `colormap`, `nodata`).
  Nothing is stored locally — every request re-reads the remote COG (GDAL range
  requests + caching make this cheap).
- **Data:** the demo COGs are public URLs fetched by TiTiler itself; **no local
  data download or volume mount is required.**

The sandbox web app talks to this container over HTTP on port `8000`. The base
URL is configured via `VITE_TITILER_URL` (see `.env.example`); the app's
default fallback is `http://localhost:8000`.

## Quick start

```sh
# from the repository root
docker compose -f deploy/titiler/docker-compose.yml up -d
```

Verify it is up:

```sh
curl http://localhost:8000/healthz
# healthy
```

Stop / restart / logs / teardown:

```sh
docker compose -f deploy/titiler/docker-compose.yml stop     # stop (keep container)
docker compose -f deploy/titiler/docker-compose.yml start    # start again
docker compose -f deploy/titiler/docker-compose.yml restart  # restart
docker compose -f deploy/titiler/docker-compose.yml logs -f  # follow logs
docker compose -f deploy/titiler/docker-compose.yml down     # stop + remove container
```

## Using it from the CLI

All routes are standard TiTiler 2.x. The essential pattern:

```
GET /cog/tiles/{TileMatrixSetId}/{z}/{x}/{y}.png?url=<urlencoded COG URL>&<params>
```

`WebMercatorQuad` is the default tile matrix set (what the sandbox uses).

### 1. Health check

```sh
curl http://localhost:8000/healthz
```

### 2. Metadata of a COG

```sh
COG="https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/WET_SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif"

curl "http://localhost:8000/cog/info?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")"
```

### 3. Fetch a single tile as PNG

```sh
# Nepal snow: single band, stretched 0..300, viridis-like colormap
# (tile 6/47/26 = Kathmandu region at zoom 6 — inside the COG bounds)
TILE="http://localhost:8000/cog/tiles/WebMercatorQuad/6/47/26.png?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&bidx=1&rescale=0,300"
curl -o tile.png "$TILE"
file tile.png   # -> PNG image data
```

### 4. Per-band statistics (useful for picking `rescale` ranges)

```sh
curl "http://localhost:8000/cog/statistics?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&bidx=1"
```

`percentile_2` / `percentile_98` from the response are what the Uganda demo uses
for its per-band `rescale`.

### 5. Point / bounds queries

```sh
# value of a COG at a lon/lat point
curl "http://localhost:8000/cog/point?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")&lon=85.08&lat=27.8"

# COG footprint (bounds + geometry, GeoJSON)
curl "http://localhost:8000/cog/bounds?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$COG")"
```

### 6. Interactive docs / OpenAPI

- Swagger UI: <http://localhost:8000/docs>
- OpenAPI JSON: <http://localhost:8000/openapi.json>

## How the sandbox uses it

| Demo | COG | Params used |
| --- | --- | --- |
| Nepal Snow Cover | int16 snow-cover COG (EPSG:3857) | `bidx=1`, `rescale=0,300`, `colormap_name=nepal_snow_viridis` (server-side registered viridis ramp) |
| Uganda Multiband (LUC) | multiband LUC COG | `bidx=<15..24>` (band slider), per-band `rescale`, `colormap_name=uganda_blues_transparent` (server-side registered, byte 0 transparent for all bands) |
| Manila RGB | uint8 RGB composite | none (true RGB served directly) |
| WorldCereal Active Cropland | uint8 single-band class COG | `bidx=1`, `colormap_name=worldcereal_active` (server-side registered categorical: 0=gray not active, 100=green cropland, 254 "No crop"+255 nodata transparent) |
| GHS Population Density | float32 global population COG | `bidx=1`, `rescale=0,10`, `colormap_name=ghs_pop_transparent_low` (server-side registered RGBA ramp, alpha 0 on bytes 0–10 → nodata −200 & low-density transparent) |
| Misicuni Terrain (DEM) | float32 single-band DEM, EPSG:3857 (GLO-30 + geoid, Misicuni/Cochabamba) | `bidx=1`, `rescale=0,5600` — **no colormap**: served grayscale, decoded client-side by a native deck.gl `TerrainLayer` |

All registered colormaps live in `deploy/titiler/colormaps/` and are referenced by
short `colormap_name` so tile queries stay small and the nginx tile cache
(`deploy/titiler-caching`, cache key = full `$args`) engages. The full 256-entry
ramps sent inline (`colormap=` ~10 KB) bypass the nginx cache. Manila RGB needs
a colormap name only because its query has no colormap at all.

After adding or editing a registered colormap, restart **both** stacks so
`COLORMAP_DIRECTORY` re-scans at startup:

```sh
docker compose -f deploy/titiler/docker-compose.yml up -d --force-recreate
docker compose -f deploy/titiler-caching/docker-compose.yml up -d --force-recreate
```

The web app hits the tile endpoint from the browser (CORS is opened with
`TITILER_API_CORS_ORIGIN=*` in the compose file). If the container is not
running, the sandbox shows an error modal reporting the expected endpoint and
this start command.

### Misicuni Terrain (native TerrainLayer)

Unlike the other TiTiler demos (flat `BitmapLayer` tiles), Misicuni Terrain
renders a **3D mesh** via deck.gl's native `TerrainLayer`, fed by TiTiler
**grayscale** PNG tiles of a float32 single-band DEM:

```
GET /cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=<COG>&bidx=1&rescale=0,5600
```

- **Why grayscale + custom `elevationDecoder`, not Mapzen/Terrarium:** TiTiler
  cannot emit Terrarium-packed RGB elevation tiles from an arbitrary float COG
  (single band → R=G=B grayscale). A Terrarium decoder (`rScaler:256,
  gScaler:1, bScaler:1/256, offset:-32768`) would just multiply three equal
  bytes and collapse to one effective gain — no extra resolution.
- **Decoder inverts TiTiler's linear rescale:** `height = value*rScaler + offset`
  with `rScaler = (rescale[1]-rescale[0])/255`, `offset = rescale[0]`.
- **Resolution driver is the same 8-bit PNG** as the flat demos (~256
  discrete levels over the stretch). It looks smooth at the intended
  relief-wide 3D zoom; it steps if you zoom far in. Full-precision terrain
  would need a client-side float COG read (not a TiTiler demo).

See `src/maps/TiTilerDemo/MisicuniTerrain.jsx` for the `RESCALE_MIN`/`RESCALE_MAX`
constants, which must stay in sync with the `rescale` query param and the
`ELEVATION_DECODER`.

## Notes & troubleshooting

- **Ports:** container publishes `8000:8000`. Change the left side if `8000` is
  taken: `ports: ["8001:8000"]` — then point the app at it via
  `VITE_TITILER_URL=http://localhost:8001`.
- **CORS:** the browser needs the TiTiler CORS header; the compose file already
  sets `TITILER_API_CORS_ORIGIN=*`.
- **Performance:** remote COG reads are tuned in the compose file (GDAL
  cache 75%, range merging, HTTP/2 multiplexing). First tile of a COG is
  slower; subsequent ones come from TiTiler's in-memory cache.
- **No persistence:** the container is stateless; `docker compose down` loses
  nothing but the container.
- **Config override:** the app reads `VITE_TITILER_URL` (see `.env.example`).
  Rebuild/restart the Vite dev server after changing it.
