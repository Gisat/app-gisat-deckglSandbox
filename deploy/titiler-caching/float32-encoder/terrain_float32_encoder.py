"""Raw float32 elevation-tile encoder (headerless little-endian).

Serves WebMercatorQuad (EPSG:3857) {z}/{x}/{y}.f32 elevation tiles as a
HEADERLESS raw stream of little-endian IEEE-754 float32 values from a float32
single-band COG, read directly with rasterio windowed reads over GDAL
/vsicurl/ (no reprojection: the COG is already EPSG:3857).

This is a SIBLING tile producer to TiTiler (and to the Terrarium encoder in
this stack) — it bypasses TiTiler at request time and reads the same public
COG directly. Endpoints are:

    /healthz                      -> {"status":"ok"}
    /{z}/{x}/{y}.f32              -> raw float32 elevation tile

It is mounted behind the same nginx as TiTiler in this stack, at
`/api/v1/float32/` (nginx strips that prefix, so the app sees /{z}/{x}/{y}.f32).

## Wire contract (documented for consumers)

- HTTP 200 body is a headerless, raw stream of IEEE-754 **little-endian**
  float32 values (`'<f4'`), row-major, north-up.
- Tile edge is 256 px, so the body is exactly 256*256*4 = 262,144 bytes.
- The first value (index 0) is the **north-west** corner; the last (index
  65535) is the **south-east** corner. Row `r` spans indices `r*256 ..
  r*256+255`, south each row.
- Height units are **metres** (the COG is a GLO-30 + geoid DEM) — the client
  uses an identity decode, no elevationDecoder math needed.
- Masked / nodata / out-of-COG pixels are filled **server-side with 0.0**.
  This is a deliberate contract: the martini tesselator cannot handle NaN, so
  a NaN would corrupt the client mesh. 0.0 maps to a flat void at sea level.
- Tiles fully outside the COG footprint return a flat all-0.0 tile (200), so
  deck.gl keeps a continuous mesh instead of 404ing and tripping the error
  modal. Tiles that merely overlap the edge get their out-of-COG cells padded
  to 0.0 by the boundless read below.
- Content-Type: `application/octet-stream`; `Cache-Control: public,
  max-age=3600` (cached by nginx like TiTiler / Terrarium tiles).

Rationale vs. Terrarium: raw float32 bypasses the browser's color-managed
image pipeline entirely (see deck.gl issue #10400 — the PNG path shifted
R/G/B by ±1 through createImageBitmap, causing ±256 m needles), and removes
the Terrarium packing + CLAMP coupling on both sides.
"""
import os

import numpy as np
import rasterio
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

# Public Misicuni GLO-30 + geoid DEM (float32, single band, EPSG:3857).
COG_URL = os.environ.get(
    "ENCODER_COG_URL",
    "https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/"
    "app-gisat-deckglSandbox/rasters/"
    "glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif",
)

# WebMercator globe constants (world half-width in planar meters).
HALF = 20037508.342789244
WORLD = 2.0 * HALF

TILE_SIZE = 256                     # pixels per tile edge
Z_MIN = int(os.environ.get("ENCODER_Z_MIN", "1"))
# Cap at the COG's native detail (~30 m GLO-30). Beyond it is upsampling with
# no added precision. Matches the cap used by MisicuniTerrain.jsx.
Z_MAX = int(os.environ.get("ENCODER_Z_MAX", "14"))

# Decimation resampling pinned to match TiTiler's tile render (bilinear for
# continuous float data), so direct-read tiles align with the TiTiler demos.
RESAMPLING = Resampling.bilinear

app = FastAPI(title="Raw float32 encoder", docs_url=None, redoc_url=None)

_ds = None


def get_ds() -> rasterio.io.DatasetReader:
    """Open the remote COG once and keep it (GDAL /vsicurl/ range reads reuse it)."""
    global _ds
    if _ds is None or _ds.closed:
        _ds = rasterio.open(COG_URL)
    return _ds


def tile_bounds(z: int, x: int, y: int):
    """WebMercatorQuad tile -> EPSG:3857 (left, bottom, right, top)."""
    n = 2 ** z
    res = WORLD / n
    x_max = -HALF + (x + 1) * res
    x_min = x_max - res
    y_max = HALF - y * res
    y_min = y_max - res
    return x_min, y_min, x_max, y_max


def get_tile(z: int, x: int, y: int) -> np.ndarray:
    ds = get_ds()
    x_min, y_min, x_max, y_max = tile_bounds(z, x, y)
    b = ds.bounds
    # Fully outside the COG footprint: return a FLAT void tile (elevation 0)
    # instead of 404. deck.gl would treat a 404 as a tile error and trip the
    # in-app error modal; a flat tile keeps the mesh continuous and just
    # flattens to sea level past the DEM boundary. Note: a tile that merely
    # OVERLAPS the edge is handled by the boundless read below, which pads
    # out-of-COG cells with 0.
    if x_max <= b.left or x_min >= b.right or y_max <= b.bottom or y_min >= b.top:
        return np.full((TILE_SIZE, TILE_SIZE), 0.0, np.float32)
    win = from_bounds(x_min, y_min, x_max, y_max, ds.transform)
    # boundless=True lets the window overhang the raster edges; out-of-COG cells
    # read as 0, which is the flat "void" skirt at the footprint boundary.
    arr = ds.read(
        1,
        window=win,
        boundless=True,
        out_shape=(TILE_SIZE, TILE_SIZE),
        resampling=RESAMPLING,
    )
    if arr.shape != (TILE_SIZE, TILE_SIZE):
        raise HTTPException(status_code=500, detail="unexpected tile read shape")
    return arr


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/{z}/{x}/{y}.f32", response_class=Response)
def tile(z: int, x: int, y: int) -> Response:
    if not (Z_MIN <= z <= Z_MAX) or x < 0 or y < 0:
        raise HTTPException(status_code=404, detail=f"tile out of range z={z}")
    arr = get_tile(z, x, y)
    # Headerless little-endian float32 stream. NaN is replaced with 0.0
    # server-side (martini cannot handle NaN in the client mesh); the boundless
    # read yields 0.0 for out-of-COG cells already, but a data NaN (e.g. masked
    # nodata inside the footprint) must also resolve to 0.0 for the contract.
    el = np.asarray(arr, dtype=np.float64)
    el = np.nan_to_num(el, nan=0.0, posinf=0.0, neginf=0.0)
    body = el.astype("<f4").tobytes()
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=3600"},
    )
