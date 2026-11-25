import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Session-cumulative tile statistics for the Tileserver-RS demo.
 *
 * WHAT IT MEASURES
 *   - `count`  — tile responses since the page loaded (not since the last
 *                pan): the running total of tiles drawn this session.
 *   - `avgMs`  — mean network time of the tiles that actually required a
 *                fetch: request start to response complete, i.e. proxy +
 *                tileserver render + transfer. That is the time a tile costs,
 *                not just its last byte.
 *
 * WHY CACHE HITS ARE EXCLUDED FROM THE AVERAGE
 *   Once a tile is in the browser cache, re-requesting it resolves in ~1 ms and
 *   reports `transferSize: 0` with `deliveryType: "cache"` — while
 *   `encodedBodySize` still carries the full body size, so body size cannot be
 *   used to tell the two apart (measured, not assumed). Averaging cache hits in
 *   makes the figure collapse into a few milliseconds that describe a dictionary
 *   lookup, not tile rendering (observed: 84 of 87 entries were cache hits,
 *   dragging a ~50 ms reality down to 2.2 ms). So the average is taken over
 *   network-fetched tiles only, while the tile COUNT still includes every tile
 *   drawn. The two rows answer different questions by design: how many tiles
 *   were drawn, versus what a genuinely served tile costs.
 *
 * COUNTING WINDOW
 *   Entries older than the hook's watermark are ignored, and Reset Stats moves
 *   the watermark forward. Resource-Timing is replayed on every observer setup
 *   (buffered: true), so without a watermark a component remount would re-add
 *   the whole history and silently undo a Reset.
 *
 * WHY RESOURCE TIMING AND NOT deck.gl CALLBACKS
 *   deck.gl's TileLayer exposes `onTileLoad(tile)` but stamps no start time on
 *   the tile (verified: Tile2DHeader has no timing fields), and its `fetch`
 *   prop cannot wrap the built-in loader without re-implementing data
 *   resolution. The browser's Resource Timing API already records exactly this
 *   — one entry per real network request, with `duration` and `responseStatus`.
 *   So we observe those entries and aggregate. Nothing about tile loading is
 *   touched; the hook only reads measurements the browser already takes.
 *
 * SCOPE
 *   Only requests under `tileUrlPrefix` (the demo's own source) and ending in
 *   `.png` are counted, so basemap tiles, the health probe and the TileJSON
 *   fetch are excluded. Responses with an HTTP error status are skipped: a
 *   failed proxy/server response is not a drawn tile.
 *
 * Counters accumulate even while the panel is toggled OFF, because the total is
 * "since the beginning of the session", not "since the last toggle". The toggle
 * only controls the base-map hiding and whether the stats block is shown.
 * `resetStats` is the only thing that zeroes them.
 *
 * @param {object} opts
 * @param {string} opts.tileUrlPrefix - absolute-or-relative URL prefix that
 *        identifies this demo's tiles, e.g. `/tileserver-api/data/io-lulc/`.
 */
function useTileSessionStats({ tileUrlPrefix }) {
    const [timingEnabled, setTimingEnabled] = useState(true);
    const [count, setCount] = useState(0);
    const [avgMs, setAvgMs] = useState(null);

    // Totals in refs: the observer fires per resource batch and must not depend
    // on a re-render to read the current value.
    const countRef = useRef(0);          // tiles drawn (network + cache)
    const netTotalRef = useRef(0);       // summed network ms
    const netCountRef = useRef(0);       // network-fetched tiles
    // Ignore entries that finished before this instant. Seeded at mount and
    // advanced by resetStats so a buffered replay can never resurrect old tiles.
    const sinceRef = useRef(typeof performance !== 'undefined' ? performance.now() : 0);

    useLayoutEffect(() => {
        if (typeof performance === 'undefined' || typeof PerformanceObserver === 'undefined') {
            return undefined;
        }
        // Default buffer is 250 entries and tile-heavy panning blows through it,
        // dropping measurements. Raise it before observing. (Not supported in
        // every browser; the observer still works, it just may miss entries.)
        if (typeof performance.setResourceTimingBufferSize === 'function') {
            performance.setResourceTimingBufferSize(10000);
        }

        const accept = (entry) => {
            if (entry.entryType !== 'resource') return;
            if (!entry.name.includes(tileUrlPrefix)) return;
            // The TileJSON lives at .../data/<source>.json — only images count.
            if (!entry.name.includes('.png')) return;
            // `startTime` is measurement-clock based, the same clock as the
            // watermark, so this comparison is exact.
            if (entry.startTime < sinceRef.current) return;
            const status = entry.responseStatus;
            // Only a successfully delivered tile counts as "drawn". `responseStatus`
            // is 0 for a failed request (connection refused, proxy error) and >= 400
            // for an HTTP error — neither produced pixels, so neither belongs in the
            // count or the average. This reads the real status because the request is
            // same-origin (baseUrl is the Vite/reverse-proxy path), where the Resource
            // Timing entry exposes it; a cross-origin tile would report 0 and be
            // skipped, which is why tiles must stay behind the same-origin proxy.
            if (typeof status === 'number' && (status < 200 || status >= 400)) return;
            if (!Number.isFinite(entry.duration)) return;

            // Every tile delivered counts as drawn, cache hit or not.
            countRef.current += 1;
            setCount(countRef.current);

            // Only a genuine network fetch contributes to the average. `transferSize`
            // is the reliable discriminator: it is 0 for a cache hit even though
            // `encodedBodySize` still reports the body (verified on this stack), and
            // `deliveryType === 'cache'` states it explicitly.
            if (entry.transferSize === 0 || entry.deliveryType === 'cache') return;

            netTotalRef.current += entry.duration;
            netCountRef.current += 1;
            setAvgMs(netTotalRef.current / netCountRef.current);
        };

        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) accept(entry);
        });
        // buffered: true replays entries recorded before this effect ran, so
        // tiles that loaded during the first paint are not lost.
        observer.observe({ type: 'resource', buffered: true });
        return () => observer.disconnect();
    }, [tileUrlPrefix]);

    const resetStats = useCallback(() => {
        netTotalRef.current = 0;
        netCountRef.current = 0;
        countRef.current = 0;
        if (typeof performance !== 'undefined') sinceRef.current = performance.now();
        setCount(0);
        setAvgMs(null);
    }, []);

    const handleToggleTiming = useCallback(() => {
        setTimingEnabled(prev => !prev);
    }, []);

    return { timingEnabled, handleToggleTiming, count, avgMs, resetStats };
}

export { useTileSessionStats };
