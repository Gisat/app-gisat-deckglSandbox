
### `tileserver-rs` and PMTiles
`tileserver-rs` is built primarily around serving **PMTiles** (alongside MBTiles and filesystem directories of tiles) as an ultra-fast, lightweight Rust server.

Because PMTiles archives already store a pre-built, static tile pyramid (with an internal R-tree/Hilbert directory index for HTTP range requests), the architecture flips how caching usually works:

### Why MapCache + `tileserver-rs` is usually redundant

1. **No dynamic rendering overhead:** Unlike MapServer or TiTiler—which compute and render pixels on the fly from raw vector data or Cloud Optimized GeoTIFFs—`tileserver-rs` is simply extracting already-rendered bytes out of a PMTiles/MBTiles container. Putting MapCache in front of it to save CPU cycles usually adds latency rather than saving it.
2. **PMTiles is designed to be its own "cache":** The whole point of PMTiles is that you can host the `.pmtiles` file directly on static object storage (like S3, Cloudflare R2, or a local web server) and let a CDN or HTTP proxy cache individual `/z/x/y` responses via standard `Cache-Control` and `ETag` headers.

### When you *would* still put a cache in front of `tileserver-rs`

* **High-traffic S3-backed PMTiles:** If `tileserver-rs` is reading a `.pmtiles` file remotely over HTTP range requests from S3/GCS, every uncached tile request triggers byte-range fetches against object storage. Placing an HTTP cache (**Nginx**, **Varnish**, or **Cloudflare**) in front of `tileserver-rs` absorbs repeat tile hits in memory/disk and cuts S3 `GET` request costs.
* **Legacy GIS client compatibility:** If you have older desktop GIS software (like older ArcGIS or QGIS setups) that strictly requires **WMS** or **WMTS** endpoints from a PMTiles source, using MapCache (or MapProxy) in front of `tileserver-rs` bridges that protocol gap.

Are you trying to optimize performance for remote PMTiles storage, or do you need to serve legacy OGC protocols (WMS/WMTS) from your PMTiles?


### The Portable Cache Case

When you know the bounding box and zoom range ahead of time and want the entire pyramid pre-generated, **PMTiles has essentially become the modern de facto archive format** for shipping and serving that cache—replacing legacy directory trees of millions of tiny PNG/PBF files and largely superseding MBTiles for cloud-native deployments.

It solves the exact pain points traditional tile caches (like MapCache or GeoWebCache) were originally invented to manage:

* **No "millions of small files" problem:** Pre-seeding a regional bounding box across zoom levels 0–16 in a folder-based cache creates millions of tiny files, exhausting filesystem inodes and making backups or S3 uploads painfully slow. PMTiles packs the entire pyramid into a **single portable file**.
* **Built-in deduplication:** Just as MapCache uses symlinks or hashes to avoid storing identical ocean/forest/blank tiles twice, the PMTiles spec deduplicates identical tile payloads natively inside the archive—dramatically shrinking file size for regional extracts with uniform areas.
* **Zero-server or single-binary serving:** You don't need a stateful caching daemon managing cache eviction, locks, or disk tiers. You can drop the `.pmtiles` file onto S3/R2/Nginx and query it directly from MapLibre/Leaflet via HTTP Range Requests, or put a stateless binary like `tileserver-rs` or `go-pmtiles` in front of it.

### The Only Remaining Trade-offs

PMTiles is ideal for **static/versioned regional snapshots** (e.g., generating a fresh `.pmtiles` file in a batch pipeline and atomically swapping it in). The only scenarios where a dynamic cache like **MapCache** or **MapProxy** still beats PMTiles are:

1. **Continuous, piecemeal live updates:** PMTiles archives are immutable once built (you regenerate the file rather than invalidating a single dirty tile in place). If your underlying data changes every few minutes and you only want to invalidate specific bounding boxes on the fly, a dynamic tile cache with selective seeding/purging is still better.
2. **On-the-fly format/projection transforms:** If clients need dynamic reprojection (e.g., serving EPSG:3857 tiles reprojected to a local national grid like EPSG:5514 on the fly) or assembled untiled WMS `GetMap` images, a tile server/cache layer is still required on top.
