import { useEffect, useRef } from 'react';
import { screenToGeo } from '../../../components/PointSelection/drawingUtils';

/**
 * Rubber-band rectangle picker for the Tileserver-RS (STAC) demo.
 *
 * Deliberately NOT built on `PointSelection/DrawingOverlay`: that component is
 * tuned for the selection-analysis flow (click-click-doubleclick finalize,
 * bufferDistance, 3D terrain picking via setDeckGLInstance). Its finalize path
 * also re-enters on every click, which for a rectangle would fire 2-4 times for
 * the same box. A drag gesture needs its own, simpler state machine.
 *
 * The parent MUST disable the deck.gl controller while this is mounted,
 * otherwise the drag pans the map instead of drawing. `TileserverTileMap` does
 * that with `controller={!drawMode}`.
 *
 * Emits a WGS84 bbox as `[west, south, east, north]`, matching the
 * `--bbox` argument of `fetch-tiles.mjs` exactly.
 */

// Web Mercator cannot represent the poles; deck.gl clamps here too.
const MAX_LAT = 85.05113;

/** Fold a longitude that the user drew on a repeated world copy into [-180, 180]. */
function wrapLon(lon) {
    const w = ((((lon + 180) % 360) + 360) % 360) - 180;
    // The modulo dance introduces float noise (11.2 -> 11.199999999999989).
    // Snap to 1e-9 deg (~0.1 mm) so the bbox stays clean in state and in the
    // generated command, instead of relying on the formatter to hide it.
    return Math.round(w * 1e9) / 1e9;
}

/**
 * Order the two drawn corners into a bbox. Longitude is wrapped first so a
 * rectangle drawn on deck.gl's repeated world copy (lon 370 etc.) yields the
 * same box as one drawn over the primary copy.
 *
 * NOTE: a box that genuinely spans the antimeridian collapses to the
 * complement of what was drawn. That is a known simplification — this picker is
 * for framing a crawl over a regional source, not for planet-scale work.
 */
function normalizeBox(a, b) {
    const lonA = wrapLon(a[0]);
    const lonB = wrapLon(b[0]);
    return [
        Math.min(lonA, lonB),
        Math.max(-MAX_LAT, Math.min(a[1], b[1])),
        Math.max(lonA, lonB),
        Math.min(MAX_LAT, Math.max(a[1], b[1])),
    ];
}

function CrawlBoxOverlay({ viewState, onComplete, onCancel }) {
    const canvasRef = useRef(null);
    const dragRef = useRef(null);
    const rectRef = useRef(null);
    const viewStateRef = useRef(viewState);
    const onCompleteRef = useRef(onComplete);
    const onCancelRef = useRef(onCancel);

    useEffect(() => { viewStateRef.current = viewState; }, [viewState]);
    useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
    useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);

    // Paint imperatively: pointermove fires ~60x/s and a setState per move would
    // re-render the whole map subtree for a purely visual change.
    const paint = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const r = rectRef.current;
        if (!r) return;
        const x = Math.min(r.x0, r.x1);
        const y = Math.min(r.y0, r.y1);
        const w = Math.abs(r.x1 - r.x0);
        const h = Math.abs(r.y1 - r.y0);
        ctx.fillStyle = 'rgba(0, 102, 204, 0.12)';
        ctx.strokeStyle = '#0066cc';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
    };

    // Keep the canvas backing store in sync with the map element on resize.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const resize = () => {
            const rect = canvas.parentElement.getBoundingClientRect();
            canvas.width = rect.width;
            canvas.height = rect.height;
            paint();
        };
        resize();
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);

    // Esc cancels the whole pick, not just the in-progress drag.
    useEffect(() => {
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            dragRef.current = null;
            rectRef.current = null;
            paint();
            onCancelRef.current?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const localPoint = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const handlePointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const p = localPoint(event);
        dragRef.current = { x0: p.x, y0: p.y };
        rectRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        paint();
    };

    const handlePointerMove = (event) => {
        if (!dragRef.current) return;
        const p = localPoint(event);
        rectRef.current = { ...dragRef.current, x1: p.x, y1: p.y };
        paint();
    };

    const handlePointerUp = (event) => {
        if (!dragRef.current) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        const r = rectRef.current;
        dragRef.current = null;
        const canvas = canvasRef.current;
        if (!r || !canvas) return;

        const a = screenToGeo(viewStateRef.current, r.x0, r.y0, canvas.width, canvas.height);
        const b = screenToGeo(viewStateRef.current, r.x1, r.y1, canvas.width, canvas.height);
        const box = normalizeBox(a.geo, b.geo);

        // A click without a drag (or a degenerate sliver) is not a usable bbox.
        if (box[2] - box[0] < 1e-9 || box[3] - box[1] < 1e-9) {
            rectRef.current = null;
            paint();
            return;
        }

        onCompleteRef.current?.(box);
    };

    return (
        <canvas
            ref={canvasRef}
            className="crawl-box-overlay"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        />
    );
}

export default CrawlBoxOverlay;
