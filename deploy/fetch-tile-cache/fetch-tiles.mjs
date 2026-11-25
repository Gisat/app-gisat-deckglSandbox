#!/usr/bin/env node
/**
 * fetch-tiles.mjs — bulk-download a {z}/{x}/{y} tile endpoint into an MBTiles archive.
 *
 * Zero dependencies (Node >= 22: global fetch + node:sqlite).
 *
 *   ./fetch-tiles.mjs \
 *     --tiles-url="http://localhost:8080/data/io-lulc/{z}/{x}/{y}.png" \
 *     --bbox=11.2,47.9,11.9,48.4 --zoom-levels=3-14 \
 *     --output=io-lulc.mbtiles
 *
 * Design notes (all measured against tileserver-rs, 2026-11):
 *
 *  - A tile server may answer OUT-OF-BOUNDS requests with 200 + a fully
 *    rendered BLANK tile (tileserver-rs does exactly this), so a raw bbox over a
 *    small source can mean millions of pointless requests (measured: 3,649,272
 *    raw vs 1,592 inside the source bounds, same request). Default policy is to
 *    crawl the bbox you ASKED for; --debug-bbox intersects it with the source's
 *    advertised TileJSON bounds/minzoom/maxzoom when you want to see - or avoid
 *    - that difference. Blank tiles are dropped either way by a real
 *    pixel-alpha check.
 *  - Blankness cannot be inferred from HTTP status, and NOT from byte size
 *    (observed blank tiles at both 3 KB and 87 KB, with distinct hashes).
 *  - Render cost is non-uniform across zoom: low zooms fan out over many
 *    source COGs (z3 ≈ 8.6 s/tile) while high zooms read one small window
 *    (z12 ≈ 0.2 s). We therefore crawl ascending so failures surface early and
 *    the expensive zooms are not buried at the end of a long run.
 *  - MBTiles stores XYZ flipped to TMS: tile_row = 2^z - 1 - y. Getting this
 *    wrong yields a file that opens fine and is upside down.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

// Process exit codes — documented in USAGE, enforced in main().
const EXIT = {
  OK: 0,          // archive written (possibly with 404/no-coverage skips)
  FATAL: 1,       // could not complete (I/O, DB, unhandled error)
  USAGE: 2,       // bad arguments
  TILE_ERRORS: 3, // archive written, but some tiles failed after retries
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `
fetch-tiles.mjs — download {z}/{x}/{y} tiles into an MBTiles file

Required:
  --tiles-url=<url>        Tile URL template, e.g. http://host/data/src/{z}/{x}/{y}.png
  --bbox=<w,s,e,n>         Geographic bbox in WGS84 degrees (lon,lat,lon,lat)
  --zoom-levels=<spec>     e.g. "3-14", "0-5,8,10-12"
  --output=<file.mbtiles>  Destination archive

Optional:
  --concurrency=<n>        Parallel tile requests across all zooms (default 8, max 32)
  --tilejson=<url>         TileJSON URL used by --debug-bbox.
                           Default: derived from --tiles-url (.../src/{z}/{x}/{y}.png -> .../src.json)
  --debug-bbox             Intersect --bbox with the source's TileJSON bounds and
                           clamp zooms to its minzoom/maxzoom, printing what changed.
                           Diagnostic: the default crawls the raw bbox as given.
  --skip-empty / --no-skip-empty
                           Drop fully transparent tiles (default: drop)
  --resume / --no-resume   Continue an existing archive, or abort if present
                           (default: resume)
  --force                  Delete existing output/partial files and start over
  --passes=<n>             Crawl passes; pass N+1 fetches ONLY the misses left by
                           pass N (default 2). Within a pass there are no retries.
  --misses=<file>          Where to write the miss list (default <output>.misses.txt)
  --format=<png|jpg|webp|avif>
                           MBTiles metadata format (default: from the URL suffix)
  --name=<text>            Archive name written to metadata (default: output filename)
  --from-misses=<file>     Crawl ONLY the tiles listed in a misses file, ignoring
                           --bbox/--zoom-levels. Use for a manual extra pass.
  --timeout=<ms>           Per-request timeout (default 30000)
  --header=<"K: V">        Extra request header; repeatable
  --dry-run                Print the plan (per-zoom tile counts) and exit
  --verbose                Log every failed tile as it happens
  --selftest               Run offline geometry + PNG assertions and exit (no network)
  --blank-check=<file>     Report whether one PNG would be treated as blank, then exit
  -h, --help               This text

Exit codes: 0 ok · 1 fatal · 2 bad arguments · 3 completed with tile errors
`;

// Flags that require a value. Declared apart from the switch so a bare flag can
// be reported correctly: "missing value for --bbox" is a typo you can fix, while
// "unknown option: --no-clip" is a flag that no longer exists. Without this
// split, a removed flag claims it wants a value and sends you chasing syntax.
const VALUE_FLAGS = new Set([
  'tiles-url', 'bbox', 'zoom-levels', 'output', 'tilejson', 'concurrency',
  'passes', 'misses', 'from-misses', 'timeout', 'header', 'format', 'name',
]);

function parseArgs(argv) {
  const opts = {
    concurrency: 8,
    passes: 2,
    timeout: 30000,
    headers: {},
    debugBbox: false,
    skipEmpty: true,
    resume: true,
    force: false,
    dryRun: false,
    verbose: false,
  };
  for (const raw of argv) {
    if (raw === '-h' || raw === '--help') { process.stdout.write(USAGE); process.exit(0); }
    if (raw === '--dry-run') { opts.dryRun = true; continue; }
    if (raw === '--verbose') { opts.verbose = true; continue; }
    if (raw === '--debug-bbox') { opts.debugBbox = true; continue; }
    // Affirmative forms are accepted as explicit no-ops: both default to true,
    // and typing --resume/--skip-empty should not be an error.
    if (raw === '--skip-empty') { opts.skipEmpty = true; continue; }
    if (raw === '--skip-empty') { opts.skipEmpty = true; continue; }
    if (raw === '--no-skip-empty') { opts.skipEmpty = false; continue; }
    if (raw === '--resume') { opts.resume = true; continue; }
    if (raw === '--no-resume') { opts.resume = false; continue; }
    if (raw === '--force') { opts.force = true; continue; }
    if (!raw.startsWith('--')) throw new UsageError(`unexpected argument: ${raw}`);

    const eq = raw.indexOf('=');
    if (eq === -1) {
      const bare = raw.slice(2);
      if (VALUE_FLAGS.has(bare)) throw new UsageError(`missing value for ${raw} (use ${raw}=...)`);
      throw new UsageError(`unknown option: ${raw}`);
    }
    const key = raw.slice(2, eq);
    const val = raw.slice(eq + 1);

    switch (key) {
      case 'tiles-url': opts.tilesUrl = val; break;
      case 'bbox': opts.bbox = val; break;
      case 'zoom-levels': opts.zoomLevels = val; break;
      case 'output': opts.output = val; break;
      case 'tilejson': opts.tilejson = val; break;
      case 'concurrency': opts.concurrency = intArg(key, val, 1, 32); break;
      case 'passes': opts.passes = intArg(key, val, 1, 10); break;
      case 'misses': opts.misses = val; break;
      case 'format': opts.format = val; break;
      case 'name': opts.name = val; break;
      case 'from-misses': opts.fromMisses = val; break;
      case 'timeout': opts.timeout = intArg(key, val, 1000, 600000); break;
      case 'header': {
        const c = val.indexOf(':');
        if (c === -1) throw new UsageError(`--header expects "Name: value", got "${val}"`);
        opts.headers[val.slice(0, c).trim()] = val.slice(c + 1).trim();
        break;
      }
      default: throw new UsageError(`unknown option: --${key}`);
    }
  }

  // --from-misses supplies the tile list, so bbox/zoom-levels are not needed.
  const required = opts.fromMisses
    ? ['tilesUrl', 'output']
    : ['tilesUrl', 'bbox', 'zoomLevels', 'output'];
  const missing = required.filter((k) => !opts[k]);
  if (missing.length) throw new UsageError(`missing required: ${missing.map((m) => '--' + kebab(m)).join(', ')}`);

  if (!opts.misses) opts.misses = opts.output + '.misses.txt';
  return opts;
}

class UsageError extends Error {}

function kebab(s) { return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); }

function intArg(key, val, lo, hi) {
  const n = Number(val);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new UsageError(`--${key} must be an integer ${lo}..${hi}, got "${val}"`);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry: slippy tile math
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LAT = 85.05112877980659; // WebMercator limit

function parseBbox(str) {
  const parts = str.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new UsageError(`--bbox needs 4 numbers "w,s,e,n", got "${str}"`);
  }
  let [w, s, e, n] = parts;
  if (s > n) [s, n] = [n, s];
  if (w > e) [w, e] = [e, w];
  if (s < -MAX_LAT || n > MAX_LAT) {
    throw new UsageError(`--bbox latitudes must be within ±85.0511 (WebMercator limit)`);
  }
  if (w < -180 || e > 180) throw new UsageError(`--bbox longitudes must be within ±180`);
  return { w, s, e, n };
}

function parseZoomLevels(str) {
  const set = new Set();
  for (const chunk of str.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) {
      let a = Number(m[1]), b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      for (let z = a; z <= b; z++) set.add(z);
    } else if (/^\d+$/.test(part)) {
      set.add(Number(part));
    } else {
      throw new UsageError(`bad zoom spec "${part}" (want "3-14", "8", or a comma list)`);
    }
  }
  if (!set.size) throw new UsageError('--zoom-levels produced no zoom levels');
  const bad = [...set].filter((z) => z < 0 || z > 30);
  if (bad.length) throw new UsageError(`zoom levels out of range 0..30: ${bad.join(', ')}`);
  return [...set].sort((a, b) => a - b);
}

const lonToXf = (lon, z) => ((lon + 180) / 360) * 2 ** z;
function latToYf(lat, z) {
  const r = (Math.max(Math.min(lat, MAX_LAT), -MAX_LAT) * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
}

/**
 * Tile range covering a bbox at zoom z.
 *
 * Uses floor for the min edge and ceil-1 for the max edge: a bbox that ends
 * exactly on a tile boundary must not pull in the next column/row, and a bbox
 * that only clips the corner of a tile must still include it. Truncating both
 * ends with int()/floor() drops the eastern and southern edge tiles.
 */
function tileRange(bbox, z) {
  const n = 2 ** z;
  const clamp = (v) => Math.min(Math.max(v, 0), n - 1);

  const x0 = clamp(Math.floor(lonToXf(bbox.w, z)));
  const x1 = clamp(Math.ceil(lonToXf(bbox.e, z)) - 1);
  const y0 = clamp(Math.floor(latToYf(bbox.n, z)));
  const y1 = clamp(Math.ceil(latToYf(bbox.s, z)) - 1);

  const nx = Math.max(1, x1 - x0 + 1);
  const ny = Math.max(1, y1 - y0 + 1);
  return { x0, x1: x0 + nx - 1, y0, y1: y0 + ny - 1, nx, ny, count: nx * ny };
}

const flipY = (z, y) => 2 ** z - 1 - y; // XYZ -> TMS

// ─────────────────────────────────────────────────────────────────────────────
// TileJSON: what the source actually serves (used by --debug-bbox)
// ─────────────────────────────────────────────────────────────────────────────

function deriveTilejsonUrl(tilesUrl) {
  // .../data/io-lulc/{z}/{x}/{y}.png  ->  .../data/io-lulc.json
  const stripped = tilesUrl.replace(/\/\{z\}\/\{x\}\/\{y\}(\.[A-Za-z0-9]+)?\/?$/, '');
  if (stripped === tilesUrl) return null;
  return stripped + '.json';
}

async function fetchTilejson(url, headers, timeout) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function intersectBbox(a, b) {
  if (!Array.isArray(b) || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return null;
  const w = Math.max(a.w, b[0]);
  const s = Math.max(a.s, b[1]);
  const e = Math.min(a.e, b[2]);
  const n = Math.min(a.n, b[3]);
  if (w >= e || s >= n) return null;
  return { w, s, e, n };
}

class EmptyPlanError extends Error {}

/**
 * Resolve what we will crawl.
 *
 * Default: the requested bbox and zooms, exactly as given.
 * --debug-bbox: intersect/clamp both to what the source advertises in its
 * TileJSON, and report every adjustment.
 *
 * Why clip: a tile server happily answers requests outside its coverage (with a
 * rendered blank or a 404). Crawling a continent-sized bbox against a source that
 * covers one Alpine city is millions of pointless requests. Measured on io-lulc:
 * sample bbox 0,30,30,60 z3-14 = 3,649,272 tiles vs 1,592 inside the source
 * bounds - a 2300x difference.
 *
 * Failure policy: if the TileJSON cannot be fetched, WARN and fall back to the
 * raw bbox. Never silently clip to nothing, and never fail the run just because
 * we could not read the metadata.
 */
async function resolvePlan(opts) {
  if (!/\{z\}/.test(opts.tilesUrl) || !/\{x\}/.test(opts.tilesUrl) || !/\{y\}/.test(opts.tilesUrl)) {
    throw new UsageError(`--tiles-url must contain {z}, {x} and {y}: got "${opts.tilesUrl}"`);
  }

  const requestedBox = parseBbox(opts.bbox);
  const requestedZooms = parseZoomLevels(opts.zoomLevels);

  const notes = [];
  let box = requestedBox;
  let zooms = requestedZooms;
  let tilejson = null;
  let tilejsonUrl = null;

  if (opts.debugBbox) {
    tilejsonUrl = opts.tilejson || deriveTilejsonUrl(opts.tilesUrl);
    if (!tilejsonUrl) {
      notes.push('warn: cannot derive a TileJSON URL from --tiles-url; crawling the raw bbox');
    } else {
      tilejson = await fetchTilejson(tilejsonUrl, opts.headers, opts.timeout);
      if (!tilejson) {
        notes.push(`warn: TileJSON unavailable at ${tilejsonUrl}; crawling the raw bbox`);
        notes.push('      (drop --debug-bbox to crawl the raw bbox, or --tilejson=<url> to point elsewhere)');
        tilejsonUrl = null;
      }
    }
  }

  if (tilejson) {
    // --- bbox: intersect with the advertised bounds ----------------------
    if (Array.isArray(tilejson.bounds) && tilejson.bounds.length === 4) {
      const clipped = intersectBbox(requestedBox, tilejson.bounds);
      if (!clipped) {
        throw new EmptyPlanError(
          `requested bbox ${fmtBox(requestedBox)} does not intersect the source bounds ` +
          `${fmtBox({ w: tilejson.bounds[0], s: tilejson.bounds[1], e: tilejson.bounds[2], n: tilejson.bounds[3] })} ` +
          `advertised by ${tilejsonUrl}`);
      }
      if (!sameBox(clipped, requestedBox)) {
        notes.push(`clipped bbox ${fmtBox(requestedBox)} -> source bounds ${fmtBox(clipped)}`);
      }
      box = clipped;
    } else {
      notes.push('note: TileJSON has no usable "bounds"; using the raw bbox');
    }

    // --- zooms: clamp to [minzoom, maxzoom] -----------------------------
    const srcMin = Number.isInteger(tilejson.minzoom) ? tilejson.minzoom : null;
    const srcMax = Number.isInteger(tilejson.maxzoom) ? tilejson.maxzoom : null;
    const kept = zooms.filter((z) => (srcMin === null || z >= srcMin) && (srcMax === null || z <= srcMax));
    if (!kept.length) {
      throw new EmptyPlanError(
        `no requested zoom level is served by the source ` +
        `(requested ${requestedZooms.join(',')}, source serves ${srcMin}-${srcMax})`);
    }
    const dropped = zooms.filter((z) => !kept.includes(z));
    if (dropped.length) {
      notes.push(`clamped zooms ${zooms.join(',')} -> ${kept.join(',')} ` +
                 `(source serves ${srcMin}-${srcMax}); dropped ${dropped.join(',')}`);
    }
    zooms = kept;
  }

  // --- build the per-zoom plan ------------------------------------------
  const perZoom = [];
  let total = 0;
  for (const z of zooms) {
    const r = tileRange(box, z);
    perZoom.push({ z, ...r });
    total += r.count;
  }
  if (total === 0) throw new EmptyPlanError('the plan contains no tiles');

  return { box, requestedBox, zooms, requestedZooms, perZoom, total, tilejson, tilejsonUrl, notes };
}

function fmtBox(b) {
  return `${b.w},${b.s},${b.e},${b.n}`;
}

function sameBox(a, b) {
  const eps = 1e-9;
  return Math.abs(a.w - b.w) < eps && Math.abs(a.s - b.s) < eps &&
         Math.abs(a.e - b.e) < eps && Math.abs(a.n - b.n) < eps;
}

/** Human-readable plan, printed by --dry-run and at the start of a crawl. */
function printPlan(plan, opts, out) {
  const w = (s) => out.write(s + '\n');
  if (opts.debugBbox) {
    w(`source  : ${plan.tilejsonUrl || '<unavailable: crawling the raw bbox>'}`);
  } else {
    w('source  : <not consulted: raw bbox> (--debug-bbox intersects with source bounds)');
  }
  w(`bbox    : ${fmtBox(plan.box)}${sameBox(plan.box, plan.requestedBox) ? '' : `   (requested ${fmtBox(plan.requestedBox)})`}`);
  w(`zooms   : ${plan.zooms[0]}-${plan.zooms[plan.zooms.length - 1]}${plan.zooms.length === plan.requestedZooms.length ? '' : `   (requested ${plan.requestedZooms.join(',')})`}`);
  for (const n of plan.notes) w(n);
  w('');
  for (const r of plan.perZoom) {
    w(`  z${String(r.z).padEnd(2)} x ${String(r.x0).padStart(5)}-${String(r.x1).padStart(5)} (${String(r.nx).padStart(5)})` +
      `  y ${String(r.y0).padStart(5)}-${String(r.y1).padStart(5)} (${String(r.ny).padStart(5)})` +
      `  = ${String(r.count).padStart(9)} tiles`);
  }
  w(`TOTAL ${plan.total.toLocaleString('en-US')} tiles`);
  // No fabricated rate. A cold crawl against an uncached COG renderer is
  // dominated by source latency (measured 0.23-5 s per tile here), so an ETA
  // before the first tile is guesswork. The live crawl prints a real rate.
  w('estimate: none yet - first run for this bbox; the crawl reports a live rate');
}

// ─────────────────────────────────────────────────────────────────────────────
// Blank-tile detection: decode PNG alpha channel (stdlib only)
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG colour-type -> channels per pixel
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Minimal PNG container reader: header + IDAT concat + palette/tRNS.
 * Returns null on anything malformed — callers treat null as "not blank".
 */
function readPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;

  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (pos + 12 + len > buf.length) return null;         // truncated chunk
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const dataStart = pos + 8;

    if (type === 'IHDR') {
      if (len !== 13) return null;
      ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        compression: buf[dataStart + 10],
        filterMethod: buf[dataStart + 11],
        interlace: buf[dataStart + 12],
      };
      if (ihdr.width === 0 || ihdr.height === 0) return null;
      if (ihdr.compression !== 0 || ihdr.filterMethod !== 0) return null;
      if (!(ihdr.colorType in PNG_CHANNELS)) return null;
    } else if (type === 'PLTE') {
      plte = Buffer.from(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'tRNS') {
      trns = Buffer.from(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(buf.subarray(dataStart, dataStart + len)));
    } else if (type === 'IEND') {
      break;
    }

    pos += 12 + len;
  }

  if (!ihdr || idat.length === 0) return null;
  return { ihdr, plte, trns, data: Buffer.concat(idat) };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverses per-scanline PNG filtering (types 0-4). Returns the unfiltered
 * pixel bytes, or null if the data does not match the declared geometry.
 */
function unfilterScanlines(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) return null;

  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const cur = out.subarray(y * stride, (y + 1) * stride);

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;   // left
      const b = prev[i];                       // above
      const c = i >= bpp ? prev[i - bpp] : 0;  // upper-left
      const x = raw[lineStart + i];
      let v;
      switch (filterType) {
        case 0: v = x; break;
        case 1: v = (x + a) & 0xff; break;
        case 2: v = (x + b) & 0xff; break;
        case 3: v = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (x + paethPredictor(a, b, c)) & 0xff; break;
        default: return null;                  // invalid filter type
      }
      cur[i] = v;
    }
    prev = cur;
  }
  return out;
}

/**
 * True only when the tile is PROVABLY fully transparent.
 *
 * Design (measured against tileserver-rs, 2026-11):
 *   - A tile server answers out-of-coverage requests with 200 + a rendered
 *     blank tile. Blankness cannot be read off the HTTP status, and NOT off the
 *     byte size (observed blanks at 3 KB and 87 KB, with distinct hashes).
 *   - "Non-black" is the WRONG test: a real sparse tile can be 0.87 % non-black
 *     with only 153 opaque pixels out of 65,536. Prior versions dropped those.
 *   - The alpha channel IS the right test: every tile this server emits is
 *     256x256 8-bit RGBA, and blank tiles have all 65,536 alphas == 0.
 *
 * Conservative by construction: anything we cannot decode or cannot prove
 * transparent returns false, so a real tile is never silently discarded.
 * Interlaced (Adam7) images return false — we do not de-interlace.
 */
function isBlankPng(buf) {
  let png;
  try {
    png = readPng(buf);
  } catch {
    return false;                              // malformed -> keep the tile
  }
  if (!png) return false;

  const { width, height, bitDepth, colorType, interlace } = png.ihdr;
  if (interlace !== 0) return false;

  const channels = PNG_CHANNELS[colorType];

  // --- alpha-bearing direct colour: colour type 4 (gray+alpha) or 6 (RGBA) ---
  if ((colorType === 4 || colorType === 6) && (bitDepth === 8 || bitDepth === 16)) {
    const bytesPerSample = bitDepth / 8;
    const bpp = channels * bytesPerSample;

    let raw;
    try {
      raw = zlib.inflateSync(png.data);
    } catch {
      return false;
    }

    const px = unfilterScanlines(raw, width, height, bpp);
    if (!px) return false;

    const alphaOffset = bpp - bytesPerSample;   // alpha is the LAST channel
    const stride = width * bpp;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = y * stride + x * bpp + alphaOffset;
        for (let k = 0; k < bytesPerSample; k++) {
          if (px[off + k] !== 0) return false;  // any non-zero alpha -> not blank
        }
      }
    }
    return true;
  }

  // --- palette with a tRNS chunk: blank iff every index maps to alpha 0 -----
  if (colorType === 3 && bitDepth === 8 && png.plte && png.trns) {
    let raw;
    try {
      raw = zlib.inflateSync(png.data);
    } catch {
      return false;
    }
    const px = unfilterScanlines(raw, width, height, 1);
    if (!px) return false;

    for (let i = 0; i < px.length; i++) {
      const idx = px[i];
      // entries beyond the tRNS array are fully opaque
      const alpha = idx < png.trns.length ? png.trns[idx] : 255;
      if (alpha !== 0) return false;
    }
    return true;
  }

  // Everything else (RGB without alpha, palette without tRNS, 1/2/4-bit, ...)
  // cannot be proven transparent.
  return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// MBTiles archive (node:sqlite only)
//
// No sqlite3 CLI, no gdal, no tippecanoe: this host has none of them. The schema
// below is what readers expect, and BOTH unique indexes are required or
// INSERT OR REPLACE silently fails to dedupe.
//
// Two invariants that produce a broken-but-openable file when wrong:
//   * rows are TMS, not XYZ: tile_row = 2^z - 1 - y  (flipY)
//   * metadata.format must match the payload, or readers reject the archive
// ─────────────────────────────────────────────────────────────────────────────

const METADATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS name ON metadata (name);
CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER,
                                  tile_row INTEGER, tile_data BLOB);
CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row);
`;

/** MBTiles format from --format, else the tile URL suffix. */
function guessFormat(tilesUrl, explicit) {
  if (explicit) return explicit;
  const clean = tilesUrl.split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  const ext = dot === -1 ? '' : clean.slice(dot + 1).toLowerCase();
  if (ext.startsWith('jp')) return 'jpg';
  if (ext === 'webp') return 'webp';
  if (ext === 'avif') return 'avif';
  return 'png';
}

/** Remove an archive and its WAL sidecars, so --force leaves no stale state. */
function removeArchiveFiles(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

const tileKey = (z, x, tmsY) => `${z}/${x}/${tmsY}`;

/**
 * Open (or resume) the archive.
 *
 *   exists + --force      -> delete archive + sidecars, start over
 *   exists + !--resume    -> abort (never clobber silently)
 *   exists + --resume     -> open, read existing keys so they are skipped
 *   absent                -> create
 */
function openArchive(path, opts) {
  const exists = existsSync(path);

  if (exists && opts.force) {
    removeArchiveFiles(path);
  } else if (exists && !opts.resume) {
    throw new UsageError(
      `output already exists: ${path} (use --resume to continue it, or --force to start over)`);
  }

  const resuming = exists && !opts.force && opts.resume;

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(METADATA_SCHEMA);

  const have = new Set();
  if (resuming) {
    const stmt = db.prepare('SELECT zoom_level, tile_column, tile_row FROM tiles');
    for (const row of stmt.iterate()) {
      have.add(tileKey(row.zoom_level, row.tile_column, row.tile_row));
    }
  }

  return { db, have, resuming };
}

/**
 * Batched tile sink. Buffers rows and commits every `batchSize`, so a killed
 * crawl leaves a readable archive rather than losing everything since the start.
 */
class TileWriter {
  constructor(db, batchSize = 500) {
    this.db = db;
    this.batchSize = batchSize;
    this.stmt = db.prepare('INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)');
    this.buf = [];
    this.stored = 0;
    this.payloadBytes = 0;
  }

  /** `y` is XYZ; the TMS flip happens here, exactly once. */
  put(z, x, y, data) {
    this.buf.push([z, x, flipY(z, y), data]);
    this.payloadBytes += data.length;
    if (this.buf.length >= this.batchSize) this.flush();
  }

  flush() {
    if (!this.buf.length) return;
    const n = this.buf.length;
    this.db.exec('BEGIN');
    try {
      for (const [z, x, row, data] of this.buf) this.stmt.run(z, x, row, data);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    this.stored += n;
    this.buf.length = 0;
  }
}

function writeMetadata(db, plan, opts) {
  const meta = {
    name: opts.name || basename(opts.output),
    format: guessFormat(opts.tilesUrl, opts.format),
    type: 'overlay',
    version: '1',
    minzoom: String(plan.zooms[0]),
    maxzoom: String(plan.zooms[plan.zooms.length - 1]),
    // The EFFECTIVE bounds: what this archive actually covers. The requested
    // bbox is kept for provenance, since clipping may have shrunk it.
    bounds: fmtBox(plan.box),
    requested_bounds: fmtBox(plan.requestedBox),
    generator: 'fetch-tiles.mjs',
  };
  const stmt = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)');
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(meta)) stmt.run(k, v);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Write metadata, checkpoint the WAL, close, and report what is on disk. */
function finalizeArchive(db, plan, opts) {
  writeMetadata(db, plan, opts);

  const agg = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(tile_data)),0) AS bytes FROM tiles').get();
  const perZoom = db.prepare(
    'SELECT zoom_level AS z, COUNT(*) AS n FROM tiles GROUP BY zoom_level ORDER BY zoom_level').all();

  // WAL is right DURING the crawl (crash safety + fewer fsyncs), but wrong as a
  // delivery format: any reader that opens a WAL-mode archive creates -wal and
  // -shm files next to it, so the "one .mbtiles file" people expect turns into
  // three. Checkpoint everything into the main file, then switch back to the
  // rollback journal, which removes the sidecars entirely.
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  } catch { /* best effort: the data is still in the WAL until close */ }

  let journalMode = null;
  try {
    const row = db.prepare('PRAGMA journal_mode=DELETE').get();
    journalMode = row ? row.journal_mode : null;
  } catch { /* best effort */ }

  db.close();

  // If journal_mode did not stick, the sidecars may survive; say so rather than
  // silently shipping a three-file archive.
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(opts.output + suffix) && journalMode !== 'delete') {
      process.stderr.write(`warn: ${opts.output}${suffix} still present; archive is not a single file\n`);
      break;
    }
  }

  const size = existsSync(opts.output) ? statSync(opts.output).size : 0;
  return {
    tiles: Number(agg.n),
    payloadBytes: Number(agg.bytes),
    fileBytes: size,
    perZoom: perZoom.map((r) => ({ z: Number(r.z), n: Number(r.n) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Crawler: passes, not per-tile retries
//
// Within a pass a tile gets exactly ONE request. Anything that does not produce
// a stored tile lands on the miss list, and the next pass re-fetches only that
// list. Rationale: against a renderer, an immediate retry of a failed tile
// usually hits the same broken state (cold COG, upstream hiccup) and just burns
// the timeout twice; a fresh pass minutes later does not.
//
// Miss categories, kept distinct because they mean different things:
//   404  -> no tile here (outside coverage / below minzoom). NOT an error.
//   http -> 5xx or other non-200 status. An error, worth a later pass.
//   net  -> timeout / connection failure. An error, worth a later pass.
//   blank-> fetched fine but provably transparent; dropped by design.
//           NOT a miss and never re-fetched.
// ─────────────────────────────────────────────────────────────────────────────

/** Inverse slippy projection: the WGS84 corner-box of one tile. */
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = (xx) => (xx / n) * 360 - 180;
  const lat = (yy) => {
    const m = Math.PI * (1 - (2 * yy) / n);
    return (Math.atan(Math.sinh(m)) * 180) / Math.PI;
  };
  return { w: lon(x), e: lon(x + 1), n: lat(y), s: lat(y + 1) };
}

/**
 * Build a plan for --from-misses runs, which have no --bbox/--zoom-levels.
 * Bounds come from --bbox when given, else from the tiles' own extent — which
 * is honest for a subset pass and keeps metadata consistent with the archive.
 */
function planFromJobs(jobs, opts) {
  const zooms = [...new Set(jobs.map((j) => j.z))].sort((a, b) => a - b);

  let box;
  if (opts.bbox) {
    box = parseBbox(opts.bbox);
  } else {
    let w = 180, s = 90, e = -180, n = -90;
    for (const j of jobs) {
      const b = tileBounds(j.z, j.x, j.y);
      w = Math.min(w, b.w); e = Math.max(e, b.e);
      s = Math.min(s, b.s); n = Math.max(n, b.n);
    }
    box = { w, s, e, n };
  }

  const perZoom = [];
  let total = 0;
  for (const z of zooms) {
    const zs = jobs.filter((j) => j.z === z);
    const xs = zs.map((j) => j.x), ys = zs.map((j) => j.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    perZoom.push({ z, x0, x1, y0, y1, nx: x1 - x0 + 1, ny: y1 - y0 + 1, count: zs.length });
    total += zs.length;
  }

  return {
    box, requestedBox: box, zooms, requestedZooms: zooms,
    perZoom, total, tilejson: null, tilejsonUrl: null,
    notes: [`plan derived from misses file (${jobs.length.toLocaleString('en-US')} tiles)`],
  };
}

/** Enumerate { z, x, y } for a plan, ascending by zoom; skips already-stored keys. */
function buildJobs(plan, have) {
  const jobs = [];
  for (const r of plan.perZoom) {
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        if (have && have.has(tileKey(r.z, x, flipY(r.z, y)))) continue;
        jobs.push({ z: r.z, x, y });
      }
    }
  }
  return jobs;
}

/** Parse a misses file back into jobs. Format: "z/x/y <category>" per line. */
function readMissesFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read --from-misses file ${path}: ${err.message}`);
  }
  const jobs = [];
  let lineNo = 0;
  for (const rawLine of text.split('\n')) {
    lineNo++;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\d+)\/(\d+)\/(\d+)(?:\s+\S+)?$/.exec(line);
    if (!m) throw new UsageError(`bad line ${lineNo} in ${path}: "${rawLine}"`);
    jobs.push({ z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) });
  }
  if (!jobs.length) throw new UsageError(`no tiles in --from-misses file ${path}`);
  return jobs;
}

function writeMissesFile(path, entries, header) {
  const lines = [`# ${header}`, '# z/x/y category'];
  for (const e of entries) lines.push(`${e.z}/${e.x}/${e.y} ${e.category}`);
  writeFileSync(path, lines.join('\n') + '\n');
}

/**
 * Fetch one tile. Exactly one attempt — no retry loop. Returns a discriminated
 * result so callers never have to infer meaning from a status code.
 */
async function fetchTile(url, timeout, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (res.status === 404) {
      // Drain the body so the socket is reusable; the body is a text error page.
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      return { kind: '404' };
    }
    if (!res.ok) {
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      return { kind: 'http', status: res.status };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length) return { kind: 'http', status: res.status, note: 'empty body' };
    return { kind: 'ok', body, status: res.status };
  } catch (err) {
    return { kind: 'net', note: err && err.name === 'TimeoutError' ? 'timeout' : String(err && err.message || err) };
  }
}

const CATEGORY_ORDER = { http: 0, net: 1, '404': 2 };

/**
 * Run one pass over `jobs` with a fixed-size worker pool.
 * Returns the misses produced by this pass.
 */
async function runPass({ jobs, opts, writer, tilesUrl, passNo, passCount, log }) {
  const misses = [];
  const stats = { stored: 0, blank: 0, '404': 0, http: 0, net: 0 };
  const t0 = Date.now();
  let done = 0;
  let cursor = 0;
  let lastLog = 0;

  const total = jobs.length;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= total) return;
      const { z, x, y } = jobs[i];
      const url = tilesUrl
        .replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y);

      const r = await fetchTile(url, opts.timeout, opts.headers);
      done++;

      if (r.kind === 'ok') {
        if (opts.skipEmpty && isBlankPng(r.body)) {
          stats.blank++;
        } else {
          writer.put(z, x, y, r.body);
          stats.stored++;
        }
      } else if (r.kind === '404') {
        stats['404']++;
        misses.push({ z, x, y, category: '404' });
      } else if (r.kind === 'http') {
        stats.http++;
        misses.push({ z, x, y, category: 'http', detail: r.status });
        if (opts.verbose) log(`  miss ${z}/${x}/${y} http ${r.status}${r.note ? ' ' + r.note : ''}\n`);
      } else {
        stats.net++;
        misses.push({ z, x, y, category: 'net', detail: r.note });
        if (opts.verbose) log(`  miss ${z}/${x}/${y} net ${r.note}\n`);
      }

      const now = Date.now();
      if (now - lastLog > 250 || done === total) {
        lastLog = now;
        const el = (now - t0) / 1000;
        const rate = el > 0 ? done / el : 0;
        const eta = rate > 0 ? (total - done) / rate : 0;
        log(`\r  pass ${passNo}/${passCount}  ${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')} ` +
            `${rate.toFixed(1)} t/s  stored=${stats.stored} blank=${stats.blank} ` +
            `404=${stats['404']} http=${stats.http} net=${stats.net}  ` +
            `eta=${eta >= 60 ? (eta / 60).toFixed(1) + 'm' : eta.toFixed(0) + 's'}   `);
      }
    }
  };

  const n = Math.max(1, Math.min(opts.concurrency, total || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  writer.flush();
  if (total) log('\n');

  return { misses, stats, elapsed: (Date.now() - t0) / 1000 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test: offline geometry assertions
//
// Encodes the values we measured against tileserver-rs, so the tile math can
// never regress silently. Every assertion below is on INTEGER tile coordinates
// (or an integer count), so no float tolerance is involved.
//
//   node fetch-tiles.mjs --selftest
// ─────────────────────────────────────────────────────────────────────────────

function runSelfTest() {
  const failures = [];
  let checks = 0;

  const eq = (label, actual, expected) => {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${label}\n       expected: ${e}\n       actual:   ${a}`);
  };
  const ok = (label, cond) => {
    checks++;
    if (!cond) failures.push(`${label}\n       expected: true\n       actual:   false`);
  };

  // --- the mandatory TMS flip (Rule: MBTiles rows are TMS, not XYZ) -------
  eq('flipY(11, 710) === 1337', flipY(11, 710), 1337);
  eq('flipY(0, 0) === 0', flipY(0, 0), 0);
  eq('flipY roundtrip z14', flipY(14, flipY(14, 5668)), 5668);

  // --- north/south trap: lat_max is the NORTH edge -> SMALLEST y ---------
  ok('north edge maps to smaller y than south edge',
     latToYf(48.4, 14) < latToYf(47.9, 14));
  // y grows southward: a NORTHERN latitude has a SMALLER y.
  // measured z10: 48.4N -> 354.250, 30N -> 422.477, 0 -> 512.000, 30S -> 601.523
  ok('y grows southward (30N has smaller y than equator)',
     latToYf(30, 10) < latToYf(0, 10));
  ok('y grows southward (equator has smaller y than 30S)',
     latToYf(0, 10) < latToYf(-30, 10));

  // --- Munich bbox, per zoom: x0,x1,y0,y1 --------------------------------
  // Verified against the server's own TileJSON bounds (11.2,47.9,11.9,48.4).
  const MUNICH = { w: 11.2, s: 47.9, e: 11.9, n: 48.4 };
  const MUNICH_RANGES = [
    [3, 4, 4, 2, 2],
    [4, 8, 8, 5, 5],
    [5, 16, 17, 11, 11],
    [6, 33, 34, 22, 22],
    [7, 67, 68, 44, 44],
    [8, 135, 136, 88, 89],
    [9, 271, 272, 177, 178],
    [10, 543, 545, 354, 356],
    [11, 1087, 1091, 708, 712],
    [12, 2175, 2183, 1417, 1425],
    [13, 4350, 4366, 2834, 2851],
    [14, 8701, 8733, 5668, 5702],
  ];
  let munichTotal = 0;
  for (const [z, x0, x1, y0, y1] of MUNICH_RANGES) {
    const r = tileRange(MUNICH, z);
    eq(`munich z${z} range`, [r.x0, r.x1, r.y0, r.y1], [x0, x1, y0, y1]);
    eq(`munich z${z} nx/ny, consistent with range`,
       [r.nx, r.ny], [x1 - x0 + 1, y1 - y0 + 1]);
    munichTotal += r.count;
  }
  eq('munich z3-14 total is 1,592', munichTotal, 1592);

  // --- the user's sample bbox: 3.65M tiles when NOT clipped --------------
  const SAMPLE = { w: 0, s: 30, e: 30, n: 60 };
  const USER_RANGES = [
    [3, 4, 4, 2, 3],
    [10, 512, 597, 297, 422],
    [11, 1024, 1194, 594, 844],
    [12, 2048, 2389, 1189, 1689],
    [13, 4096, 4778, 2378, 3379],
    [14, 8192, 9557, 4757, 6759],
  ];
  let sampleTotal = 0;
  for (let z = 3; z <= 14; z++) {
    const r = tileRange(SAMPLE, z);
    sampleTotal += r.count;
    const want = USER_RANGES.find((t) => t[0] === z);
    if (want) eq(`sample z${z} range`, [r.x0, r.x1, r.y0, r.y1], want.slice(1));
  }
  eq('sample bbox z3-14 total is 3,649,272', sampleTotal, 3649272);

  // --- boundary semantics: ceil-1 must not pull in the next cell ---------
  // 0..90 lon at z2 ends exactly on the x=3 tile boundary; only column 2 is in.
  const b = tileRange({ w: 0, s: 0, e: 90, n: 85.05112877980659 }, 2);
  eq('bbox ending on a tile boundary yields one column', [b.x0, b.x1], [2, 2]);

  // A tile that only clips the bbox corner must still be included.
  const corner = tileRange({ w: 11.5, s: 48.1, e: 11.5, n: 48.1 }, 14);
  ok('zero-area bbox still yields >= 1 tile', corner.count >= 1);

  // --- whole-world and clamping ------------------------------------------
  const world = tileRange({ w: -180, s: -85.05112877980659, e: 180, n: 85.05112877980659 }, 0);
  eq('world z0 is exactly one tile', [world.x0, world.x1, world.y0, world.y1], [0, 0, 0, 0]);
  ok('all tile coords clamped to [0, 2^z-1]', (() => {
    for (let z = 0; z <= 6; z++) {
      const r = tileRange({ w: -180, s: -85, e: 180, n: 85 }, z);
      const n = 2 ** z;
      if (r.x0 < 0 || r.x1 > n - 1 || r.y0 < 0 || r.y1 > n - 1) return false;
      if (r.x1 < r.x0 || r.y1 < r.y0) return false;
    }
    return true;
  })());

  // --- ocean control: 72 planned at z8, 1 real tile ----------------------
  eq('ocean z8 plan is 72 tiles',
     tileRange({ w: -30, s: -30, e: -20, n: -20 }, 8).count, 72);

  // --- zoom spec parsing -------------------------------------------------
  eq('parseZoomLevels("3-14")', parseZoomLevels('3-14').length, 12);
  eq('parseZoomLevels("3-14") endpoints', [parseZoomLevels('3-14')[0], parseZoomLevels('3-14')[11]], [3, 14]);
  eq('parseZoomLevels("0-5,8,10-12")', parseZoomLevels('0-5,8,10-12'), [0, 1, 2, 3, 4, 5, 8, 10, 11, 12]);
  eq('parseZoomLevels("14-3") normalises', parseZoomLevels('14-3'), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  ok('parseZoomLevels rejects garbage', (() => {
    try { parseZoomLevels('abc'); return false; } catch { return true; }
  })());

  // --- bbox parsing ------------------------------------------------------
  eq('parseBbox normalises swapped lat order',
     parseBbox('0,60,30,30'), { w: 0, s: 30, e: 30, n: 60 });
  eq('parseBbox normalises swapped lon order',
     parseBbox('30,30,0,60'), { w: 0, s: 30, e: 30, n: 60 });
  ok('parseBbox rejects poles beyond WebMercator', (() => {
    try { parseBbox('0,-89,10,10'); return false; } catch { return true; }
  })());

  // --- PNG blank detection: offline, synthetic ---------------------------
  // Every case here encodes a measured fact about what the server emits:
  // 256x256 8-bit RGBA, blanks with all 65,536 alphas == 0, and real sparse
  // tiles that are only 0.87 % non-black but carry 153 OPAQUE pixels.

  const pngChunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out; // CRC left zero — the reader does not verify it
  };

  const buildPng = ({ width, height, colorType, bitDepth = 8, interlace = 0, pixels, plte, trns }) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth; ihdr[9] = colorType;
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace;

    const bpp = PNG_CHANNELS[colorType] * (bitDepth / 8);
    const stride = width * bpp;
    const rows = [];
    for (let y = 0; y < height; y++) {
      rows.push(Buffer.from([0]));                       // filter type 0
      rows.push(pixels.subarray(y * stride, (y + 1) * stride));
    }
    const parts = [PNG_SIG, pngChunk('IHDR', ihdr)];
    if (plte) parts.push(pngChunk('PLTE', plte));
    if (trns) parts.push(pngChunk('tRNS', trns));
    parts.push(pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))));
    parts.push(pngChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
  };

  // Fill w*h pixels with one channel tuple.
  const solid = (width, height, colorType, perPixel, bitDepth = 8) => {
    const ch = PNG_CHANNELS[colorType];
    const bytesPerSample = bitDepth / 8;
    const bpp = ch * bytesPerSample;
    const b = Buffer.alloc(width * height * bpp);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < ch; c++) {
        // only the low byte is set; fine for 8-bit, and for 16-bit we set both
        // bytes below when needed
        b[i * bpp + c * bytesPerSample + (bytesPerSample - 1)] = perPixel[c] ?? 0;
      }
    }
    return b;
  };

  // (a) fully transparent RGBA -> blank
  ok('blank: RGBA all alpha 0',
     isBlankPng(buildPng({ width: 4, height: 4, colorType: 6,
       pixels: solid(4, 4, 6, [0, 0, 0, 0]) })) === true);

  // (b) one opaque pixel -> NOT blank (this is the sparse-real-tile case)
  {
    const px = solid(4, 4, 6, [0, 0, 0, 0]);
    px[3] = 255;                                    // first pixel's alpha
    ok('not blank: RGBA one opaque pixel',
       isBlankPng(buildPng({ width: 4, height: 4, colorType: 6, pixels: px })) === false);
  }

  // (c) REGRESSION GUARD: bright RGB but alpha 0 is still blank.
  //     A brightness-based heuristic would wrongly keep this.
  {
    const px = solid(4, 4, 6, [230, 40, 12, 0]);
    ok('blank: colourful RGB with alpha 0 (alpha wins over brightness)',
       isBlankPng(buildPng({ width: 4, height: 4, colorType: 6, pixels: px })) === true);
  }

  // (d) RGB without an alpha channel can never be proven blank
  ok('not blank: RGB (colorType 2) all black is unprovable',
     isBlankPng(buildPng({ width: 4, height: 4, colorType: 2,
       pixels: solid(4, 4, 2, [0, 0, 0]) })) === false);

  // (e) gray+alpha, all alpha 0 -> blank
  ok('blank: gray+alpha all alpha 0',
     isBlankPng(buildPng({ width: 4, height: 4, colorType: 4,
       pixels: solid(4, 4, 4, [17, 0]) })) === true);

  // (f) 16-bit RGBA, all alpha 0 -> blank; one low alpha byte -> not blank
  {
    const blank16 = solid(2, 2, 6, [0, 0, 0, 0], 16);
    ok('blank: RGBA 16-bit all alpha 0',
       isBlankPng(buildPng({ width: 2, height: 2, colorType: 6, bitDepth: 16, pixels: blank16 })) === true);

    const one16 = Buffer.from(blank16);
    one16[7] = 1;                                   // alpha low byte of pixel 0
    ok('not blank: RGBA 16-bit single alpha byte set',
       isBlankPng(buildPng({ width: 2, height: 2, colorType: 6, bitDepth: 16, pixels: one16 })) === false);
  }

  // (g) palette + tRNS: every index transparent -> blank
  {
    const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const idx = Buffer.alloc(4 * 4, 0);             // all index 0
    ok('blank: palette+tRNS every index alpha 0',
       isBlankPng(buildPng({ width: 4, height: 4, colorType: 3, pixels: idx,
         plte, trns: Buffer.from([0, 0, 0, 255]) })) === true);

    const idx2 = Buffer.from(idx); idx2[5] = 3;     // one index with alpha 255
    ok('not blank: palette+tRNS an opaque index present',
       isBlankPng(buildPng({ width: 4, height: 4, colorType: 3, pixels: idx2,
         plte, trns: Buffer.from([0, 0, 0, 255]) })) === false);
  }

  // (h) interlaced is never de-interlaced -> not blank
  ok('not blank: interlaced PNG is left alone',
     isBlankPng(buildPng({ width: 4, height: 4, colorType: 6, interlace: 1,
       pixels: solid(4, 4, 6, [0, 0, 0, 0]) })) === false);

  // (i) junk that is not a PNG at all
  ok('not blank: 404 body text',
     isBlankPng(Buffer.from('tile not found: z=3, x=0, y=0')) === false);
  ok('not blank: JPEG bytes',
     isBlankPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])) === false);
  ok('not blank: empty buffer',
     isBlankPng(Buffer.alloc(0)) === false);

  // (j) truncated PNG (valid header, no IDAT) -> not blank
  {
    const good = buildPng({ width: 4, height: 4, colorType: 6, pixels: solid(4, 4, 6, [0, 0, 0, 0]) });
    ok('not blank: truncated PNG (no IDAT)',
       isBlankPng(good.subarray(0, 33)) === false);
  }

  // (k) scanline filter reversal, all five types, decoded against expected
  {
    // 3 pixels of RGBA, one channel each for clarity: use 8-bit RGBA 3x1
    const w = 3, bpp = 4, stride = w * bpp;
    const target = Buffer.from([
      10, 20, 30, 40,      // pixel 0
      11, 22, 33, 44,      // pixel 1
      12, 24, 36, 48,      // pixel 2
    ]);
    const encode = (type) => {
      const out = Buffer.alloc(stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? target[i - bpp] : 0;
        const b = 0;                                   // single scanline: no row above
        const c = 0;
        let v;
        switch (type) {
          case 0: v = target[i]; break;
          case 1: v = (target[i] - a) & 0xff; break;
          case 2: v = target[i] & 0xff; break;         // b == 0
          case 3: v = (target[i] - ((a + b) >> 1)) & 0xff; break;
          case 4: v = (target[i] - paethPredictor(a, b, c)) & 0xff; break;
        }
        out[i] = v;
      }
      return out;
    };
    for (const type of [0, 1, 2, 3, 4]) {
      const raw = Buffer.concat([Buffer.from([type]), encode(type)]);
      const got = unfilterScanlines(raw, w, 1, bpp);
      eq(`unfilter scanline filter type ${type}`, got ? [...got] : null, [...target]);
    }

    // invalid filter type must be rejected, not guessed
    ok('unfilter rejects filter type 5',
       unfilterScanlines(Buffer.concat([Buffer.from([5]), Buffer.alloc(stride)]), w, 1, bpp) === null);

    // data length disagreeing with declared geometry must be rejected
    ok('unfilter rejects wrong data length',
       unfilterScanlines(Buffer.alloc(stride), w, 1, bpp) === null);
  }

  // --- report ------------------------------------------------------------
  if (failures.length) {
    process.stderr.write(`selftest: ${failures.length} of ${checks} checks FAILED\n\n`);
    for (const f of failures) process.stderr.write(`  FAIL  ${f}\n`);
    return EXIT.FATAL;
  }
  process.stdout.write(`selftest: all ${checks} checks passed\n`);
  return EXIT.OK;
}

/**
 * Diagnostic: explain what the blank detector decides for one saved tile.
 * Useful when a crawl drops something unexpected — proves the verdict without
 * re-running the crawl.
 */
function runBlankCheck(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (err) {
    process.stderr.write(`error: cannot read ${path}: ${err.message}\n`);
    return EXIT.FATAL;
  }
  const blank = isBlankPng(buf);
  const png = (() => { try { return readPng(buf); } catch { return null; } })();

  process.stdout.write(`file  : ${path}\n`);
  process.stdout.write(`bytes : ${buf.length}\n`);
  if (png) {
    const { width, height, bitDepth, colorType, interlace } = png.ihdr;
    process.stdout.write(`png   : ${width}x${height} bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}\n`);
  } else {
    process.stdout.write('png   : not a readable PNG\n');
  }
  process.stdout.write(`blank : ${blank}\n`);
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint
//
// Step 1 scaffold: argument parsing is live (so --help and usage errors behave
// correctly), the crawl itself is not implemented yet and exits FATAL.
// Steps 4-8 fill in the body; the exit-code contract above stays as-is.
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  // --selftest and --help must not require the four mandatory arguments.
  if (argv.includes('--selftest')) return runSelfTest();

  const blankArg = argv.find((a) => a.startsWith('--blank-check='));
  if (blankArg) return runBlankCheck(blankArg.slice('--blank-check='.length));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}`);
      return EXIT.USAGE;
    }
    throw err;
  }

  // ---- plan (step 3/7) -------------------------------------------------
  let plan;
  let presetJobs = null;
  try {
    if (opts.fromMisses) {
      presetJobs = readMissesFile(opts.fromMisses);
      plan = planFromJobs(presetJobs, opts);
    } else {
      plan = await resolvePlan(opts);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof EmptyPlanError) {
      process.stderr.write(`error: ${err.message}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }

  printPlan(plan, opts, process.stdout);

  if (opts.dryRun) return EXIT.OK;

  // ---- archive (step 6) ------------------------------------------------
  let archive;
  try {
    archive = openArchive(opts.output, opts);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }

  if (archive.resuming) {
    process.stdout.write(`resuming: ${archive.have.size.toLocaleString('en-US')} tiles already stored\n`);
  }

  // ---- crawl (step 7): passes, not per-tile retries --------------------
  const log = (s) => process.stderr.write(s);
  let jobs = presetJobs || buildJobs(plan, archive.have);

  if (!jobs.length) {
    process.stdout.write('nothing to fetch: every planned tile is already stored\n');
  }

  const writer = new TileWriter(archive.db);
  const passTotals = [];
  let finalMisses = [];

  for (let passNo = 1; passNo <= opts.passes; passNo++) {
    if (!jobs.length) break;

    if (opts.passes > 1 || passNo > 1) {
      log(`\npass ${passNo}/${opts.passes}: ${jobs.length.toLocaleString('en-US')} tiles queued` +
          (passNo > 1 ? ' (misses from previous pass)' : '') + '\n');
    }

    const result = await runPass({
      jobs, opts, writer, tilesUrl: opts.tilesUrl, passNo, passCount: opts.passes, log,
    });

    finalMisses = result.misses;
    passTotals.push(result);

    // A pass with no misses is done; further passes have nothing to fetch.
    if (!result.misses.length) {
      if (passNo < opts.passes) {
        log(`pass ${passNo}: no misses, stopping early\n`);
      }
      break;
    }

    // Next pass re-fetches ONLY what is still missing - and only what is worth
    // re-asking. A 404 is a deterministic negative here (outside coverage or
    // below the source minzoom): repeating it just burns requests against a
    // server that already said no. 5xx and connection failures ARE worth a
    // later pass, because those are transient by nature.
    const retryable = result.misses.filter((m) => m.category !== '404');
    if (result.misses.length && !retryable.length) {
      log(`pass ${passNo}: no retryable misses (404s are deterministic), stopping\n`);
      break;
    }
    jobs = retryable.map((m) => ({ z: m.z, x: m.x, y: m.y }));
  }

  // ---- misses file -----------------------------------------------------
  if (finalMisses.length) {
    writeMissesFile(opts.misses, finalMisses,
      `unresolved misses after ${passTotals.length} pass(es) from ${opts.tilesUrl}`);
    process.stdout.write(`misses  : ${finalMisses.length.toLocaleString('en-US')} -> ${opts.misses}\n` +
      `          run again with --from-misses=${opts.misses}\n`);
  } else {
    // Do not leave a stale list from an earlier run lying around.
    if (existsSync(opts.misses)) unlinkSync(opts.misses);
  }

  // ---- finalize (step 8) ----------------------------------------------
  const summary = finalizeArchive(archive.db, plan, opts);
  printSummary(summary, passTotals, finalMisses, plan, opts);

  // exit 3 only for real errors; 404s are a deterministic negative.
  const hardMisses = finalMisses.filter((m) => m.category !== '404').length;
  return hardMisses ? EXIT.TILE_ERRORS : EXIT.OK;
}

/** Post-run report; reconciles every planned tile into exactly one bucket. */
function printSummary(summary, passTotals, misses, plan, opts) {
  const w = (s) => process.stdout.write(s + '\n');

  const agg = { stored: 0, blank: 0, '404': 0, http: 0, net: 0 };
  for (const p of passTotals) {
    for (const k of Object.keys(agg)) agg[k] += p.stats[k] || 0;
  }
  const elapsed = passTotals.reduce((s, p) => s + p.elapsed, 0);
  const prefixStored = summary.tiles - agg.stored;

  w('');
  w(`archive : ${opts.output}`);
  w(`passes  : ${passTotals.length}/${opts.passes}` +
    (passTotals.length ? ` (${elapsed.toFixed(1)}s)` : ''));
  w(`tiles   : ${summary.tiles.toLocaleString('en-US')} stored` +
    (prefixStored > 0 ? ` (incl. ${prefixStored.toLocaleString('en-US')} from a previous run)` : '') +
    ` / ${plan.total.toLocaleString('en-US')} planned`);
  w(`payload : ${(summary.payloadBytes / 1e6).toFixed(2)} MB`);
  w(`file    : ${(summary.fileBytes / 1e6).toFixed(2)} MB`);
  if (summary.perZoom.length) {
    w(`by zoom : ${summary.perZoom.map((r) => `z${r.z}=${r.n}`).join('  ')}`);
  }

  w('');
  w(`this run: stored=${agg.stored}  blank=${agg.blank}  404=${agg['404']}  ` +
    `http=${agg.http}  net=${agg.net}`);
  if (misses.length) {
    const byCat = {};
    for (const m of misses) byCat[m.category] = (byCat[m.category] || 0) + 1;
    w(`unresolved: ${Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join('  ')}` +
      `  -> ${opts.misses}`);
  } else {
    w('unresolved: none');
  }
}

// Only run the CLI when executed directly, so the module can be imported for
// testing/benchmarking without side effects.
const EXECUTED_DIRECTLY = (() => {
  try {
    return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return true;
  }
})();

if (EXECUTED_DIRECTLY) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`fatal: ${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = EXIT.FATAL;
    },
  );
}

// Exposed for testing (see --selftest and any external harness).
export {
  isBlankPng, readPng, unfilterScanlines, tileRange, flipY, latToYf, lonToXf,
  parseBbox, parseZoomLevels, resolvePlan, intersectBbox, deriveTilejsonUrl,
  openArchive, TileWriter, finalizeArchive, writeMetadata, guessFormat, removeArchiveFiles,
  fmtBox, EXIT,
};
