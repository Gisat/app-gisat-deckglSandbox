import { useState, useEffect, useRef, useCallback } from 'react';
import { TIMING_SETTLE_MS } from './endpoints';

/**
 * Shared tile-timing measurement for the TiTiler DEMO category (extracted
 * verbatim from the four demos that previously copy-pasted it). Live values
 * track the current settled-viewport window; `headline` freezes the FIRST
 * (uncached) load of the session/endpoint.
 *
 * `headline` is always `{ ttf, tta, count }` — the single source of truth so
 * the HUD can never read a wrong field name again (see P0 #1).
 *
 * @param {object} opts
 * @param {function} opts.setViewState - the consumer's viewState setter; the
 *        returned handleViewStateChange forwards camera changes to it and then
 *        applies the settle-debounce timing logic.
 * @param {function} opts.onForceReload - bumps the consumer's layer key so the
 *        tile layer is recreated and all tiles reload (fresh measurement).
 */
function useTileTiming({ setViewState, onForceReload }) {
    // Timing HUD (opt-in via a toggle, default on). While enabled the basemap is
    // hidden so the measurement isn't confounded by cartocdn requests sharing the
    // same browser/network. Live values track the current settled-viewport window;
    // `headline` freezes the FIRST (uncached) load of the session/endpoint.
    const [timingEnabled, setTimingEnabled] = useState(true);
    const [ttf, setTtf] = useState(null);     // Time-to-First tile (ms) since settle
    const [tta, setTta] = useState(null);     // Time-to-All tiles (ms) since settle
    const [tileCount, setTileCount] = useState(0);
    const [headline, setHeadline] = useState(null); // { ttf, tta, count } | null

    // Timing measurement state lives in refs so onTileLoad stays cheap/stable.
    const measurementRef = useRef({
        settleAt: null,   // when the viewport settled → measurement window opened
        firstAt: null,    // first tile load in the window
        lastAt: null,     // last tile load seen
        count: 0,
        headlineDone: false,
    });
    const settleTimerRef = useRef(null);  // viewport-settle debounce
    const quiesceTimerRef = useRef(null); // "all tiles loaded" quiescence

    const resetMeasurement = useCallback(() => {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
        settleTimerRef.current = null;
        quiesceTimerRef.current = null;
        Object.assign(measurementRef.current, { settleAt: null, firstAt: null, lastAt: null, count: 0 });
        setTtf(null);
        setTta(null);
        setTileCount(0);
    }, []);

    // Open a fresh measurement window STARTING NOW (settleAt = this instant), so
    // any tile loads that follow are counted against this moment — no viewport
    // settle required. Used when the timer starts (toggle -> on) and when a new
    // endpoint is chosen (both recreate the tile layer and reload its tiles).
    // The caller is responsible for forcing the reload when that's the intent.
    const startMeasurementNow = useCallback(() => {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
        settleTimerRef.current = null;
        quiesceTimerRef.current = null;
        const m = measurementRef.current;
        m.settleAt = performance.now();
        m.firstAt = null;
        m.lastAt = null;
        m.count = 0;
        m.headlineDone = false;
        setTtf(null);
        setTta(null);
        setTileCount(0);
        setHeadline(null);
    }, []);

    // Viewport settle: every camera change restarts the debounce; when it fires we're
    // settled, so open a fresh measurement window from that moment.
    const handleViewStateChange = useCallback(({ viewState }) => {
        setViewState(viewState);
        if (!timingEnabled) return;
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            const m = measurementRef.current;
            m.settleAt = performance.now();
            m.firstAt = null;
            m.lastAt = null;
            m.count = 0;
            setTtf(null);
            setTta(null);
            setTileCount(0);
        }, TIMING_SETTLE_MS);
    }, [timingEnabled, setViewState]);

    // Per-tile load: update live TTF/TTA/count, and start/restart the quiescence
    // timer that declares "all tiles" and freezes the first (uncached) headline.
    const handleTileLoad = useCallback(() => {
        if (!timingEnabled) return;
        const m = measurementRef.current;
        if (m.settleAt == null) return; // still camera-moving; no open window yet
        const now = performance.now();
        if (m.firstAt == null) m.firstAt = now;
        m.lastAt = now;
        m.count += 1;
        setTileCount(m.count);
        setTtf(m.firstAt - m.settleAt);
        setTta(m.lastAt - m.settleAt);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
        quiesceTimerRef.current = setTimeout(() => {
            quiesceTimerRef.current = null;
            const mm = measurementRef.current;
            if (!mm.headlineDone && mm.firstAt != null && mm.lastAt != null && mm.count > 0) {
                mm.headlineDone = true;
                setHeadline({
                    ttf: mm.firstAt - mm.settleAt,
                    tta: mm.lastAt - mm.settleAt,
                    count: mm.count,
                });
            }
        }, TIMING_SETTLE_MS);
    }, [timingEnabled]);

    const handleToggleTiming = useCallback(() => {
        setTimingEnabled(prev => {
            const next = !prev;
            if (!next) {
                resetMeasurement(); // off: cancel pending timers + clear readout
                return next;
            }
            // ON: the clock starts counting at the moment of the press, not after a
            // viewport settle. Force a tile reload so the new window has something
            // to measure even without panning.
            onForceReload();
            startMeasurementNow();
            return next;
        });
    }, [resetMeasurement, startMeasurementNow, onForceReload]);

    // Fresh endpoint (or timing reset): force a reload and start the clock at this
    // instant so the new endpoint's tiles count immediately, and clear any frozen
    // headline from the previous endpoint.
    const resetForEndpoint = useCallback(() => {
        onForceReload();
        startMeasurementNow();
        setHeadline(null);
    }, [onForceReload, startMeasurementNow]);

    // Unmount cleanup for the pending measurement timers.
    useEffect(() => () => {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
    }, []);

    return {
        timingEnabled,
        ttf,
        tta,
        tileCount,
        headline,
        handleViewStateChange,
        handleTileLoad,
        handleToggleTiming,
        resetForEndpoint,
    };
}

export { useTileTiming };
