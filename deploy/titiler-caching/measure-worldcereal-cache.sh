#!/usr/bin/env bash
# measure-worldcereal-cache.sh — steady-state repeated-HIT latency comparison
# for the WorldCereal active-cropland demo (/titiler-demo-worldcereal):
# plain TiTiler (:8000) vs nginx-cached TiTiler (:8001).
#
# Same methodology as measure-ghs-cache.sh:
#   For each tile z/x/y:
#     - PLAIN  baseline:  N_PLAIN repeat requests to :8000 (live TiTiler render)
#     - CACHED warm-up:   1 request to :8001 -> assert X-Cache-Status=MISS
#     - CACHED repeated-HIT: HITS repeat requests to :8001 -> assert HIT each time
#   Aggregates median & p95 of PLAIN vs CACHED-HIT per-tile latency
#   (curl %{time_starttransfer}, ms).
#
# WorldCereal params (from src/maps/TiTilerDemo/WorldCereal.jsx):
#   bidx=1&colormap=<4-entry categorical JSON, 0/100 opaque, 254/255 transparent>
# The colormap is derived from the JSX source (never a hand-typed copy). It is a
# small 4-entry map, so the query stays short and nginx caching engages.
#
# Prereqs (same as GHS): plain + caching stacks up; clean cache for MISS->HIT:
#   docker compose -f deploy/titiler-caching/docker-compose.yml down -v
#   docker compose -f deploy/titiler-caching/docker-compose.yml up -d
#
# Usage:
#   bash measure-worldcereal-cache.sh
#   ZOOM=10 TILES=3 bash measure-worldcereal-cache.sh
set -uo pipefail

PLAIN_BASE="${PLAIN_BASE:-http://localhost:8000}"
CACHED_BASE="${CACHED_BASE:-http://localhost:8001/api/v1/titiler}"
COG_URL="${COG_URL:-https://gisat-data.eu-central-1.linodeobjects.com/WorldCereal_GST-10/project/demo/merged_cog.tif}"
ZOOM="${ZOOM:-8}"          # grid zoom (COG tiled to 14; 8 gives meaty tiles over Africa/EU/ME)
TILES=${TILES:-1}          # NxN grid around map center
N_PLAIN=${N_PLAIN:-3}
HITS=${HITS:-10}
CURL="${CURL:-curl}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WORLDCEREAL="$SCRIPT_DIR/../../src/maps/TiTilerDemo/WorldCereal.jsx"

# Derive the exact demo query params from WorldCereal.jsx:
#   bidx=1&colormap=<JSON.stringify({...})>
# The object literal uses JS syntax (unquoted int keys, trailing commas, inline
# // comments), so parse key: [r,g,b,a] pairs by regex instead of json.loads.
COLMAP_URLENC="$(python3 - "$WORLDCEREAL" <<'PY'
import sys, json, urllib.parse, re
src = open(sys.argv[1]).read()
m = re.search(r'JSON\.stringify\((\{.*?\})\);', src, re.S)
if not m:
    raise SystemExit("FATAL: could not parse COLORMAP from WorldCereal.jsx")
blk = re.sub(r'//[^\n]*', '', m.group(1))                      # strip // comments
pairs = re.findall(r'(\d+)\s*:\s*\[([\d,\s]+)\]', blk)        # key: [r,g,b,a]
cm = {k: [int(x) for x in v.split(',')] for k, v in pairs}
s = json.dumps(cm, separators=(",", ":"))
print(urllib.parse.quote(s, safe=""))
PY
)"
if [ -z "${COLMAP_URLENC:-}" ]; then
  echo "FATAL: could not derive WorldCereal colormap"; exit 1
fi
TPARAMS="bidx=1&colormap=$COLMAP_URLENC"

# ---------------------------------------------------------------- helpers
checkup() { # $1 label, $2 health url
  local code
  code=$("$CURL" -sS --max-time 5 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null)
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    echo "FATAL: $1 ($2) not reachable"; exit 1
  fi
}

# tilejson -> center lon/lat/z
tj_center() { echo "$1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
lon, lat, z = d["center"]
print(lon, lat, int(z))
'; }

# lon/lat/z -> x/y
tile_xy() { echo "$1 $2 $3" | python3 -c '
import sys, math
lon, lat, z = map(float, sys.stdin.read().split())
n = 2 ** int(z)
x = int((lon + 180.0) / 360.0 * n)
y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
print(x, y)
'; }

# time one tile request; echo "<status> <ms> <x-cache-status>"
time_tile() { # $1 base, $2 z, $3 x, $4 y
  local urlencoded url headerf code ms xs
  urlencoded=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$COG_URL")
  url="$1/cog/tiles/WebMercatorQuad/$2/$3/$4.png?url=$urlencoded&$TPARAMS"
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
echo "== Params : bidx=1&colormap=<4-entry categorical from WorldCereal.jsx>"
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
