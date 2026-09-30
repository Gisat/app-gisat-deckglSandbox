import './TiTilerErrorModal.css';

/**
 * Modal reporting which TiTiler endpoint is expected to run when it is
 * unreachable or returns tile errors. The endpoint + startup instructions
 * are provided by the caller and mirror the selected deployment
 * (deploy/titiler/docker-compose.yml or deploy/titiler-caching/docker-compose.yml).
 *
 * @param {string} kind            - 'unreachable' (health probe failed) | 'tile-error' (tile requests failed)
 * @param {string} baseUrl         - resolved TiTiler base URL of the selected endpoint
 * @param {string} healthUrl       - full /healthz URL
 * @param {string} tileUrlTemplate - tile URL template actually used by the TileLayer
 * @param {string} cogUrl          - COG passed to TiTiler as `url` param
 * @param {string|null} startCommand - docker compose command to start the selected stack
 *                                     (null for custom/deployed endpoints without a local stack)
 * @param {string} errorMessage    - human-readable error (may be empty)
 * @param {string} errorDetail     - enriched detail (HTTP status + TiTiler JSON detail)
 */
function TiTilerErrorModal({
    kind,
    baseUrl,
    healthUrl,
    tileUrlTemplate,
    cogUrl,
    startCommand = null,
    errorMessage,
    errorDetail,
    onRetry,
    onDismiss,
    retrying = false,
}) {
    const isMixedContent = typeof window !== 'undefined'
        && window.location.protocol === 'https:'
        && /^http:/.test(baseUrl);

    const title = kind === 'unreachable'
        ? 'TiTiler endpoint unreachable'
        : 'TiTiler tile error';

    const intro = kind === 'unreachable'
        ? 'The TiTiler service that renders these COG tiles could not be reached. Tiles cannot be drawn until it is running.'
        : 'The TiTiler service returned errors while rendering tiles. See the expected endpoint and error details below.';

    return (
        <div className="titiler-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="titiler-modal-title">
            <div className="titiler-modal-card">
                <div className="titiler-modal-header">
                    <span className="titiler-modal-title" id="titiler-modal-title">{title}</span>
                    <button type="button" className="titiler-modal-close" onClick={onDismiss} aria-label="Close">×</button>
                </div>

                <p className="titiler-modal-intro">{intro}</p>

                <div className="titiler-modal-section">
                    <div className="titiler-modal-section-title">Expected TiTiler endpoint</div>
                    <div className="titiler-modal-endpoint">
                        <div><span className="label">Base URL</span><span>{baseUrl}</span></div>
                        <div><span className="label">Health</span><span>{healthUrl}</span></div>
                        <div><span className="label">Tiles</span><span>{tileUrlTemplate}</span></div>
                        <div><span className="label">COG</span><span>{cogUrl}</span></div>
                    </div>
                    <div className="titiler-modal-note">
                        Base URL is set by the endpoint switcher (top right of the map); a <code>VITE_TITILER_URL</code> override (see <code>.env.example</code>) adds a custom entry. Default is <code>http://localhost:8000</code> (plain TiTiler).
                    </div>
                </div>

                <div className="titiler-modal-section">
                    <div className="titiler-modal-section-title">How to start it</div>
                    {startCommand ? (
                        <>
                            <pre className="titiler-modal-command">{startCommand}</pre>
                            <div className="titiler-modal-note">After starting, wait a moment for the health check to pass, then press Retry.</div>
                        </>
                    ) : (
                        <div className="titiler-modal-note">
                            This endpoint comes from <code>VITE_TITILER_URL</code> and has no local compose command — start that instance however it is deployed, then press Retry.
                        </div>
                    )}
                </div>

                {(errorMessage || errorDetail) && (
                    <div className="titiler-modal-error">
                        <strong>Error:</strong> {errorMessage || 'Unknown error'}
                        {errorDetail ? <div className="titiler-modal-error-detail">{errorDetail}</div> : null}
                    </div>
                )}

                {isMixedContent && (
                    <div className="titiler-modal-warning">
                        This page is served over HTTPS but the TiTiler endpoint is HTTP — browsers block the mixed-content request.
                        Point <code>VITE_TITILER_URL</code> at an HTTPS TiTiler instance or serve the sandbox over HTTP.
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

export default TiTilerErrorModal;
