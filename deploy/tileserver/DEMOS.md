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

## `eugw-lcmh` — STAC dynamic mosaic

- `EUGW_LCMH` on the openEO/VITO STAC API (`https://stac.openeo.vito.be`) is a
  **spatial tile grid**: each item is one 1500×1500 COG (EPSG:3035, 1-band
  uint8 land-cover classes), ~146k items over Europe.
- `dynamic = true` runs a per-tile bbox `POST /search`, renders the returned
  items concurrently, and composites them into a seamless class raster.
- Rendered with the GHLC class colormap (`[sources.colormap]`, discrete,
  `rescale_mode = "none"`, nodata 255 → transparent).

### Why this STAC demo works where the retired one did not

The previous `sentinel2-mosaic` source (Earth Search Sentinel-2 L2A,
`dynamic = true` + `max_items = 5` + `pixel_selection = "first"`) served
mostly-black tiles at low zoom: it was a **temporal** collection, the top-5
newest scenes for its region are 89–99 % cloud, and `first` composites by STAC
order, not cloud cover. `EUGW_LCMH` is a **spatial** grid — every item shares
one datetime and carries no `eo:cloud_cover`, so `first` simply means "the
first adjacent tile", which is exactly what a mosaic wants. A `worldcereal` COG
entry had also been removed earlier — it failed at startup registration (GDAL
`GDALOpenEx` returned NULL, "Failure writing output to destination") and the
public WorldCereal STAC API is dead.

### Asset verification (2026-10-27)

Verified against the asset bytes: real COG (128×128 tiles, full overview
pyramid 1500→750→375→188→94, IFD before data, `accept-ranges: bytes`, 206 on
Range); 1-band uint8, `GDAL_NODATA=255`; asset role is `data` (NOT Earth
Search's `visual`). Colormap values cross-checked against decoded pixels of a
real item (values 1–7, 9, 255 present, matching the GHLC value scheme).
