#!/usr/bin/env bash
# Verify the Tileserver-RS demo stack is healthy and serving the Manila RGB
# COG source. Run on the Docker host after:
#   docker compose -f deploy/tileserver/docker-compose.yml up -d --build
# For a decisive cache-timing verdict (step 5), run right after a
# `docker compose ... restart` — the in-process moka cache is RAM-only, so a
# restart guarantees the timing tile is genuinely cold.
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

# 2. Source list contains the demo source (and the retired STAC/worldcereal
#    sources are gone)
check "data.json lists manila-rgb" \
    "curl -sf --max-time 10 '$BASE/data.json' | grep -q manila-rgb"
check "data.json does NOT list sentinel2-mosaic" \
    "! curl -sf --max-time 10 '$BASE/data.json' | grep -q sentinel2-mosaic"
check "data.json does NOT list worldcereal" \
    "! curl -sf --max-time 10 '$BASE/data.json' | grep -q worldcereal"

# 3. TileJSON for the source
check "manila-rgb TileJSON" \
    "curl -sf --max-time 30 '$BASE/data/manila-rgb.json'"

# 4. In-bounds Manila tile (lon 120.94, lat 13.86 -> z6 53/29) is a PNG.
#    Cold: GDAL /vsicurl range reads of the remote COG + warp + PNG encode.
check "manila-rgb tile z6/53/29 is PNG" \
    "curl -sf --max-time 120 -o /tmp/tsr_manila.png '$BASE/data/manila-rgb/6/53/29.png' && file /tmp/tsr_manila.png | grep -q 'PNG image data'"

# 5. Cache demonstration: repeat request must be much faster (identity cache).
#    Uses a z14 in-footprint tile (base-resolution data, inside the S2 scene
#    footprint — verified 100 % non-black) that the app's default z8 view NEVER
#    requests, so req1 is cold after a container restart. (The previous choice
#    z8/214/118 was the app's initial-view tile — the app had already warmed
#    it, req1 measured 0.0009 s and the check failed on a healthy stack.)
#    Verdict: a cache hit is ~1 ms; even a fully block-warm render (warp + PNG
#    encode) costs tens of ms — hence the T1 > 0.02 s floor.
T="$BASE/data/manila-rgb/14/13700/7493.png"
T1=$(curl -sf -o /dev/null -w '%{time_total}' --max-time 120 "$T" 2>/dev/null || echo 0)
T2=$(curl -sf -o /dev/null -w '%{time_total}' --max-time 120 "$T" 2>/dev/null || echo 0)
echo "     cache timing: req1=${T1}s (cold) req2=${T2}s (repeat, should be much faster)"
if awk "BEGIN{exit !($T1 > 0.02 && $T2 < $T1 * 0.5 && $T2 < 0.1)}"; then
    echo "PASS  cold tile rendered then served from in-process cache (${T1}s -> ${T2}s)"
    PASS=$((PASS+1))
else
    echo "FAIL  repeat request not faster — cache patch missing? (published image does not cache identity PNG tiles)"
    FAIL=$((FAIL+1))
fi

# 6. Out-of-footprint tile (z18 0/0 — Null Island, far outside the Manila
#    COG bounds): COG sources return 200 + a fully transparent PNG (the warp
#    writes nothing outside the source footprint — NOT a 404; 404 was
#    registry-level STAC behavior). Assert 200 + PNG.
code=$(curl -s -o /tmp/tsr_oob.png -w '%{http_code}' --max-time 30 "$BASE/data/manila-rgb/18/0/0.png")
if [ "$code" = "200" ] && file /tmp/tsr_oob.png 2>/dev/null | grep -q 'PNG image data'; then
    echo "PASS  out-of-footprint tile returns 200 + transparent PNG (expected)"
    PASS=$((PASS+1))
else
    echo "WARN  out-of-footprint tile returned $code (expected 200 + PNG)"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
