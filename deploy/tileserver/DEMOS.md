# Tileserver-RS demo sources

The tile sources served by the `deploy/tileserver` container. The container
itself is documented in [`../USAGE.md`](../USAGE.md); this file describes only
what the sources *are* and why they were chosen.

Both sources live in `deploy/tileserver/config.toml`.

## `manila-rgb` — true-color RGB COG

- The **same true-color RGB COG** as the TiTiler "Manila RGB" demo:
  `Manila_S2_Composite_2020022_Mercator_RGB_COG_DEFLATE.tif` — uint8 3-band,
  EPSG:3857, ~500 MB, DEFLATE.
- True RGB → no colormap; the source renders the three bands straight to a PNG
  tile. This is the **simplest possible** tileserver-rs COG demo.
- Source: remote COG on Gisat object storage, read over HTTP range requests via
  GDAL `/vsicurl/` (no local download).

## `io-lulc` — STAC dynamic mosaic

- `io-10m-annual-lulc` on the Impact Observatory STAC API
  (`https://api.impactobservatory.com/stac-aws`) is a global 10 m land-cover
  product: one COG per Sentinel-2 MGRS supercell per year (2017–2024), 9
  classes, 1-band uint8, EPSG:UTM (326xx/327xx).
- `dynamic = true` runs a per-tile bbox `/search`, renders the returned
  supercells concurrently, and composites them into a seamless class raster.
- Rendered with the standard IO 9-class colormap (`[sources.colormap]`,
  discrete, `rescale_mode = "none"`, nodata 255 → transparent).
- `datetime` is pinned to a single instant (`2024-01-01T00:00:00Z`). Unpinned,
  each `/search` returns one item per footprint *per timestep* — 8 vintages per
  cell — and the per-tile asset cap fills with one cell's history, so the
  neighbour is never opened and the tile shows a hard seam (52.9 % coverage at
  z8). Pinning also cuts the fetch work ~8×.
- `mosaic_max_assets = 64` counts places, not (place × timestep). At the z5
  floor a tile pulls a handful of full-width supercell bands, well inside 64.
  Each open handle is charged 16 MiB against the 1 GiB dataset-cache budget.
- `stac_bbox` is the collection's **true global extent**
  (`[-180, -90, 180, 90]`). The per-tile `/search` ignores it entirely, so this
  source always rendered globally; advertising a Bavaria-only box was wrong
  metadata. The UI's pan clamp and its "outside this source's bounds" warning
  both read this value, so they fired on perfectly good tiles. With the real
  extent declared, the warning is correct-by-construction for a global source.
- `minzoom = 3` is the lowest zoom the server can actually serve here. An
  earlier revision argued for 5, on the claim that z3/z4 exceed
  `render_timeout_secs` (120 s). **That was wrong**, for two recorded reasons:
  the local reproduction had a broken `PROJ_DATA` path (so every asset failed to
  open and the 404s were misread as unservable zooms), and the container timings
  were contaminated by the tester's own concurrent sessions. Re-measured in
  isolation: a single z3 tile is `200` in 8.8 s, a single z4 in 5.3 s, and a
  full **z3 viewport** (cold, 5×4 = 20 tiles) returns **20/20 `200`, zero blank,
  zero errors**, wall 29.7 s, median 21.8 s — comfortably inside the 120 s
  timeout. The app paints real LULC classes at camera z3.

  The cost is structural and worth knowing: a low-zoom tile intersects several
  **full-width** (360° lon) supercell bands, each a planet-spanning COG warped
  into EPSG:3857, so z3 runs ~20 s/tile rather than ~20 ms. That, not the
  timeout, is the real budget to watch — every open COG handle costs 16 MiB of
  the 1 GiB dataset cache (64 handles). The cold z3 burst did not exhaust it,
  but raising resolution or `maxzoom` would push it. The demo opens at z10;
  the floor is z3.

### Why UTM, and why this STAC demo works where the retired one did not

tileserver-rs warps every asset into EPSG:3857 (XYZ tiles are WebMercator by
definition). The earlier `EUGW_LCMH` source was EPSG:3035 — a conic equal-area
grid rotated relative to Mercator everywhere, so adjacent warped footprints
left growing wedge gaps when zooming out. UTM is a transverse Mercator: near a
zone's central meridian its grid is essentially axis-aligned in Mercator, so
the residual skew is negligible. Prague (14.44 °E) sits close to UTM 33N's
15 °E central meridian. Measured 2026-11-25: a z10 3×3 around Prague is 9/9
OK, 97.8 % opaque, 6 land-cover classes.

Contrast with the removed `sentinel2-mosaic` (Earth Search Sentinel-2 L2A,
`dynamic = true` + `max_items = 5` + `pixel_selection = "first"`), which served
mostly-black tiles at low zoom: it was a **temporal** scene collection, the
top-5 newest scenes for its region are 89–99 % cloud, and `first` composites by
STAC order, not cloud cover. Here every item is a cloud-free annual composite,
so `first` simply means "an adjacent supercell", which is exactly what a mosaic
wants. A `worldcereal` COG entry had also been removed earlier — it failed at
startup registration (GDAL `GDALOpenEx` returned NULL, "Failure writing output
to destination") and the public WorldCereal STAC API is dead.

### Asset verification (2026-10-27)

Verified against the asset bytes: real COG, publicly range-readable (HTTP 206,
no auth, TIFF magic `II` + `42`); 1-band uint8, `GDAL_NODATA=255`; asset role
is `data` (the asset key is `supercell`); `proj:code` is EPSG:32632/32633
(UTM 32N/33N) over Bavaria. Colormap values cross-checked against decoded
pixels of a real item (values 1–7 and 9 present, matching the IO 9-class
scheme).
