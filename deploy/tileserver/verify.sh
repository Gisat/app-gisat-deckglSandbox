#!/usr/bin/env bash
# Verify the Tileserver-RS demo stack is healthy and serving the Sentinel-2
# mosaic source. Run on the Docker host after:
#   docker compose -f deploy/tileserver/docker-compose.yml restart
set -uo pipefail

BASE="${1:-http://localhost:8080}"
PASS=0
FAIL=0

check() {
    local desc="$1" cmd="$2"
    if eval "$cmd" >/dev/null 2>&1; then
        echo "PASS  $desc"
        PASS=$((PASS+1))
    else
        echo "FAIL  $desc"
        FAIL=$((FAIL+1))
    fi
}

echo "== Tileserver-RS demo stack verification (base: $BASE) =="

# 1. Health
check "health endpoint answers" \
    "curl -sf --max-time 10 '$BASE/health'"

# 2. Source list contains the demo source
check "data.json lists sentinel2-mosaic" \
    "curl -sf --max-time 10 '$BASE/data.json' | grep -q sentinel2-mosaic"
check "data.json does NOT list worldcereal" \
    "! curl -sf --max-time 10 '$BASE/data.json' | grep -q worldcereal"

# 3. TileJSON for the source
check "sentinel2-mosaic TileJSON" \
    "curl -sf --max-time 30 '$BASE/data/sentinel2-mosaic.json'"

# 4. Sentinel-2 mosaic tile (lon 26.75 lat 5.0 -> z8 147/124) is a PNG
#    Cold: STAC search + up to 5 COG renders + composite. Allow 120s.
check "sentinel2-mosaic tile z8/147/124 is PNG" \
    "curl -sf --max-time 120 -o /tmp/tsr_s2.png '$BASE/data/sentinel2-mosaic/8/147/124.png' && file /tmp/tsr_s2.png | grep -q 'PNG image data'"

# 5. Cache demonstration: repeat request must be much faster (identity cache).
#    Compares 2nd vs 1st request time on the SAME tile; requires the
#    feat/identity-raster-cache build.
T="$BASE/data/sentinel2-mosaic/8/147/124.png"
T1=$(curl -sf -o /dev/null -w '%{time_total}' --max-time 120 "$T" 2>/dev/null || echo 0)
T2=$(curl -sf -o /dev/null -w '%{time_total}' --max-time 120 "$T" 2>/dev/null || echo 0)
echo "     cache timing: req1=${T1}s req2=${T2}s (req2 should be much faster)"
if awk "BEGIN{exit !($T2 < $T1)}"; then
    echo "PASS  repeat request faster (in-process cache working)"
    PASS=$((PASS+1))
else
    echo "FAIL  repeat request not faster — cache patch missing? (published image does not cache identity PNG tiles)"
    FAIL=$((FAIL+1))
fi

# 6. Out-of-bounds tile 404s (normal, documented)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/data/sentinel2-mosaic/18/0/0.png")
if [ "$code" = "404" ]; then
    echo "PASS  out-of-zoom tile returns 404 (expected)"
    PASS=$((PASS+1))
else
    echo "WARN  out-of-zoom tile returned $code (expected 404)"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
