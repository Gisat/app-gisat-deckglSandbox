import '../../TiTilerDemo/shared/TiTilerErrorModal.css';

/**
 * Modal reporting the tileserver-rs endpoint when it is unreachable or
 * returns tile errors. Mirrors TiTilerDemo/shared/TiTilerErrorModal.jsx
 * (same layout/classes — CSS is imported from there verbatim) with
 * tileserver-rs wording. The startup instruction mirrors the selected
 * deployment (deploy/tileserver/docker-compose.yml).
 *
 * @param {string} kind            - 'unreachable' (health probe failed) | 'tile-error' (tile requests failed)
 * @param {string} baseUrl         - resolved base URL (Vite proxy path) of the endpoint
 * @param {string} healthUrl       - full /health URL
 * @param {string} tileUrlTemplate - tile URL template actually used by the TileLayer
 * @param {string|null} startCommand - docker compose command to start the stack
 * @param {string} errorMessage    - human-readable error (may be empty)
 * @param {string} errorDetail     - enriched detail (HTTP status + tileserver-rs JSON error)
 * @param {function} onRetry       - retry handler
 * @param {function} onDismiss     - dismiss handler
 * @param {boolean} retrying       - true while a retry probe is in flight
 */
function TileserverErrorModal({
    kind,
    baseUrl,
    healthUrl,
    tileUrlTemplate,
    startCommand = null,
    errorMessage,
    errorDetail,
    onRetry,
    onDismiss,
    retrying = false,
}) {
    const title = kind === 'unreachable'
        ? 'tileserver-rs endpoint unreachable'
        : 'tileserver-rs tile error';

    const intro = kind === 'unreachable'
        ? 'The tileserver-rs service that renders these tiles could not be reached. Tiles cannot be drawn until it is running.'
        : 'The tileserver-rs service returned errors while rendering tiles. See the expected endpoint and error details below.';

    return (
        <div className="titiler-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="tileserver-modal-title">
            <div className="titiler-modal-card">
                <div className="titiler-modal-header">
                    <span className="titiler-modal-title" id="tileserver-modal-title">{title}</span>
                    <button type="button" className="titiler-modal-close" onClick={onDismiss} aria-label="Close">×</button>
                </div>

                <p className="titiler-modal-intro">{intro}</p>

                <div className="titiler-modal-section">
                    <div className="titiler-modal-section-title">Expected tileserver-rs endpoint</div>
                    <div className="titiler-modal-endpoint">
                        <div><span className="label">Base URL</span><span>{baseUrl}</span></div>
                        <div><span className="label">Health</span><span>{healthUrl}</span></div>
                        <div><span className="label">Tiles</span><span>{tileUrlTemplate}</span></div>
                    </div>
                    <div className="titiler-modal-note">
                        Base URL is the same-origin Vite proxy path to the local stack (<code>deploy/tileserver/docker-compose.yml</code>, built from the sibling <code>tileserver-rs</code> checkout — see its <code>USAGE.md</code>).
                    </div>
                </div>

                <div className="titiler-modal-section">
                    <div className="titiler-modal-section-title">How to start it</div>
                    {startCommand ? (
                        <>
                            <pre className="titiler-modal-command">{startCommand}</pre>
                            <div className="titiler-modal-note">The first build compiles the Rust server (several minutes). After it is up, wait for the health check to pass, then press Retry.</div>
                        </>
                    ) : (
                        <div className="titiler-modal-note">
                            This endpoint has no local compose command — start that instance however it is deployed, then press Retry.
                        </div>
                    )}
                </div>

                {(errorMessage || errorDetail) && (
                    <div className="titiler-modal-error">
                        <strong>Error:</strong> {errorMessage || 'Unknown error'}
                        {errorDetail ? <div className="titiler-modal-error-detail">{errorDetail}</div> : null}
                    </div>
                )}

                <div className="titiler-modal-actions">
                    <button type="button" className="titiler-modal-btn titiler-modal-btn-secondary" onClick={onDismiss} disabled={retrying}>Close</button>
                    <button type="button" className="titiler-modal-btn titiler-modal-btn-primary" onClick={onRetry} disabled={retrying}>
                        {retrying ? 'Checking…' : 'Retry'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default TileserverErrorModal;
