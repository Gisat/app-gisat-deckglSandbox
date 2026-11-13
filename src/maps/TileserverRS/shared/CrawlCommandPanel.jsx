import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './CrawlCommandPanel.css';

/**
 * Builds the `fetch-tiles.mjs` command for a drawn bbox. This panel NEVER
 * executes anything — it generates two copy-paste commands:
 *
 *   1. with `--dry-run`  -> prints the per-zoom tile counts, writes nothing
 *   2. without           -> performs the actual crawl and writes the archive
 *
 * Why a command and not a button: the fetcher is a Node CLI using `node:fs` and
 * `node:sqlite`, so it cannot run in the browser, and the deployed app
 * (`python:3.10-slim`) has no Node runtime to spawn it from. Generating the
 * command keeps this feature working identically in `npm run dev` and in the
 * built container, with no backend at all.
 *
 * The tile URL host is derived from the endpoint the DEMO actually uses, so it
 * never hardcodes localhost: clamped to `window.location.origin` + the same
 * `baseUrl` the map's TileLayer requests. In dev that is the Vite proxy; in a
 * deployment it is whatever serves the app.
 */

const MAX_LAT = 85.05113;

/** Trim a coordinate to ~1 m precision without trailing noise. */
const fmt = (v) => String(Number(v.toFixed(5)));

/**
 * Zoom range for the suggested command: start at the zoom the user is looking
 * at, end at the source's advertised maxzoom.
 *
 * `floor` rather than `round`: deck.gl already requests integer-zoom tiles when
 * the camera sits at 9.7, so flooring matches what is actually on screen and
 * avoids re-crawling tiles that are already visible.
 */
function zoomRange(currentZoom, tilejson) {
    const maxZoom = Number.isFinite(tilejson?.maxzoom) ? tilejson.maxzoom : 14;
    const minZoom = Number.isFinite(tilejson?.minzoom) ? tilejson.minzoom : 0;
    let start = Math.floor(Number(currentZoom) || 0);
    if (start < minZoom) start = minZoom;
    if (start > maxZoom) start = maxZoom;
    return { start, maxZoom, spec: start === maxZoom ? String(start) : `${start}-${maxZoom}` };
}

/** The tiles URL as the running app requests it, made absolute for Node. */
function tilesUrl(sourceId, baseUrl) {
    const path = `${baseUrl.replace(/\/$/, '')}/data/${sourceId}/{z}/{x}/{y}.png`;
    // Deliberately NOT `new URL(path, location.href)`: the URL parser
    // percent-encodes the braces (`{z}` -> `%7Bz%7D`), so fetch-tiles.mjs would
    // find no placeholder to substitute and crawl a literal URL that 404s.
    // Concatenate the origin instead, keeping the template verbatim.
    const origin = typeof window !== 'undefined' && window.location
        ? window.location.origin
        : '';
    return origin + path;
}

function buildCommand({ bbox, zoomSpec, url, output, dryRun }) {
    const body = [
        'node fetch-tiles.mjs',
        `  --tiles-url="${url}"`,
        `  --bbox="${bbox}"`,
        `  --zoom-levels="${zoomSpec}"`,
        `  --output="${output}"`,
    ];
    if (dryRun) body.push('  --dry-run');
    return `${body.join(' \\\n')}`;
}

function CommandBlock({ label, command, hint }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef(null);

    useEffect(() => () => clearTimeout(timer.current), []);

    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard is unavailable on insecure origins; the textarea below is
            // selectable by hand, so this degrades instead of failing.
            setCopied(false);
        }
    }, [command]);

    return (
        <div className="crawl-command-block">
            <div className="crawl-command-head">
                <span className="crawl-command-label">{label}</span>
                <button type="button" className="crawl-command-copy" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            <textarea
                className="crawl-command-text"
                readOnly
                rows={command.split('\n').length}
                value={command}
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
            />
            {hint && <div className="crawl-command-hint">{hint}</div>}
        </div>
    );
}

function CrawlCommandPanel({ bbox, zoom, sourceId, baseUrl, tilejson, onClear }) {
    const url = useMemo(() => tilesUrl(sourceId, baseUrl), [sourceId, baseUrl]);
    const { spec, maxZoom } = useMemo(() => zoomRange(zoom, tilejson), [zoom, tilejson]);

    const bboxStr = useMemo(
        () => (bbox ? bbox.map(fmt).join(',') : ''),
        [bbox],
    );

    const output = useMemo(() => {
        if (!bbox) return '';
        const tag = [fmt(bbox[0]), fmt(bbox[1]), fmt(bbox[2]), fmt(bbox[3])].join('-');
        return `${sourceId}_z${spec}_${tag}.mbtiles`;
    }, [bbox, sourceId, spec]);

    const dryRunCommand = useMemo(
        () => (bbox ? buildCommand({ bbox: bboxStr, zoomSpec: spec, url, output, dryRun: true }) : ''),
        [bbox, bboxStr, spec, url, output],
    );
    const crawlCommand = useMemo(
        () => (bbox ? buildCommand({ bbox: bboxStr, zoomSpec: spec, url, output, dryRun: false }) : ''),
        [bbox, bboxStr, spec, url, output],
    );

    // Drawing outside the source footprint is legal but pointless — the server
    // answers out-of-bounds requests with blank tiles. `--debug-bbox` is NOT
    // suggested (it would silently change the drawn box), so warn instead.
    const outsideBounds = useMemo(() => {
        const sb = tilejson?.bounds;
        if (!bbox || !Array.isArray(sb) || sb.length !== 4) return false;
        return bbox[2] < sb[0] || bbox[0] > sb[2] || bbox[3] < sb[1] || bbox[1] > sb[3];
    }, [bbox, tilejson]);

    const clampedLat = Math.abs(bbox?.[1] ?? 0) > MAX_LAT || Math.abs(bbox?.[3] ?? 0) > MAX_LAT;

    return (
        <div className="crawl-panel" role="group" aria-label="Crawl the drawn bbox">
            <div className="crawl-panel-head">
                <span className="crawl-panel-title">Crawl drawn area</span>
                <button type="button" className="crawl-panel-close" onClick={onClear} title="Clear the drawn bbox">
                    Clear
                </button>
            </div>

            <div className="crawl-panel-meta">
                <div><b>bbox</b> {bboxStr}</div>
                <div><b>zooms</b> {spec} <span className="crawl-panel-dim">(from z{Math.floor(zoom)} to source max {maxZoom})</span></div>
                <div><b>source</b> {sourceId}</div>
            </div>

            {outsideBounds && (
                <div className="crawl-panel-warn">
                    The drawn box is outside this source&apos;s bounds —
                    {' '}[{tilejson.bounds.map(fmt).join(', ')}] may be the only area with data.
                </div>
            )}
            {clampedLat && (
                <div className="crawl-panel-warn">
                    Latitude was clamped to ±{MAX_LAT} (Web Mercator limit).
                </div>
            )}

            <CommandBlock
                label="1 · Check the plan (writes nothing)"
                command={dryRunCommand}
                hint="Prints per-zoom tile counts so you can sanity-check the cost before crawling."
            />
            <CommandBlock
                label="2 · Download the tiles"
                command={crawlCommand}
                hint={`Writes ${output} into the current directory.`}
            />

            <div className="crawl-panel-foot">
                Run from the directory containing <code>fetch-tiles.mjs</code>.
            </div>
        </div>
    );
}

export default CrawlCommandPanel;
