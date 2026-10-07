#!/usr/bin/env bash
# measure-manila-cache.sh — steady-state repeated-HIT latency comparison for
# the Manila RGB demo (/titiler-demo-manila): plain TiTiler (:8000) vs
# nginx-cached TiTiler (:8001).
#
# Same methodology as measure-ghs-cache.sh:
#   For each tile z/x/y:
#     - PLAIN  baseline:  N_PLAIN repeat requests to :8000 (live TiTiler render)
#     - CACHED warm-up:   1 request to :8001 -> assert X-Cache-Status=MISS
#     - CACHED repeated-HIT: HITS repeat requests to :8001 -> assert HIT each time
#   Aggregates median & p95 of PLAIN vs CACHED-HIT per-tile latency
#   (curl %{time_starttransfer}, ms).
#
# Manila params (from src/maps/TiTilerDemo/ManilaRGB.jsx): NONE — true-color
# uint8 3-band RGB, TiTiler serves the bands straight to PNG. So the only query
# param is `url=<COG>`; short query -> nginx caching engages.
#
# Prereqs (same as GHS): plain + caching stacks up; clean cache for clean MISS->HIT:
#   docker compose -f deploy/titiler-caching/docker-compose.yml down -v
#   docker compose -f deploy/titiler-caching/docker-compose.yml up -d
#
# Usage:
#   bash measure-manila-cache.sh
#   ZOOM=10 TILES=3 bash measure-manila-cache.sh
set -uo pipefail

PLAIN_BASE="${PLAIN_BASE:-http://localhost:8000}"
CACHED_BASE="${CACHED_BASE:-http://localhost:8001/api/v1/titiler}"
COG_URL="${COG_URL:-https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/Manila_S2_Composite_2020022_Mercator_RGB_COG_DEFLATE.tif}"
ZOOM="${ZOOM:-9}"          # grid zoom (Manila maxZoom 16; 9 gives meaty urban tiles)
TILES=${TILES:-1}          # NxN grid around map center
N_PLAIN=${N_PLAIN:-3}
HITS=${HITS:-10}
CURL="${CURL:-curl}"

# Manila is true-color RGB: no demo query params beyond the COG url itself.
TPARAMS=""

# ---------------------------------------------------------------- helpers
checkup() {
  local code
  code=$("$CURL" -sS --max-time 5 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null)
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    echo "FATAL: $1 ($2) not reachable"; exit 1
  fi
}

tj_center() { echo "$1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
lon, lat, z = d["center"]
print(lon, lat, int(z))
'; }

tile_xy() { echo "$1 $2 $3" | python3 -c '
import sys, math
lon, lat, z = map(float, sys.stdin.read().split())
n = 2 ** int(z)
x = int((lon + 180.0) / 360.0 * n)
y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
print(x, y)
'; }

time_tile() { # $1 base, $2 z, $3 x, $4 y
  local urlencoded url headerf code ms xs
  urlencoded=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$COG_URL")
  # Manila has no extra params; join only if TPARAMS is non-empty.
  if [ -n "$TPARAMS" ]; then
    url="$1/cog/tiles/WebMercatorQuad/$2/$3/$4.png?url=$urlencoded&$TPARAMS"
  else
    url="$1/cog/tiles/WebMercatorQuad/$2/$3/$4.png?url=$urlencoded"
  fi
  headerf=$(mktemp)
  read -r code ms <<< "$("$CURL" -sS --max-time 60 -o /dev/null -D "$headerf" \
    -w '%{http_code} %{time_starttransfer}' \
    -H 'Accept-Encoding: identity' "$url" 2>/dev/null)"
  xs=$(grep -i '^x-cache-status:' "$headerf" | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r')
  rm -f "$headerf"
  [ -n "$xs" ] || xs='-'
  echo "$code $(python3 -c 'import sys;print(round(float(sys.argv[1])*1000,2))' "$ms")" "$xs"
}

# ------------------------------------------------------------------ main
echo "== Plain  : $PLAIN_BASE"
echo "== Cached : $CACHED_BASE"
echo "== COG    : $COG_URL"
echo "== Params : (none — true-color RGB)"
checkup "plain" "$PLAIN_BASE/healthz"
checkup "cached" "$CACHED_BASE/healthz"
echo "== both stacks reachable"

TJ=$("$CURL" -sS --max-time 60 -G "$CACHED_BASE/cog/WebMercatorQuad/tilejson.json" --data-urlencode "url=$COG_URL")
read -r CLON CLAT CZ <<< "$(tj_center "$TJ")"
read -r CX CY <<< "$(tile_xy "$CLON" "$CLAT" "$ZOOM")"
echo "== Map center: $CLON,$CLAT (tile $ZOOM/$CX/$CY)"

mapfile -t COORDS < <(python3 - "$TILES" "$ZOOM" "$CX" "$CY" <<'PY'
import sys
n, z, cx, cy = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
half = n // 2
mx = 2**z - 1
for oy in range(-half, half + n % 2):
    for ox in range(-half, half + n % 2):
        print(f"{z} {max(0,min(mx,cx+ox))} {max(0,min(mx,cy+oy))}")
PY
)
echo "== Tiles to measure: ${#COORDS[@]} (zoom $ZOOM)"

plain_ms=()
cached_hit_ms=()

for tc in "${COORDS[@]}"; do
  read -r Z X Y <<< "$tc"
  echo ""
  echo "--- tile $Z/$X/$Y ---"

  for i in $(seq 1 "$N_PLAIN"); do
    read -r c ms xs <<< "$(time_tile "$PLAIN_BASE" "$Z" "$X" "$Y")"
    plain_ms+=( "$ms" )
    printf "  plain   req%d: %sms (http %s)\n" "$i" "$ms" "$c"
  done

  read -r c ms xs <<< "$(time_tile "$CACHED_BASE" "$Z" "$X" "$Y")"
  printf "  cached  warmup: %sms (http %s) cache=%s (expect MISS)\n" "$ms" "$c" "$xs"
  if [ "${xs}" != "MISS" ]; then
    echo "  !! expected MISS on warm-up but got '$xs' — cache not clean, results unreliable"
  fi

  for i in $(seq 1 "$HITS"); do
    read -r c ms xs <<< "$(time_tile "$CACHED_BASE" "$Z" "$X" "$Y")"
    cached_hit_ms+=( "$ms" )
    jit=$([ "${xs}" = "HIT" ] && echo "" || echo " !!NOT-HIT(${xs})")
    printf "  cached  hit %2d: %sms (http %s) cache=%s%s\n" "$i" "$ms" "$c" "$xs" "$jit"
  done
done

# ------------------------------------------------------------- aggregate
echo ""
echo "================================================================"
echo "AGGREGATE — per-tile server latency (time_starttransfer, ms)"
echo "  plain (live render)   : ${#plain_ms[@]} samples"
echo "  cached HIT (nginx)    : ${#cached_hit_ms[@]} samples"
python3 - "${plain_ms[*]}" "${cached_hit_ms[*]}" <<'PY'
import sys, statistics
def stats(s):
    v = [float(x) for x in s.split() if x.strip()]
    if not v: return None
    v.sort()
    return {"n": len(v), "median": statistics.median(v),
            "p95": v[min(len(v)-1, int(len(v)*0.95))],
            "min": v[0], "max": v[-1]}
p, c = stats(sys.argv[1]), stats(sys.argv[2])
if not p or not c:
    print("FATAL: no samples gathered"); sys.exit(1)
def line(t, s): print(f"  {t:<10} n={s['n']:<4} median={s['median']:8.2f}ms  p95={s['p95']:8.2f}ms  [min {s['min']:.2f}, max {s['max']:.2f}]")
line("PLAIN", p); line("CACHED-HIT", c)
saved = p["median"] - c["median"]
pct = (saved / p["median"] * 100) if p["median"] else 0
psaved = p["p95"] - c["p95"]
ppct = (psaved / p["p95"] * 100) if p["p95"] else 0
print(f"  --> median time saved per tile: {saved:7.2f}ms  ({pct:5.1f}% faster than plain)")
print(f"      p95 time saved per tile:    {psaved:7.2f}ms  ({ppct:5.1f}%)")
sys.exit(0 if saved >= 0 else 2)
PY
