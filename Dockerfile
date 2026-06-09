# =============================================================================
# Stage 1 — Build frontend (Vite/React, always built at base /)
# =============================================================================
FROM node:18-alpine AS builder

WORKDIR /build

# Install dependencies (layered before source for caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build (base path is always /, overridden at runtime via VITE_BASE)
COPY vite.config.js index.html ./
COPY src/         src/
COPY public/      public/
RUN npm run build


# =============================================================================
# Stage 2 — Runtime (Python 3.10)
# =============================================================================
FROM python:3.10-slim

WORKDIR /app

# --- Python dependencies ---
COPY src/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Backend application ---
COPY src/backend/ .

# --- Built frontend (from Stage 1) ---
COPY --from=builder /build/dist/ ./dist/

# --- Entrypoint + static file server ---
COPY entrypoint.sh serve_web.py ./
RUN chmod +x entrypoint.sh

# --- Data directory (for optional volume mount) ---
RUN mkdir -p /app/data

# --- Runtime configuration ---
EXPOSE 5000

# Base path for the web frontend (e.g. /app-gisat-deckglSandbox/). Applied at runtime.
ENV VITE_BASE=/

# Path or HTTPS URL to the geoparquet data file (backend mode only)
ENV GEOPARQUET_PATH=https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/geoparquet/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet

# Backend API URL the frontend calls at runtime (web mode only, empty = fallback to localhost:5000)
ENV BACKEND_API_URL=

ENTRYPOINT ["/app/entrypoint.sh"]
CMD []
