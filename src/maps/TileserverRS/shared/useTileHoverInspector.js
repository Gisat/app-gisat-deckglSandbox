import { useState, useMemo, useCallback } from 'react';

/**
 * Tile-hover inspector for the Tileserver-RS (STAC) demo.
 *
 * deck.gl's own mechanism, not a DOM listener: the hovered tile is read from
 * the picking info deck.gl hands to `<DeckGL onHover={...}>`. Per the deck.gl
 * source (lib/deck.js `_applyHoverCallbacks`):
 *
 *   for (const info of result) handled = info.layer?.onHover(info, event);
 *   if (!handled) this.props.onHover?.(pickedInfo, event);
 *
 * `result` is the pick list, one entry per picked layer, top-most first, and
 * `pickedInfo` ends up as the LAST entry that was iterated. The TileLayer
 * renders nothing itself; its `renderSubLayers` produces a BitmapLayer, and
 * `TileLayer.getPickingInfo` enriches that sub-layer's pick with
 * `info.tile = sourceTile`. So the tile-carrying info is the one whose
 * `info.tile` is set.
 *
 * `DeckGL onHover` receives a single `info` (the last iterated pick). We scan
 * for the tile on it; if absent we treat it as "pointer off the tiles". This is
 * the mechanism deck.gl expects — there is no need to attach a handler to the
 * layer, and DOM pointer events are ignored by deck.gl's gesture/picking path.
 *
 * @param {object} opts
 * @param {string} opts.tileUrl - the TileLayer's data template
 *        (`.../data/{source}/{z}/{x}/{y}.png`); `{z}/{x}/{y}` are substituted
 *        per picked tile so the menu shows the exact URL that was requested.
 */
function useTileHoverInspector({ tileUrl }) {
    const [hoveredTile, setHoveredTile] = useState(null);

    // Build the concrete request URL for a picked tile. deck.gl's TileLayer
    // exposes `tile.index` = { x, y, z }, so substitution is exact.
    const buildTileUrl = useCallback((tile) => {
        const { x, y, z } = tile.index;
        return tileUrl
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
    }, [tileUrl]);

    // `onHover` is called with a single `info` (deck.gl's pickedInfo). The tile
    // rides on `info.tile`; `info.sourceTile` is the same object in deck.gl 9.
    // Accept either so a version difference cannot silently break the menu.
    const handleHover = useCallback((info) => {
        const tile = info?.tile ?? info?.sourceTile ?? null;
        if (!tile || !tile.index || !tile.bbox) {
            // Pointer left every pickable tile (or the tile has no footprint):
            // clear the highlight.
            setHoveredTile(prev => (prev === null ? prev : null));
            return;
        }
        const { x, y, z } = tile.index;
        const { west, south, east, north } = tile.bbox;
        // Only update state when the hovered tile actually changes, so a plain
        // mouse move within one tile does not re-render on every event.
        setHoveredTile(prev => {
            if (prev && prev.z === z && prev.x === x && prev.y === y) return prev;
            return {
                z, x, y,
                west, south, east, north,
                url: buildTileUrl(tile),
                urlTemplate: tileUrl,
            };
        });
    }, [buildTileUrl, tileUrl]);

    const label = useMemo(
        () => (hoveredTile ? `z${hoveredTile.z} / x${hoveredTile.x} / y${hoveredTile.y}` : null),
        [hoveredTile]);

    return { hoveredTile, label, handleHover };
}

export { useTileHoverInspector };
