#!/usr/bin/env bash
# test-cache.sh — verify nginx tile caching in front of TiTiler.
#
# Usage:
#   bash test-cache.sh [COG_URL]            # default: Nepal Wet Snow COG
#   COG_URL="<url>" bash test-cache.sh      # or via env
#   EXTRA_PARAMS="bidx=1 rescale=0,100" bash test-cache.sh   # override tile params
#
# Self-contained: derives a valid z/x/y from TiTiler's TileJSON endpoint
# (bounds/center are always WGS84 there), so it works for any COG CRS.
set -uo pipefail

BASE="${BASE:-http://localhost:8001/api/v1/titiler}"
BASE="${BASE%/}"   # tolerate trailing slash
COG_URL="${1:-${COG_URL:-https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/WET_SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif}}"

# default tile params (Nepal demo: single-band int16 -> rescale + colormap)
PARAMS=("bidx=1" "rescale=0,300")
if [ -n "${EXTRA_PARAMS:-}" ]; then
  read -r -a PARAMS <<< "$EXTRA_PARAMS"
fi

echo "== Base : $BASE"
echo "== COG  : $COG_URL"
echo "== Parms: ${PARAMS[*]}"

# ---------------------------------------------------------------- 1. TileJSON
# NOTE: TiTiler >= 0.19 dropped the bare /cog/tilejson.json route; the
# TileMatrixSet id is now required in the path (/cog/{tms}/tilejson.json).
TJ=$(curl -sS --max-time 60 -G "$BASE/cog/WebMercatorQuad/tilejson.json" --data-urlencode "url=$COG_URL") || {
  echo "FATAL: could not reach $BASE/cog/WebMercatorQuad/tilejson.json"; exit 1; }
echo "$TJ" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null || {
  echo "FATAL: tilejson.json did not return valid JSON:"; echo "$TJ" | head -c 800; echo; exit 1; }

read -r Z X Y <<< "$(echo "$TJ" | python3 -c '
import sys, json, math
d = json.load(sys.stdin)
lon, lat, z = d["center"]
z = int(max(2, min(z, 12)))
n = 2 ** z
x = int((lon + 180.0) / 360.0 * n)
y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
print(z, x, y)
')"
if [ -z "${Z:-}" ]; then
  echo "FATAL: could not compute tile from TileJSON:"; echo "$TJ" | head -c 800; echo; exit 1
fi
echo "== Tile : $Z/$X/$Y  (from TileJSON center, zoom clamped 2..12)"

URL="$BASE/cog/tiles/WebMercatorQuad/$Z/$X/$Y.png"
echo "== URL  : $URL"
echo ""

# --------------------------------------------------- 2. MISS -> HIT -> HIT
echo "--- test 1: same tile 3x -> expect MISS, HIT, HIT ---"
# url= is a REQUIRED query param on TiTiler tile endpoints (DatasetPathParams)
QARGS=(--data-urlencode "url=$COG_URL")
for kv in "${PARAMS[@]}"; do QARGS+=(--data-urlencode "$kv"); done
for i in 1 2 3; do
  printf "req %s: " "$i"
  curl -sS --max-time 60 -o /dev/null -D - -G "$URL" "${QARGS[@]}" \
    | grep -iE "^(HTTP|x-cache-status|cache-control|content-type)" \
    | tr -d '\r' | tr '\n' ' '
  echo ""
done

# ------------------------------------------- 3. query string is the cache key
echo ""
echo "--- test 2: query string is part of cache key -> expect MISS, MISS, HIT ---"
BASE_PARAMS=()
for kv in "${PARAMS[@]}"; do
  case "$kv" in rescale=*) ;; *) BASE_PARAMS+=("$kv") ;; esac
done
for r in "0,300" "0,100" "0,300"; do
  printf "rescale=%-6s: " "$r"
  QARGS=(--data-urlencode "url=$COG_URL")
  for kv in "${BASE_PARAMS[@]}"; do QARGS+=(--data-urlencode "$kv"); done
  QARGS+=(--data-urlencode "rescale=$r")
  curl -sS --max-time 60 -o /dev/null -D - -G "$URL" "${QARGS[@]}" \
    | grep -i x-cache-status | tr -d '\r'
  echo ""
done

echo ""
echo "Done. X-Cache-Status: HIT = served from the nginx disk cache."
