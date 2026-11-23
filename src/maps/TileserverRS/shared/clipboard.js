/**
 * Clipboard helper for the Tileserver-RS demos.
 *
 * Lives in its own module (not in a component file) so component modules stay
 * component-only — that is what the `react-refresh/only-export-components`
 * lint rule wants, and it lets both the tile context menu and the endpoint
 * panel share one implementation instead of two copy paths drifting apart.
 */

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

export { copyText };
