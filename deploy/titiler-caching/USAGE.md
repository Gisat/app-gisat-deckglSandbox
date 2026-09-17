# TiTiler caching stack — usage

Local-development stack: **nginx disk tile-cache in front of three tile
producers** — TiTiler plus two sibling elevation-tile encoders. Counterpart of
the plain instance in [`deploy/titiler/`](../titiler/USAGE.md); both stacks run
side by side without conflict (host ports `8000` plain, `8001` caching nginx).

## Services (one compose file)

| Service | Image / build | Role | Reached at |
| --- | --- | --- | --- |
| `nginx` | `nginx:1.27-alpine` | only host-exposed service (**:8001**); reverse proxy + disk tile cache | `http://localhost:8001` |
| `titiler` | `ghcr.io/developmentseed/titiler` | COG tile renderer (2 uvicorn workers, internal :8081) | `/api/v1/titiler/…` |
| `terrarium` | `./terrarium-encoder/` | Mapzen **Terrarium RGB PNG** elevation tiles from the float32 DEM COG (rasterio `/vsicurl/` windowed reads, internal :8000) | `/api/v1/terrarium/{z}/{x}/{y}.png` |
| `float32` | `./float32-encoder/` | **raw headerless little-endian float32** elevation tiles from the same COG (internal :8000) | `/api/v1/float32/{z}/{x}/{y}.f32` |

The encoders are **siblings of TiTiler, not middlemen**: they read the public
COG directly and bypass TiTiler at request time. Neither exposes a host port —
everything goes through nginx.

## Quick start

```sh
# from the repository root
docker compose -f deploy/titiler-caching/docker-compose.yml up -d --build

curl http://localhost:8001/healthz                       # nginx→titiler passthrough
curl http://localhost:8001/api/v1/terrarium/healthz      # terrarium encoder
curl http://localhost:8001/api/v1/float32/healthz        # float32 encoder
```

Lifecycle (all `docker compose -f deploy/titiler-caching/docker-compose.yml …`):
`stop` / `start` / `restart` / `logs -f` / `down` (cache volume survives) /
`down -v` (also deletes the cache).

After editing `nginx.conf` (bind-mounted): `up -d --build <new service>` then
`restart nginx` — compose does not recreate nginx on mounted-file changes, and
nginx resolves upstreams at startup, so start new upstream containers first.

## Caching

- Cached URIs: paths matching `/tiles/`, `/terrarium/`, or `/float32/`
  (the `$no_cache` guard in `nginx.conf`). Metadata/info/healthz pass through
  uncached.
- Cache key = `scheme + method + host + URI + full query string` — parameter
  variants (`rescale=`, `colormap=`, …) are separate entries by design.
- Freshness 1 h (upstream `Cache-Control: public, max-age=3600` is honoured;
  `proxy_cache_valid` is the fallback). Eviction: `inactive=14d`,
  `max_size=10g`. `proxy_cache_lock` → one render per cold tile.
- Every proxied response carries `X-Cache-Status: MISS|HIT`.
- Purge: no endpoint in stock nginx — see
  [`NGINX-CacheConcepts.md`](NGINX-CacheConcepts.md).

Warm-up check (any producer):

```sh
for i in 1 2 3; do
  curl -s -o /dev/null -D - "http://localhost:8001/api/v1/terrarium/8/80/140.png" \
    | grep -iE '^(HTTP|x-cache-status)' | tr -d '\r' | tr '\n' ' '; echo
done
# MISS, then HIT, HIT
```

Automated: `bash deploy/titiler-caching/test-cache.sh` (TiTiler MISS→HIT and
query-string cache-key identity).

## TiTiler (`/api/v1/titiler`)

Standard TiTiler 2.x API; nginx strips the prefix, uvicorn `--root-path` keeps
docs consistent. Base URL: `http://localhost:8001/api/v1/titiler`.

```sh
COG="https://…/some_cog.tif"
ENC() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

curl "http://localhost:8001/api/v1/titiler/cog/info?url=$(ENC "$COG")"
curl "http://localhost:8001/api/v1/titiler/cog/statistics?url=$(ENC "$COG")&bidx=1"
curl "http://localhost:8001/api/v1/titiler/cog/tiles/WebMercatorQuad/6/47/26.png?url=$(ENC "$COG")&bidx=1&rescale=0,300"
```

Swagger UI: <http://localhost:8001/api/v1/titiler/docs>.

## Elevation encoders

Both read the same public **float32 EPSG:3857 GLO-30+geoid DEM COG**
(Misicuni; 0..5631 m) with rasterio windowed reads, bilinear resampling,
`ENCODER_Z_MIN=1`..`ENCODER_Z_MAX=14` (the COG's ~30 m native detail).
Consumed by the deck.gl demos in `src/maps/TiTilerDemo/` through the vite
`/titiler/api` proxy.

### Terrarium (`/api/v1/terrarium/{z}/{x}/{y}.png`)

- Mapzen Terrarium RGB packing: `encoded = (elev + CLAMP)*256`; R/G/B =
  high/mid/low byte. Client decode `height = R*256 + G + B/256 - CLAMP`.
- `CLAMP = 32768` (canonical Mapzen) — **`ENCODER_CLAMP` in
  `docker-compose.yml` and `ELEVATION_DECODER.offset` in
  `TerrariumTerrain.jsx` must stay equal.**
- Client demo `/titiler-demo-terrarium-terrain` uses a pure-JS PNG loader
  (`TerrariumLoader.js`, UPNG) because the browser's color-managed image
  pipeline shifts RGB by ±1 → ±256 m needles (deck.gl issue #10400).

### Raw float32 (`/api/v1/float32/{z}/{x}/{y}.f32`)

- Wire contract: **headerless little-endian IEEE-754 float32 (`'<f4'`),
  row-major north-up, 256×256 → exactly 262,144 bytes**, heights in metres.
  No packing, no CLAMP, nothing the browser image pipeline can corrupt.
- NaN/masked/out-of-footprint pixels are filled with `0.0` server-side;
  fully-outside tiles return a flat all-zero tile (200) so the terrain mesh
  stays continuous.
- nginx gzips the stream (`gzip_types application/octet-stream`, with
  `Vary: Accept-Encoding`); float32 DEM tiles compress well.
- Client demo `/titiler-demo-float32-terrain` (`Float32Loader.js`) parses with
  a plain `new Float32Array(arrayBuffer)` — no elevationDecoder math, no
  needles by construction.

```sh
curl -s http://localhost:8001/api/v1/float32/8/80/140.f32 | wc -c   # 262144
curl -s --compressed -D - -o /dev/null \
  http://localhost:8001/api/v1/float32/8/80/140.f32 | grep -i content-encoding
# content-encoding: gzip
```

Terrarium vs float32: Terrarium keeps the canonical Mapzen format
(interoperable with other Terrarium consumers); raw float32 is simpler and
provably needle-free. Pick per demo.

## Notes

- **Never `http://localhost:8081`** — TiTiler's port is compose-internal; the
  only host entry point is nginx on `8001`.
- The prefix is mandatory: `/api/v1/{titiler|terrarium|float32}/…` (plus the
  exact `/healthz` passthrough).
- Named cache volume is project-scoped (`titiler-caching_tile-cache`); renaming
  the directory starts a cold cache and orphans the old volume.
- Encoder tiles at z>14 are upsampling with no added precision.
- Browser access must ride the vite `/titiler/api` proxy — the app's COEP
  `require-corp` blocks direct `localhost:PORT` fetches.
- CORS is open in the TiTiler image; telemetry is off.
