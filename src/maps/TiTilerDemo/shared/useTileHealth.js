import { useState, useEffect, useRef, useCallback } from 'react';
import {
    PROBE_TIMEOUT_MS,
    TILE_ERROR_GRACE_MS,
    HEALTH_CHECK_INTERVAL_MS,
    fetchWithTimeout,
    isTiTilerReachable,
} from './endpoints';

/**
 * Shared reachability + tile-error handling for the TiTiler DEMO category
 * (extracted verbatim from the demos that previously copy-pasted it).
 *
 * On mount (and periodically) probes the endpoint; a total network failure
 * reports an 'unreachable' modal. Tile-level failures are debounced/deduped and
 * gated by an in-bounds probe tile: only systemic failures open a 'tile-error'
 * modal. 'unreachable' wins over symptom 'tile-error's.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl         - resolved base URL of the endpoint
 * @param {string} opts.healthUrl       - full /healthz URL
 * @param {string} opts.probeTileUrl    - a guaranteed in-bounds tile URL (probe)
 * @param {function} opts.onLayerReload - bumps the consumer's layer key to reload tiles on retry
 * @param {string} [opts.name]          - demo name used in the silent per-tile console.warn
 */
function useTileHealth({
    baseUrl,
    healthUrl,
    probeTileUrl,
    onLayerReload,
    name = 'TiTilerDemo',
}) {
    // null | { kind: 'unreachable' | 'tile-error', message, detail }
    const [modal, setModal] = useState(null);
    const [retrying, setRetrying] = useState(false);

    // Set when the user dismisses the modal: stay quiet while TiTiler stays down.
    // Auto-cleared as soon as a periodic check sees TiTiler reachable again, so a
    // later outage is reported again (the user asked for exactly that).
    const suppressedRef = useRef(false);
    const modalRef = useRef(null);
    modalRef.current = modal;
    // Debounce/dedupe machinery for tile errors (zoom/pan storms fire one error per tile).
    const errorTimerRef = useRef(null);
    const pendingErrorRef = useRef(null);

    // On mount: probe reachability; only a total network failure (timeout /
    // connection refused) reports "unreachable".
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ok = await isTiTilerReachable(healthUrl);
            if (!cancelled && !ok) {
                suppressedRef.current = false;
                setModal({
                    kind: 'unreachable',
                    message: `TiTiler is not reachable at ${baseUrl} (health check ${healthUrl} failed). Start it with the docker-compose command below, then press Retry.`,
                });
            }
        })();
        return () => { cancelled = true; };
    }, [healthUrl, baseUrl]);

    // Periodic reachability re-check (see HEALTH_CHECK_INTERVAL_MS): reports a
    // mid-session TiTiler outage even when every tile is served from cache, and
    // auto-lifts user suppression once TiTiler is back so the next outage reports.
    useEffect(() => {
        const interval = setInterval(async () => {
            const reachable = await isTiTilerReachable(healthUrl);
            if (reachable) {
                suppressedRef.current = false; // back up: a future outage should report again
                return;
            }
            if (suppressedRef.current || modalRef.current) return; // user dismissed / already reported
            setModal({
                kind: 'unreachable',
                message: `TiTiler became unreachable while the map was open (${baseUrl}). It was reachable before, so check whether the service stopped (docker compose logs) and press Retry.`,
            });
        }, HEALTH_CHECK_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [healthUrl, baseUrl]);

    // Unmount cleanup for the pending tile-error debounce timer.
    useEffect(() => () => {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    }, []);

    // Single-modal rule: an 'unreachable' modal wins over symptom 'tile-error's
    // (they are caused by the outage); same-kind updates keep the latest info.
    const showModal = useCallback((next) => {
        setModal(prev => {
            if (prev && prev.kind === 'unreachable' && next.kind === 'tile-error') return prev;
            if (prev && prev.kind === next.kind) return { ...prev, ...next };
            return next;
        });
    }, []);

    // Tile-level errors (endpoint up but tiles fail, endpoint dies mid-session, ...).
    // Debounced + deduped, and gated by a z0 probe: endpoints return 4xx for
    // tiles outside the COG bounds/zoom while the layer still renders fine, so
    // only systemic failures (probe fails too) open the modal.
    const handleTileError = useCallback((err) => {
        if (suppressedRef.current) return;
        pendingErrorRef.current = err;
        if (errorTimerRef.current) return;
        errorTimerRef.current = setTimeout(async () => {
            errorTimerRef.current = null;
            const err = pendingErrorRef.current;
            pendingErrorRef.current = null;
            if (!err || suppressedRef.current) return;

            // Probe the in-bounds tile: real HTTP status + JSON detail.
            let probeOk = false;
            let detail = '';
            try {
                const res = await fetchWithTimeout(probeTileUrl, PROBE_TIMEOUT_MS);
                probeOk = res.ok;
                if (!res.ok) {
                    detail = `HTTP ${res.status}`;
                    const body = await res.json().catch(() => null);
                    if (body && body.detail) {
                        detail += ` — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`;
                    }
                }
            } catch {
                probeOk = false;
            }

            if (probeOk) {
                // Endpoint healthy — the error is per-tile (e.g. tile outside the
                // COG bounds or beyond its zoom). Normal, keep quiet.
                console.warn(`[${name}] per-tile error while endpoint is healthy:`, err && err.message);
                return;
            }

            showModal({
                kind: 'tile-error',
                message: err && err.message ? `Tile loading failed: ${err.message}` : 'Tile loading failed.',
                detail,
            });
        }, TILE_ERROR_GRACE_MS);
    }, [probeTileUrl, showModal, name]);

    const handleDismiss = useCallback(() => {
        suppressedRef.current = true;
        setModal(null);
    }, []);

    // On endpoint switch we must drop any modal (it describes the previous
    // endpoint) and lift suppression, so the new endpoint gets a fresh
    // unreachable/tile-error report. The health/probe URLs changed, so the
    // mount-style check re-runs on its own.
    const resetForEndpoint = useCallback(() => {
        suppressedRef.current = false;
        setModal(null);
    }, []);

    const handleRetry = useCallback(async () => {
        setRetrying(true);
        // Cancel any in-flight debounced tile error so a stale one can't reopen the modal.
        if (errorTimerRef.current) {
            clearTimeout(errorTimerRef.current);
            errorTimerRef.current = null;
        }
        pendingErrorRef.current = null;
        try {
            let ok = false;
            if (modal && modal.kind === 'unreachable') {
                ok = await isTiTilerReachable(healthUrl);
            } else {
                // tile-error: probe the actual tile endpoint.
                try {
                    const res = await fetchWithTimeout(probeTileUrl, PROBE_TIMEOUT_MS);
                    ok = res.ok;
                    if (!ok) {
                        const body = await res.json().catch(() => null);
                        const detail = body && body.detail
                            ? `HTTP ${res.status} — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`
                            : `HTTP ${res.status}`;
                        showModal({ kind: 'tile-error', message: `Tile loading still fails (${baseUrl}).`, detail });
                    }
                } catch {
                    ok = false;
                    showModal({ kind: 'tile-error', message: `Tile endpoint still not reachable (${baseUrl}).`, detail: '' });
                }
            }

            if (ok) {
                suppressedRef.current = false;
                setModal(null);
                onLayerReload(); // recreate layer -> reload all tiles
            }
        } finally {
            setRetrying(false);
        }
    }, [modal, healthUrl, probeTileUrl, baseUrl, showModal, onLayerReload]);

    return {
        modal,
        retrying,
        handleRetry,
        handleDismiss,
        handleTileError,
        resetForEndpoint,
    };
}

export { useTileHealth };
