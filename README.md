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

## Live Demo

The latest version is deployed at: [https://gisat.github.io/app-gisat-deckglSandbox/](https://gisat.github.io/app-gisat-deckglSandbox/)
