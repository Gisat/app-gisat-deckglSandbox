import { PolygonLayer } from '@deck.gl/layers';

/**
 * Tile outline + custom right-click context menu for the Tileserver-RS (STAC)
 * demo.
 *
 * `TileOutline` draws a single-tile red outline over the hovered tile; it is
 * rebuilt per hover (cheap — one polygon) and returns null when nothing is
 * hovered so it can be pushed unconditionally into the layer array.
 *
 * `TileContextMenu` is a custom menu shown at the pointer on right-click over
 * a tile. It lists the tile's z/x/y address and its WGS-84 bbox, and offers
 * copy actions (URL / z-x-y / bounds). The native browser menu is suppressed
 * upstream by the map wrapper's contextmenu listener, so this replaces it.
 *
 * The menu is positioned with `position: fixed` at the click point and clamps
 * to the viewport so it never opens off-screen.
 */
function TileOutline({ tile }) {
    if (!tile) return null;
    const { west, south, east, north } = tile;
    const ring = [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
    ];
    return new PolygonLayer({
        id: 'tile-outline-hover',
        data: [{ polygon: ring }],
        getPolygon: d => d.polygon,
        filled: false,
        stroked: true,
        getLineColor: [229, 56, 59, 255], // red, matches the sandbox error accent
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 2,
        pickable: false,
    });
}

/** Copy text with a clipboard-API -> execCommand fallback. Returns a promise. */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API can reject (permissions / insecure context). Fall back
        // to a hidden textarea + execCommand.
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    }
}

/**
 * Custom right-click menu for a tile.
 *
 * @param {object|null} tile     - the tile under the cursor (its url/bbox/z/x/y)
 * @param {string|null} label    - pre-formatted "z / x / y" label
 * @param {{x:number,y:number}|null} position - client coords of the click
 * @param {function} onClose     - dismiss the menu (outside click / Esc / action)
 */
function TileContextMenu({ tile, label, position, onClose }) {
    if (!tile || !position) return null;

    const bounds = `${tile.west.toFixed(4)}, ${tile.south.toFixed(4)} → ${tile.east.toFixed(4)}, ${tile.north.toFixed(4)}`;

    const runCopy = (text) => {
        void copyText(text);
        onClose();
    };

    // Clamp so the menu never opens past the viewport edge.
    const MENU_W = 320;
    const MENU_H = 190;
    const left = Math.min(position.x, window.innerWidth - MENU_W - 8);
    const top = Math.min(position.y, window.innerHeight - MENU_H - 8);

    return (
        <div
            className="tileserver-tile-menu"
            style={{ left, top }}
            role="menu"
            // The wrapper's contextmenu handler already prevents the native menu;
            // stop propagation so a right-click inside the menu doesn't retrigger.
            onContextMenu={e => e.preventDefault()}
        >
            <div className="tileserver-tile-menu-info">
                <div className="tileserver-tile-menu-title">Tile</div>
                <div className="tileserver-tile-menu-row">
                    <span className="tileserver-tile-menu-key">XYZ</span>
                    <span className="tileserver-tile-menu-val">{label}</span>
                </div>
                <div className="tileserver-tile-menu-row">
                    <span className="tileserver-tile-menu-key">Bounds</span>
                    <span className="tileserver-tile-menu-val">{bounds}</span>
                </div>
                <div className="tileserver-tile-menu-row">
                    <span className="tileserver-tile-menu-key">URL</span>
                    <span className="tileserver-tile-menu-url" title={tile.url}>{tile.url}</span>
                </div>
            </div>
            <div className="tileserver-tile-menu-sep" />
            <button type="button" role="menuitem" className="tileserver-tile-menu-item"
                onClick={() => runCopy(tile.url)}>
                Copy tile URL
            </button>
            <button type="button" role="menuitem" className="tileserver-tile-menu-item"
                onClick={() => runCopy(`${tile.z}/${tile.x}/${tile.y}`)}>
                Copy z/x/y
            </button>
            <button type="button" role="menuitem" className="tileserver-tile-menu-item"
                onClick={() => runCopy(bounds)}>
                Copy bounds
            </button>
        </div>
    );
}

export { TileOutline, TileContextMenu, copyText };
