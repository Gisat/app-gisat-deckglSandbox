Everything is in place — the plan doc, the Rust patch with three unit tests, and the verify.sh fixes. One leftover from my side: the commits themselves. The tileserver-rs checkout has no git identity (the app repo has `JJK <jjk@users.noreply.github.com>`, and the prior cache-patch commit `407fe8c` used exactly that identity), so my commit attempt aborted. The working trees hold all changes; here's the exact finish-up.

## 1. Commit the changes (once, in your checkouts)

```sh
# tileserver-rs — renderer fix (working tree currently holds the patch, uncommitted)
cd ../tileserver-rs   # from app-gisat-deckglSandbox
git config user.name  "JJK"    # local to this repo, matches existing history
git config user.email "jjk@users.noreply.github.com"
git add crates/tileserver-rs/src/sources/cog.rs
git commit -m "fix(cog): warp-maintained destination alpha for RGB(A) sources" \
  -m "GDALReprojectImage maps only min(src,dst) NON-alpha bands 1:1. The MEM warp
destination was created without color interpretation, so a 4-band RGBA source
(e.g. Manila S2 composite, nodata_type=Alpha) mapped RGB only and the
destination alpha stayed at its MEM init value 0 — every served tile was fully
transparent (RGB present, alpha 0 everywhere).

Fix, mirroring gdalwarp -dstalpha / rio-tiler behaviour:
- >=3 source bands: 4-band u8 MEM destination, last band marked GCI_AlphaBand
  BEFORE the warp so the kernel maintains alpha from source validity (255
  where valid, 0 outside the footprint, blended at edges).
- MEM destination now u8 for non-colormap renders: the kernel writes
  byte-range alpha only into Byte bands (densities 0..1 otherwise, which a
  u8 read collapses to 1).
- 1-2 band legacy layouts unchanged (gray / R,G), still forced opaque.
- tests: RGBA keeps source alpha, RGB opaque where covered, out-of-footprint
  tiles fully transparent."

# app repo — the STAC→Manila swap + verify.sh rework + plan doc
cd ../app-gisat-deckglSandbox
git add src/maps/TileserverRS/ManilaRGB.jsx src/maps/TileserverRS/shared/endpoints.js \
        src/maps/config.js vite.config.js deploy/tileserver/
git commit -m "feat(tileserver-demo): replace failed STAC demo with proven Manila RGB COG" \
  -m "sentinel2-mosaic removed (low-zoom tiles mostly black: pixel_selection=first
picks 89-99% cloud scenes by STAC rank). manila-rgb: same 4-band RGBA COG as the
TiTiler Manila demo; requires the tileserver-rs dstalpha fix (see
deploy/tileserver/TilerserverRGBA-IP.md). verify.sh: cache timing moved to a
z14 in-footprint tile the default view never loads (z8/214/118 was warm → the
observed FAIL); out-of-footprint check expects 200+transparent PNG, not 404
(COG sources don't 404 outside bounds)."
```

## 2. The gate + rebuild on the Docker host

```sh
cd ../tileserver-rs
git log --oneline -2                # alpha fix on top of 407fe8c (identity cache)
cargo test -p tileserver-rs --lib --features raster   # THE GATE — 3 new alpha tests must pass

cd ../app-gisat-deckglSandbox
docker compose -f deploy/tileserver/docker-compose.yml up -d --build   # code changed → rebuild
docker compose -f deploy/tileserver/docker-compose.yml restart         # RAM-only cache → guaranteed cold
./deploy/tileserver/verify.sh
```

## 3. What "healthy" looks like after the rebuild

| check | expectation |
|---|---|
| `9/428/234` | opaque ≈ 42 % (TiTiler: 41.98 %; bilinear edge blending gives ±few %) |
| `14/13700/7492` | opaque 100 %, nonblack 100 % |
| `8/214/118` (outside footprint) | still fully transparent — **not** opaque black |
| `6/53/29` (app probe, overview path) | PNG with partial imagery — also validates overview colorinterp |
| app `/tileserver-manila-rgb` | visible Luzon imagery, comparable to `/titiler-demo-manila` |

If `6/53/29` comes back opaque-black outside the footprint, that's the documented risk in the plan (§10): internal overviews lacking `AlphaBand` colorinterp — inspect with `gdalinfo` on the host, then I'd extend the patch to treat band 4 as alpha whenever `band_count == 4`.

One note on your earlier verify.sh output: the `FAIL` was a warm moka entry (the z8 timing tile was the app's own initial-view tile, already fetched — hence req1 = 0.0009 s), and the `WARN` was the COG source correctly returning 200 + transparent instead of the STAC-era 404. Both checks are reworked in the commit above; the timing check is now decisive only right after a restart, as the script header states.
