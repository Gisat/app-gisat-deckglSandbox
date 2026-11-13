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
- **Compression:** Optional internal gzip per tile; smaller files than MBTiles in practice
- **Newer:** Built by Protomaps around 2022, growing fast but not yet in every desktop GIS tool

## The practical difference

| Need | Pick |
|---|---|
| Open in QGIS / Mapbox Studio / mobile SDK | **MBTiles** |
| Host tiles from S3/R2/static hosting with zero backend | **PMTiles** |
| Smallest file, fastest web delivery | **PMTiles** |
| Maximum tool compatibility today | **MBTiles** |

For your io-lulc land cover workflow: if the end goal is serving tiles on the web (even just from localhost), PMTiles is the better fit since you can serve the file with plain nginx or any static server. If you need to load it into QGIS or another desktop app, keep MBTiles — or convert between them with `pmtiles convert` as shown earlier.
