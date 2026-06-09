# Plan: Unified Dockerfile with Web/Backend Mode

## Context
The project currently has a backend-only Dockerfile at `src/backend/Dockerfile` that runs the Flask/DuckDB service. There is no Dockerfile for the frontend (Vite/React) application. We need a single Dockerfile at the project root that can serve either the built web application or the backend service, controlled by a CLI flag.

## Changes
1. **Modify `vite.config.js`** — Support `VITE_BASE` env var to override base path during Docker builds (defaults to `/` so Docker serves at root, unlike GitHub Pages which needs `/app-gisat-deckglSandbox/`)
2. **Create root `Dockerfile`** — Multi-stage: Node 18 alpine builds frontend → Python 3.10-slim runs either service
3. **Create `entrypoint.sh`** — Bash dispatcher accepting `--mode web|backend` and `--port N`
4. **Create `serve_web.py`** — Simple Python HTTP server with SPA fallback for serving the built frontend
5. **Create `.dockerignore`** — Exclude node_modules, dist, .git, plans, etc.

## Files Modified/Created
| File | Action |
|------|--------|
| `vite.config.js` | Modify — add `VITE_BASE` env var support |
| `Dockerfile` | Create — multi-stage build |
| `entrypoint.sh` | Create — mode dispatcher |
| `serve_web.py` | Create — SPA static server |
| `.dockerignore` | Create — build exclusions |

## Verification
- `npm run lint` passes
- Docker build dry-run: `docker build --target builder .` builds frontend stage successfully
- `docker build -t sandbox .` produces a working image
- `docker run sandbox --mode web` serves frontend at port 5000
- `docker run sandbox --mode backend` starts gunicorn on port 5000
