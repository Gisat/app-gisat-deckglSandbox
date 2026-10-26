window.VITE_BASE = null;
window.BACKEND_API_URL = null;
window.CARTO_API_KEY = null;
// Base prefix of the TiTiler caching stack's API (same nginx serves titiler /
// float32 / terrarium under one prefix). Injected at runtime by serve_web.py
// from the TITILER_API_BASE env var; null => client falls back to
// VITE_TITILER_API_BASE or the local '/titiler/api/v1' default.
window.TITILER_API_BASE = null;
