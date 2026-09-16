"""Terrarium elevation-tile encoder (Mapzen-style).

Serves WebMercatorQuad (EPSG:3857) {z}/{x}/{y}.png elevation tiles packed in
the Mapzen "Terrarium" format from a float32 single-band COG, read directly
with rasterio windowed reads over GDAL /vsicurl/ (no reprojection: the COG is
already EPSG:3857).

This is a SIBLING tile producer to TiTiler, not a middleman: it bypasses
TiTiler at request time and reads the same public COG directly. Endpoints are:

    /healthz                      -> {"status":"ok"}
    /{z}/{x}/{y}.png              -> terrarium-packed RGB PNG tile

It is mounted behind the same nginx as TiTiler in this stack, at
`/api/v1/terrarium/` (nginx strips that prefix, so the app sees /{z}/{x}/{y}.png).

Terrarium packing (Mapzen spec):
    encoded = floor((elev + offset) * 256)
    R = floor(encoded / 65536)         # high byte
    G = floor((encoded % 65536) / 256) # middle byte
    B = encoded % 256                  # low byte
The client decodes height = R*256 + G + B/256 + decode_offset.

Decision: clamp the elevation range to ±CLAMP (canonical Mapzen default
32768 m, set by ENCODER_CLAMP in compose; the in-file default is 16384 only as
a fallback) and pack with baseline +CLAMP, so the client's decode offset must
be -CLAMP. The current Misicuni DEM spans 0..5631 m, easily inside ±32768.
"""
import io
import os

import numpy as np
import rasterio
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from PIL import Image
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

# Elevation clamp for the packer, in metres. Everything in/out of range is
# clamped to this; the matching client decoder is offset = -CLAMP.
# The EFFECTIVE value is ENCODER_CLAMP from the caching compose file (32768,
# canonical Mapzen). 16384 here is only the fallback if that env var is unset.
CLAMP = float(os.environ.get("ENCODER_CLAMP", "16384"))

# Decimation resampling pinned to match TiTiler's tile render (bilinear for
# continuous float data), so direct-read tiles align with the TiTiler demos.
RESAMPLING = Resampling.bilinear

app = FastAPI(title="Terrarium encoder", docs_url=None, redoc_url=None)

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


def terrarium_pack(el: np.ndarray) -> np.ndarray:
    """float32 metres -> (H, W, 3) uint8 Terrarium RGB, clamped to ±CLAMP."""
    el = np.asarray(el, dtype=np.float64)
    el = np.nan_to_num(el, nan=CLAMP)
    v = np.clip(el, -CLAMP, CLAMP) + CLAMP       # 0 .. 2*CLAMP
    p = v * 256.0
    r = np.floor(p / 65536.0).astype(np.uint8)
    g = np.floor((p % 65536.0) / 256.0).astype(np.uint8)
    b = np.floor(p % 256.0).astype(np.uint8)
    return np.stack([r, g, b], axis=-1)


def get_tile(z: int, x: int, y: int) -> np.ndarray:
    ds = get_ds()
    x_min, y_min, x_max, y_max = tile_bounds(z, x, y)
    b = ds.bounds
    # Fully outside the COG footprint: return a FLAT void tile (elevation 0)
    # instead of 404. deck.gl would treat a 404 as a tile error and trip the
    # in-app error modal; a flat tile keeps the mesh continuous and just
    # flattens to sea level past the DEM boundary. (0 -> packed (64,0,0),
    # decoded 0 m.) Note: a tile that merely OVERLAPS the edge is handled by
    # the boundless read below, which pads out-of-COG cells with 0.
    if x_max <= b.left or x_min >= b.right or y_max <= b.bottom or y_min >= b.top:
        flat = np.full((TILE_SIZE, TILE_SIZE), 0.0, np.float32)
        return terrarium_pack(flat)
    win = from_bounds(x_min, y_min, x_max, y_max, ds.transform)
    # boundless=True lets the window overhang the raster edges; out-of-COG cells
    # read as 0, which the ±CLAMP packer maps to the bottom of the elevation
    # range (a flat "void" skirt at the footprint boundary — standard for a
    # bare, untextured elevation mesh).
    arr = ds.read(
        1,
        window=win,
        boundless=True,
        out_shape=(TILE_SIZE, TILE_SIZE),
        resampling=RESAMPLING,
    )
    if arr.shape != (TILE_SIZE, TILE_SIZE):
        raise HTTPException(status_code=500, detail="unexpected tile read shape")
    return terrarium_pack(arr)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/{z}/{x}/{y}.png", response_class=Response)
def tile(z: int, x: int, y: int) -> Response:
    if not (Z_MIN <= z <= Z_MAX) or x < 0 or y < 0:
        raise HTTPException(status_code=404, detail=f"tile out of range z={z}")
    rgb = get_tile(z, x, y)
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
