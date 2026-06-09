# app-gisat-deckglSandbox

A sandbox application for exploring geospatial data visualization using Deck.GL, React, and Vite.

## Features

- Multiple interactive map demos (3D Tiles, GeoParquet, terrain, point clouds, and more)
- Modern React frontend with Vite for fast development
- Custom Deck.GL layers (e.g., DuckDBGeoParquetLayer)
- Easily extensible with new map apps in `src/maps/`

## Getting Started

```bash
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

## Project Structure

- `src/maps/` — Individual map demo apps (see `src/maps/config.js`)
- `src/layers/` — Custom Deck.GL layers
- `src/App.jsx` — Main app and router

## Build & Deploy

```bash
npm run build
npm run preview
npm run deploy
```

## Docker

A single Docker image serves both the web frontend and the backend API. The mode is controlled via the `MODE` environment variable.

### Environment Variables

| Variable | Default | Service | Description |
|----------|---------|---------|-------------|
| `MODE` | `web` | both | `web` serves the frontend, `backend` runs the Flask API |
| `PORT` | `5000` | both | Port the service listens on |
| `VITE_BASE` | `/` | web | Base path for the frontend (e.g. `/app-gisat-deckglSandbox/`) |
| `BACKEND_API_URL` | *(empty → falls back to `http://localhost:5000`)* | web | Backend API URL the frontend calls |
| `GEOPARQUET_PATH` | S3 URL | backend | Path or HTTPS URL to the geoparquet data file |

### Quick Start

```bash
# Build
docker build -t sandbox .

# Serve frontend
docker run -p 5000:5000 sandbox

# Serve backend (reads geoparquet from S3 by default)
docker run -p 5000:5000 -e MODE=backend sandbox
```

### Run — Web Frontend with External Backend

```bash
docker run -p 5000:5000 -e BACKEND_API_URL=http://backend-host:5000 sandbox
```

### Run — Backend with Local Data

```bash
docker run -p 5000:5000 -e MODE=backend \
  -e GEOPARQUET_PATH=/app/data/local.geoparquet \
  -v ./data:/app/data \
  sandbox
```

### Custom Port

```bash
docker run -p 8080:8080 -e PORT=8080 sandbox
```

### Sub-Path Deployment

```bash
docker run -p 5000:5000 -e VITE_BASE=/my-app/ sandbox
```

## Live Demo

The latest version is deployed at: [https://gisat.github.io/app-gisat-deckglSandbox/](https://gisat.github.io/app-gisat-deckglSandbox/)
