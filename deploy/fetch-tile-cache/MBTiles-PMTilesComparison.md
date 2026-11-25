Both are single-file formats for storing map tiles, but they solve different problems:

## MBTiles

- **Format:** SQLite database with a `tiles` table (`zoom_level`, `tile_column`, `tile_row`, `tile_data`)
- **Designed for:** Local/desktop use — QGIS, Mapbox Studio, mobile apps, anything that can open SQLite
- **Serving over HTTP:** Needs a server that speaks SQLite (TileServer GL, Tegola, etc.) to read the file and respond to tile requests
- **Coordinate scheme:** TMS by default (Y flipped vs. XYZ)
- **Maturity:** ~15 years old, universally supported by GIS tools

## PMTiles

- **Format:** Single archive file with a header + directory of tile offsets/lengths + concatenated tile data
- **Designed for:** Serving directly from static storage — S3, R2, GitHub Pages, nginx — with **no server-side logic**
- **Range requests:** A client fetches only the bytes it needs via HTTP `Range` headers, so one PMTiles file on a bucket *is* your tile server
- **Coordinate scheme:** Hilbert-curve ordering internally; clients handle the conversion
- **Compression:** Internal gzip applies to the directory/metadata, and per-tile compression is optional and off by default for raster. Measured 2026-11-25 on a real crawl (50 PNG tiles, Manila RGB): PMTiles was **0.8% smaller** than the MBTiles it came from, and **equal to the raw tile payload** — the only thing removed is SQLite's page/row overhead. Do not expect PMTiles to shrink PNG/JPEG tiles: those are already deflate-compressed internally, so a second gzip pass gains ~1.5% on realistic imagery and *loses* bytes on small flat tiles (measured: 256×256 imagery 11,712 B → 9,667 B; 1×1 PNG 70 B → 83 B). Real size wins come from elsewhere: identical-tile dedup, and gzip of uncompressed **MVT** payloads. Choose PMTiles for serving (range requests, no backend), not for shrinking raster files.
- **Newer:** Built by Protomaps around 2022, growing fast but not yet in every desktop GIS tool

## The practical difference

| Need | Pick |
|---|---|
| Open in QGIS / Mapbox Studio / mobile SDK | **MBTiles** |
| Host tiles from S3/R2/static hosting with zero backend | **PMTiles** |
| Smallest file, fastest web delivery | **PMTiles** |
| Maximum tool compatibility today | **MBTiles** |

For your io-lulc land cover workflow: if the end goal is serving tiles on the web (even just from localhost), PMTiles is the better fit since you can serve the file with plain nginx or any static server. If you need to load it into QGIS or another desktop app, keep MBTiles — or convert between them with `pmtiles convert` as shown earlier.
