// Regenerates the server-side registered colormap JSONs for the TiTiler DEMO
// demos from their client-side source, so the server-side ramp is byte-for-byte
// identical to what the inline `colormap=` ramp used to deliver.
//
// Source of truth:
//   - Nepal snow  + Uganda LUC  ramps: src/maps/TiTilerDemo/colormaps.js (ESM exports)
//   - WorldCereal sparse ramp:        src/maps/TiTilerDemo/WorldCereal.jsx (inline)
//
// Run from the repo root:
//   node deploy/titiler/colormaps/gen-demo-colormaps.mjs
//
// After (re)generating, restart BOTH TiTiler stacks so COLORMAP_DIRECTORY is
// re-scanned at startup (it is read at startup only):
//   docker compose -f deploy/titiler/docker-compose.yml up -d --force-recreate
//   docker compose -f deploy/titiler-caching/docker-compose.yml up -d --force-recreate
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // .../deploy/titiler/colormaps
const root = join(here, '..', '..', '..'); // repo root

// colormaps.js exports SNOW_COLORMAP / UGANDA_COLORMAP / GHS_POP_COLORMAP as
// plain JSON-text strings (already unescaped by the JS engine). Parse directly
// -> {int: [r,g,b]} (RGB, 3 entries), no regex / manual unescape needed.
const { SNOW_COLORMAP, UGANDA_COLORMAP } = await import(
  join(root, 'src', 'maps', 'TiTilerDemo', 'colormaps.js')
);
const parse = (txt) => Object.fromEntries(
  Object.entries(JSON.parse(txt)).map(([k, v]) => [Number(k), v])
);

// Add alpha (default 255) to every RGB entry -> RGBA.
function toRgba(map, alpha = 255) {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [Number(k), v.length === 4 ? v : [...v, alpha]])
  );
}

function write(name, map) {
  const sorted = Object.fromEntries(
    Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]))
  );
  const out = join(here, `${name}.json`);
  writeFileSync(out, JSON.stringify(sorted));
  console.log(`wrote ${out} (${Object.keys(sorted).length} entries)`);
}

// ---- Nepal snow: full 256-entry viridis-like ramp, no transparency ----
write('nepal_snow_viridis', toRgba(parse(SNOW_COLORMAP)));

// ---- Uganda LUC: full 256-entry ramp, byte 0 transparent (see UgandaLUC.jsx) ----
const uganda = toRgba(parse(UGANDA_COLORMAP), 255);
uganda[0] = [...uganda[0].slice(0, 3), 0]; // byte 0 transparent (masked no-data background)
write('uganda_blues_transparent', uganda);

// ---- WorldCereal: sparse categorical ramp (matches inline COLORMAP in JSX) ----
// 0 gray, 100 green, 254/255 transparent; any other byte -> transparent black.
write('worldcereal_active', {
  0: [207, 207, 207, 255],
  100: [26, 150, 65, 255],
  254: [0, 0, 0, 0],
  255: [0, 0, 0, 0],
});
