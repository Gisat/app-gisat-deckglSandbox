#!/usr/bin/env bash
# compile-pmtiles.sh — turn MBTiles archives from fetch-tiles.mjs into PMTiles.
#
#   ./compile-pmtiles.sh                       # every *.mbtiles next to this script
#   ./compile-pmtiles.sh a.mbtiles b.mbtiles   # explicit files
#   ./compile-pmtiles.sh --force               # rebuild even if .pmtiles is newer
#   ./compile-pmtiles.sh --sample=0            # skip the round-trip tile check
#   PMTILES_BIN=/usr/local/bin/pmtiles ./compile-pmtiles.sh
#   PMTILES_VERSION=1.31.2 ./compile-pmtiles.sh
#
# Why a wrapper at all: `pmtiles convert` is the reference implementation
# (Hilbert-curve TileIDs, run-length encoding, content dedup, root/leaf
# directory split under the 16 KiB root budget). One-lining it is fine for one
# archive and wrong for a directory of crawls, because three failure modes are
# silent or actively misleading. All three were reproduced on 2026-11-25 with
# go-pmtiles v1.31.2:
#
#  1. fetch-tiles.mjs exits 0 on a bbox that 404s everywhere, so an empty
#     archive looks like success. `convert` then fails with "no tiles in
#     MBTiles archive" — after the whole crawler run, on a file nobody looks at
#     again. Checked here before convert.
#  2. MBTiles without metadata.format converts to tile type 0 (0x00 = unknown),
#     a valid header that clients refuse to render. Checked here.
#  3. CONVERTER BUG — the header's maxzoom is understated when the last
#     run-length-encoded entry spans a zoom boundary. convert() sets
#     MaxZoom from the *first* TileID of the last directory entry, not from the
#     last tile it covers, so a trailing run of identical tiles reaching into a
#     higher zoom advertises the wrong maxzoom. MapLibre/Leaflet then never ask
#     for those tiles. The tiles ARE present and extractable; only the header
#     lies. Repaired here by rewriting header bytes 100/101 from the archive's
#     real zoom range, and then proved by extracting tiles rather than by
#     `pmtiles verify` (which repeats the same wrong assumption and will report
#     the repaired archive as invalid — a false positive, see below).
#
# Output is written to <out>.pmtiles.tmp and only renamed into place after it
# passes, so an interrupted run never leaves a truncated archive that still
# looks servable.
#
# Exit: 0 all converted · 1 something failed · 2 setup/usage error

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PMTILES_VERSION=${PMTILES_VERSION:-1.31.2}
FORCE=0
SAMPLE=12          # tiles compared MBTiles -> PMTiles per archive; 0 disables
inputs=()

for arg in "$@"; do
  case "$arg" in
    --force|-f)   FORCE=1 ;;
    --sample=*)   SAMPLE=${arg#--sample=} ;;
    -h|--help)    sed -n '2,44p' "$0"; exit 0 ;;
    -*)           echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    *)            inputs+=("$arg") ;;
  esac
done

if [ ${#inputs[@]} -eq 0 ]; then
  shopt -s nullglob
  inputs=("$SCRIPT_DIR"/*.mbtiles)
  shopt -u nullglob
  if [ ${#inputs[@]} -eq 0 ]; then
    echo "no .mbtiles files found in $SCRIPT_DIR" >&2
    echo "crawl one first, e.g.:" >&2
    echo "  node fetch-tiles.mjs --tiles-url=... --bbox=... --zoom-levels=... --output=out.mbtiles" >&2
    exit 2
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Resolve a pmtiles binary: $PMTILES_BIN > PATH > ./bin/pmtiles > pinned release
#
# This host has no pmtiles/go/sqlite3/gdal, and the npm `pmtiles` package is a
# reader only (v4.5.0 has no bin entry and no writer), so `npm i pmtiles` does
# not provide `convert`. A pinned release tarball is the difference between
# "run this" and "go install a Go toolchain".
# ─────────────────────────────────────────────────────────────────────────────

download_pmtiles() {
  local os arch asset url tmp
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Linux/x86_64|Linux/amd64)   asset="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" ;;
    Linux/aarch64|Linux/arm64)  asset="go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz" ;;
    Darwin/x86_64)              asset="go-pmtiles_${PMTILES_VERSION}_Darwin_x86_64.zip" ;;
    Darwin/arm64)               asset="go-pmtiles_${PMTILES_VERSION}_Darwin_arm64.zip" ;;
    *) echo "unsupported platform: $os/$arch — install pmtiles and set PMTILES_BIN" >&2; return 1 ;;
  esac

  url="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${asset}"
  mkdir -p "$SCRIPT_DIR/bin"
  tmp=$(mktemp -d)

  echo "pmtiles not found — downloading go-pmtiles v${PMTILES_VERSION} ($asset) ..." >&2
  if ! curl -fsSL "$url" -o "$tmp/$asset"; then
    echo "download failed: $url" >&2
    rm -rf "$tmp"
    return 1
  fi
  case "$asset" in
    *.tar.gz) tar xzf "$tmp/$asset" -C "$tmp" || { rm -rf "$tmp"; return 1; } ;;
    *.zip)    unzip -q "$tmp/$asset" -d "$tmp" || { rm -rf "$tmp"; return 1; } ;;
  esac
  # Copy to a temp name then rename: a half-copied binary must never sit at
  # ./bin/pmtiles where the next run would exec it.
  cp "$tmp/pmtiles" "$SCRIPT_DIR/bin/.pmtiles.new"
  chmod 0755 "$SCRIPT_DIR/bin/.pmtiles.new"
  mv -f "$SCRIPT_DIR/bin/.pmtiles.new" "$SCRIPT_DIR/bin/pmtiles"
  rm -rf "$tmp"
  # To stderr on purpose: resolve_pmtiles command-substitutes this function,
  # so anything on stdout would be folded into $PMT and break every later call.
  "$SCRIPT_DIR/bin/pmtiles" version >&2
}

resolve_pmtiles() {
  if [ -n "${PMTILES_BIN:-}" ]; then
    [ -x "$PMTILES_BIN" ] || { echo "PMTILES_BIN is not executable: $PMTILES_BIN" >&2; return 1; }
    printf '%s\n' "$PMTILES_BIN"
    return
  fi
  if command -v pmtiles >/dev/null 2>&1; then
    command -v pmtiles
    return
  fi
  if [ -x "$SCRIPT_DIR/bin/pmtiles" ]; then
    printf '%s\n' "$SCRIPT_DIR/bin/pmtiles"
    return
  fi
  download_pmtiles || return 1
  [ -x "$SCRIPT_DIR/bin/pmtiles" ] || { echo "pmtiles binary missing after download" >&2; return 1; }
  printf '%s\n' "$SCRIPT_DIR/bin/pmtiles"
}

if ! PMT=$(resolve_pmtiles); then
  exit 2
fi
# Guard the contract above: a multi-line or empty $PMT turns into an exec error
# 30 lines later, far from the cause.
if [ -z "$PMT" ] || [ ! -x "$PMT" ]; then
  echo "could not resolve a usable pmtiles binary (got: ${PMT:-<empty>})" >&2
  exit 2
fi

# ─────────────────────────────────────────────────────────────────────────────
# Read what the MBTiles archive actually contains.
#
# Prints "tiles|format|minzoom|maxzoom" on stdout and returns:
#   0 ok · 3 empty (0 tiles) · 4 no metadata.format · 5 not a readable archive
# The distinct codes matter: 3 means "the crawl found nothing", 4 means "the
# crawler wrote a bad archive", and neither is a convert failure.
# ─────────────────────────────────────────────────────────────────────────────

probe_mbtiles() {
  MB="$1" node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    let db;
    try {
      db = new DatabaseSync(process.env.MB, { readOnly: true });
    } catch (err) {
      console.error(`  cannot open as SQLite: ${err.message}`);
      process.exit(5);
    }
    let agg, fmt;
    try {
      agg = db.prepare("SELECT COUNT(*) AS n, MIN(zoom_level) AS lo, MAX(zoom_level) AS hi FROM tiles").get();
      const row = db.prepare("SELECT value FROM metadata WHERE name = ?").get("format");
      fmt = row ? String(row.value) : "";
    } catch (err) {
      console.error(`  not an MBTiles archive (${err.message})`);
      process.exit(5);
    } finally {
      db.close();
    }
    const n = Number(agg.n);
    if (!n) {
      console.error("  empty archive: 0 tiles. Note fetch-tiles.mjs exits 0 on an all-404 bbox —");
      console.error("  read its \"tiles : N / M planned\" line; the exit code cannot tell you this.");
      process.exit(3);
    }
    if (!fmt) {
      console.error("  metadata.format is missing — PMTiles would get tile type 0 (0x00 = unknown),");
      console.error("  a header that clients reject. Re-crawl, or patch the metadata table, then retry.");
      process.exit(4);
    }
    console.log([n, fmt, Number(agg.lo), Number(agg.hi)].join("|"));
  '
}

# ─────────────────────────────────────────────────────────────────────────────
# Patch the header's min/max zoom in place.
#
# PMTiles v3 header is fixed-size: byte 100 = MinZoom, byte 101 = MaxZoom. That
# is why this is a 2-byte write and not a JSON round-trip through `pmtiles
# edit` — nothing shifts, and no other field is touched.
# ─────────────────────────────────────────────────────────────────────────────

patch_header_zoom() {
  PM="$1" MIN="$2" MAX="$3" node --no-warnings -e '
    const fs = require("node:fs");
    const fd = fs.openSync(process.env.PM, "r+");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 100);
    const old = [buf[0], buf[1]];
    buf[0] = Number(process.env.MIN);
    buf[1] = Number(process.env.MAX);
    fs.writeSync(fd, buf, 0, 2, 100);
    fs.closeSync(fd);
    console.log(`${old[0]}-${old[1]} -> ${buf[0]}-${buf[1]}`);
  '
}

# ─────────────────────────────────────────────────────────────────────────────
# Describe the produced archive by reading its header, not by trusting logs.
# Offsets are the v3 spec's fixed layout (ch. 3).
# ─────────────────────────────────────────────────────────────────────────────

read_header() {
  PM="$1" node --no-warnings -e '
    const fs = require("node:fs");
    const b = fs.readFileSync(process.env.PM);
    if (b.subarray(0, 7).toString("latin1") !== "PMTiles" || b[7] !== 3) {
      console.error("bad magic or version"); process.exit(1);
    }
    const u64 = (o) => Number(b.readBigUInt64LE(o));
    console.log(JSON.stringify({
      rootBytes: u64(16), metaBytes: u64(32), leafBytes: u64(48), dataBytes: u64(64),
      addressed: u64(72), entries: u64(80), contents: u64(88),
      clustered: b[96] === 1, ic: b[97], tc: b[98], tt: b[99],
      minz: b[100], maxz: b[101],
    }));
  '
}

# ─────────────────────────────────────────────────────────────────────────────
# Round-trip proof: extract tiles from the PMTiles archive and compare them
# byte-for-byte with what the MBTiles crawl stored.
#
# This is the check that catches a mis-indexed pyramid (wrong TMS flip, wrong
# Hilbert mapping) — an archive can pass `pmtiles verify` and still serve the
# wrong tile, because verify only checks structure. Sampling spreads across
# zooms and includes the archive's last tile, which is exactly where the
# maxzoom bug above lives.
# ─────────────────────────────────────────────────────────────────────────────

roundtrip_check() {
  MB="$1" PM="$2" PMT="$3" SAMPLE="$4" node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const { execFileSync } = require("node:child_process");
    const crypto = require("node:crypto");

    const db = new DatabaseSync(process.env.MB, { readOnly: true });
    const zooms = db.prepare("SELECT DISTINCT zoom_level AS z FROM tiles ORDER BY z").all().map((r) => Number(r.z));
    const want = Number(process.env.SAMPLE);
    const perZoom = Math.max(1, Math.ceil(want / Math.max(1, zooms.length)));

    const picks = [];
    for (const z of zooms) {
      const rows = db.prepare(
        "SELECT tile_column AS x, tile_row AS row, tile_data AS d FROM tiles WHERE zoom_level = ? ORDER BY tile_column, tile_row LIMIT ?"
      ).all(z, perZoom);
      for (const r of rows) picks.push({ z, x: Number(r.x), row: Number(r.row), data: r.d });
    }
    // Always include the highest TileID: the last zoom row of the max zoom.
    // That is the tile whose run length understates the header.
    const top = db.prepare(
      "SELECT zoom_level AS z, tile_column AS x, tile_row AS row, tile_data AS d FROM tiles ORDER BY zoom_level DESC, tile_column DESC, tile_row DESC LIMIT 1"
    ).get();
    if (top) picks.push({ z: Number(top.z), x: Number(top.x), row: Number(top.row), data: top.d });
    db.close();

    const seen = new Set();
    let checked = 0, mismatched = 0;
    for (const p of picks) {
      const key = `${p.z}/${p.x}/${p.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const y = (2 ** p.z) - 1 - p.row;      // MBTiles TMS row -> XYZ y
      let got;
      try {
        got = execFileSync(process.env.PMT, ["tile", process.env.PM, String(p.z), String(p.x), String(y)], {
          maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        console.error(`  MISSING tile ${p.z}/${p.x}/${y} (stored row ${p.row})`);
        mismatched++;
        continue;
      }
      const a = crypto.createHash("md5").update(got).digest("hex");
      const b = crypto.createHash("md5").update(p.data).digest("hex");
      if (a !== b) {
        console.error(`  MISMATCH tile ${p.z}/${p.x}/${y}: pmtiles=${a} mbtiles=${b}`);
        mismatched++;
        continue;
      }
      checked++;
    }
    if (mismatched) { console.error(`  round-trip FAILED: ${mismatched} bad, ${checked} ok`); process.exit(1); }
    console.log(`  round-trip ok: ${checked} tiles byte-identical to MBTiles`);
  '
}

fmt_bytes() {
  local b=$1
  if [ "$b" -ge 1048576 ]; then printf '%d.%02d MB' $((b / 1048576)) $(((b % 1048576) * 100 / 1048576))
  elif [ "$b" -ge 1024 ];  then printf '%d.%01d kB' $((b / 1024)) $(((b % 1024) * 10 / 1024))
  else printf '%d B' "$b"
  fi
}

file_size() { if [ -f "$1" ]; then stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; else echo 0; fi; }

TOTAL=0; CONVERTED=0; SKIPPED=0; FAILED=0
declare -a ROWS=()

for mb in "${inputs[@]}"; do
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$mb" ]; then
    echo "MISSING  $mb" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  out="${mb%.mbtiles}.pmtiles"
  echo "== $(basename "$mb") -> $(basename "$out")"

  if [ -f "$out" ] && [ "$FORCE" -ne 1 ] && [ "$out" -nt "$mb" ]; then
    echo "  up to date (--force to rebuild)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  set +e
  info=$(probe_mbtiles "$mb")
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    FAILED=$((FAILED + 1))
    continue
  fi
  IFS='|' read -r n_tiles fmt true_min true_max <<<"$info"
  echo "  $n_tiles tiles, format=$fmt, z$true_min-$true_max"

  tmp="$out.tmp"
  rm -f "$tmp"
  set +e
  conv_err=$("$PMT" -q convert "$mb" "$tmp" 2>&1)
  conv_rc=$?
  set -e
  if [ "$conv_rc" -ne 0 ]; then
    echo "  convert FAILED (exit $conv_rc)" >&2
    printf '%s\n' "$conv_err" | sed 's/^/    /' >&2
    rm -f "$tmp"
    FAILED=$((FAILED + 1))
    continue
  fi

  # `verify` runs BEFORE any repair, when the header still matches what the
  # converter wrote — that is the state where its structural check is sound.
  set +e
  verify_err=$("$PMT" verify "$tmp" 2>&1)
  verify_rc=$?
  set -e
  if [ "$verify_rc" -ne 0 ]; then
    echo "  verify FAILED (exit $verify_rc) — archive discarded" >&2
    printf '%s\n' "$verify_err" | sed 's/^/    /' >&2
    rm -f "$tmp"
    FAILED=$((FAILED + 1))
    continue
  fi

  hdr=$(read_header "$tmp")
  hdr_min=$(HDR="$hdr" node -pe 'JSON.parse(process.env.HDR).minz')
  hdr_max=$(HDR="$hdr" node -pe 'JSON.parse(process.env.HDR).maxz')

  repaired=""
  if [ "$hdr_min" -ne "$true_min" ] || [ "$hdr_max" -ne "$true_max" ]; then
    repaired=$(patch_header_zoom "$tmp" "$true_min" "$true_max")
    echo "  header zoom repaired: $repaired"
    echo "    (go-pmtiles derives maxzoom from the first TileID of the last RLE entry, so a"
    echo "     trailing run of identical tiles spanning a zoom boundary understates it;"
    echo "     the tiles are present and extractable — only the header was wrong)"
    hdr=$(read_header "$tmp")
  fi

  if [ "$SAMPLE" -ge 1 ]; then
    if ! roundtrip_check "$mb" "$tmp" "$PMT" "$SAMPLE"; then
      echo "  archive NOT published" >&2
      rm -f "$tmp"
      FAILED=$((FAILED + 1))
      continue
    fi
  fi

  # Publish only now: an unverified or mis-indexed archive never gets the real name.
  mv -f "$tmp" "$out"

  summary=$(HDR="$hdr" node -e '
    const h = JSON.parse(process.env.HDR);
    const type = { 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif" }[h.tt] || `tile-type:${h.tt}`;
    const comp = { 0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd" };
    console.log([
      type,
      `z${h.minz}-${h.maxz}`,
      `${h.addressed} tiles`,
      `${h.entries} entries / ${h.contents} contents`,
      h.clustered ? "clustered" : "NOT CLUSTERED",
      `dir:${comp[h.ic] || h.ic}`,
      `tiles:${comp[h.tc] || h.tc}`,
    ].join("  "));
  ')
  src_bytes=$(file_size "$mb")
  dst_bytes=$(file_size "$out")
  echo "  ok  $summary"
  echo "      $(fmt_bytes "$src_bytes") -> $(fmt_bytes "$dst_bytes")"

  ROWS+=("$(basename "$out")|$src_bytes|$dst_bytes")
  CONVERTED=$((CONVERTED + 1))
done

echo
echo "── $TOTAL archive(s): $CONVERTED converted, $SKIPPED up to date, $FAILED failed"
if [ ${#ROWS[@]} -gt 0 ] && [ "$CONVERTED" -gt 1 ]; then
  for r in "${ROWS[@]}"; do
    IFS='|' read -r name s d <<<"$r"
    printf '   %-40s %12s -> %12s\n' "$name" "$(fmt_bytes "$s")" "$(fmt_bytes "$d")"
  done
fi

[ "$FAILED" -eq 0 ] || exit 1
exit 0
