/**
 * Per-track metadata sidecar: parse the wavelength and model the offset
 * multipliers used by the 2D displacement chart.
 *
 * The `.txt` sidecar's first row reads `wavelength = 55.466` (millimetres).
 * Only that first row is inspected; the rest of the file is not used. The
 * configured `TRACKS[].id` stays authoritative for identity because at least
 * one sidecar (139D) carries a wrong `track = 37` line.
 */

export const DEFAULT_OFFSET_FACTOR = 0.5;
export const OFFSET_FACTOR_STEP = 0.05;

const WAVELENGTH_RE =
  /wavelength\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/i;

/**
 * Read the wavelength from the first line of a metadata document.
 *
 * Trailing spaces and a leading BOM are tolerated. Returns `null` when the
 * first line has no finite wavelength.
 *
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseWavelength(text) {
  const firstLine = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/, 1)[0];
  const match = WAVELENGTH_RE.exec(firstLine);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a user-entered offset multiplier.
 *
 * `null` / blank / non-finite / negative values return `null`, so the caller
 * can hide that offset series. Zero is valid and also hides the series.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseOffsetFactor(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Fetch and parse one track's wavelength.
 *
 * Never rejects: a network, CORS or parse failure resolves with
 * `{ wavelength: null, error }` so it can be awaited next to the parquet load
 * without turning a valid track into an error state.
 *
 * @param {string} [url]
 * @returns {Promise<{ wavelength: number|null, error: string|null }>}
 */
export async function fetchTrackWavelength(url) {
  if (!url) return { wavelength: null, error: 'No metadata URL configured.' };
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const wavelength = parseWavelength(await response.text());
    if (wavelength == null) {
      throw new Error('First row does not contain a wavelength value.');
    }
    return { wavelength, error: null };
  } catch (error) {
    return { wavelength: null, error: error?.message || String(error) };
  }
}
