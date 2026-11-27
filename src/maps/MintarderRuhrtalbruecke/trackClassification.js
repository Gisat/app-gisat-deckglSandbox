/**
 * Per-track final-class CSV: fetch, cache, parse and reliability lookups.
 *
 * One CSV row per InSAR point, keyed by `ID`. Each row lists interval blocks
 * `N = 1..G` with `date_start_N`, `date_stop_N` and `reliability_N`. The 2D
 * displacement chart already has the displacement samples (`d_YYYYMMDD`); this
 * module only answers "which colour should this date's dot be?".
 *
 * Pure helpers plus a module-level fetch cache, so nothing here depends on
 * React or the chart library.
 */

export const RELIABILITY_THRESHOLD_DEFAULT = 0.9;
export const RELIABILITY_THRESHOLD_MIN = 0;
export const RELIABILITY_THRESHOLD_MAX = 1;
export const RELIABILITY_THRESHOLD_STEP = 0.01;

export const DOT_COLORS = {
  reliable: '#228BE6',
  unreliable: '#9E9E9E',
  missing: '#000000',
};

const DATE_KEY_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_START_RE = /^date_start_(\d+)$/;

/**
 * Split delimited text into rows of fields.
 *
 * Handles `\r\n` / `\n` / `\r` line endings, commas and quoted fields (double
 * quotes, escaped as `""`). The current exports are unquoted, but a future
 * export with quoted IDs or notes must not corrupt parsing.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseDelimitedRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * `YYYYMMDD` -> UTC milliseconds at midnight.
 *
 * UTC (not local) so bounds line up with the `epochKeyToUtc` values behind the
 * chart's `d_*` samples. Returns `null` for empty, malformed or impossible
 * dates.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseDateKey(value) {
  if (value == null) return null;
  const match = DATE_KEY_RE.exec(String(value).trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

function toFiniteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse a `*_final_class.csv` document.
 *
 * Groups are discovered from the header (`date_start_N`), so 9- and 10-group
 * tracks parse the same way and a future wider export does not need a change.
 * Rows with a blank `ID` are skipped; a duplicate `ID` is last-wins.
 *
 * @param {string} text
 * @returns {Map<string, { id: string, index: number|null,
 *   intervals: Array<{ n: number, startMs: number, stopMs: number,
 *   reliability: number|null }> }>}
 */
export function parseFinalClassCsv(text) {
  const byId = new Map();
  const rows = parseDelimitedRows(text);
  if (rows.length === 0) return byId;

  const header = rows[0].map((name) => name.trim());
  const columnIndex = new Map();
  header.forEach((name, index) => {
    if (!columnIndex.has(name)) columnIndex.set(name, index);
  });

  const idColumn = columnIndex.get('ID');
  if (idColumn == null) return byId;
  const indexColumn = columnIndex.get('index') ?? null;

  const groups = [];
  header.forEach((name, column) => {
    const match = DATE_START_RE.exec(name);
    if (!match) return;
    const n = Number(match[1]);
    const stopColumn = columnIndex.get(`date_stop_${match[1]}`);
    if (stopColumn == null) return;
    groups.push({
      n,
      startColumn: column,
      stopColumn,
      reliabilityColumn: columnIndex.get(`reliability_${match[1]}`) ?? null,
    });
  });

  let duplicates = 0;

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const id = String(row[idColumn] ?? '').trim();
    if (id === '') continue;

    const intervals = [];
    for (const group of groups) {
      const startMs = parseDateKey(row[group.startColumn]);
      const stopMs = parseDateKey(row[group.stopColumn]);
      if (startMs == null || stopMs == null) continue;

      const reliability = group.reliabilityColumn == null
        ? null
        : toFiniteNumber(row[group.reliabilityColumn]);

      intervals.push({
        n: group.n,
        startMs,
        stopMs,
        reliability,
      });
    }
    // Sequential blocks in the current data; sorting keeps `find` returning
    // the earliest match if a future export ever overlaps.
    intervals.sort((a, b) => a.startMs - b.startMs);

    if (byId.has(id)) duplicates += 1;
    byId.set(id, {
      id,
      index: indexColumn == null ? null : toFiniteNumber(row[indexColumn]),
      intervals,
    });
  }

  if (duplicates > 0) {
    console.warn(`final-class CSV: ${duplicates} duplicate ID row(s); last one wins.`);
  }

  return byId;
}

/**
 * Colour for one displacement sample date.
 *
 * `black` means "no final-class information": no row, no matching block (a gap
 * between blocks or a date outside every block) or a blank reliability.
 *
 * @param {{ intervals: Array<{ startMs: number, stopMs: number,
 *   reliability: number|null }> }|null|undefined} entry
 * @param {number} dateMs
 * @param {number} threshold
 * @returns {string}
 */
export function dotColorForDate(entry, dateMs, threshold) {
  if (!entry || entry.intervals.length === 0) return DOT_COLORS.missing;
  const interval = entry.intervals.find(
    (item) => dateMs >= item.startMs && dateMs <= item.stopMs
  );
  if (!interval) return DOT_COLORS.missing;
  if (interval.reliability == null) return DOT_COLORS.missing;
  return interval.reliability >= threshold
    ? DOT_COLORS.reliable
    : DOT_COLORS.unreliable;
}

/** url -> Promise<Map<string, entry>>; one fetch per track per page session. */
const classificationCache = new Map();

/**
 * Load (or reuse) the parsed classification for one track.
 *
 * Failures are evicted from the cache so reopening the chart retries instead
 * of replaying a rejected promise.
 *
 * @param {string} url
 * @returns {Promise<Map<string, any>>}
 */
export function loadTrackClassification(url) {
  if (!url) return Promise.reject(new Error('No classification URL configured.'));

  const cached = classificationCache.get(url);
  if (cached) return cached;

  const promise = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then(parseFinalClassCsv)
    .catch((error) => {
      if (classificationCache.get(url) === promise) classificationCache.delete(url);
      throw error;
    });

  classificationCache.set(url, promise);
  return promise;
}
