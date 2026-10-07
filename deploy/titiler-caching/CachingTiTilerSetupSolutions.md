# Caching TiTiler setup — issues & solutions (2026-09-02)

**Date:** 2026-09-02 · **Component:** `deploy/titiler-caching/` (nginx :8001 → TiTiler :8081, disk proxy-cache)
**Repo:** `app-gisat-deckglSandbox` (sandbox web app + local TiTiler deploys)

Session summary of the questions raised while setting up the caching TiTiler
stack and comparing it with the plain one — what was asked, what the actual
answer/solution was, and where it landed. Companion docs in this directory:
[`USAGE.md`](USAGE.md) (how to run/use the stack),
[`NGINX-CacheConcepts.md`](NGINX-CacheConcepts.md) (caching semantics, purge).

---

## 1. Can `deploy/titiler-caching/` and `deploy/titiler/` run at the same time?

**Yes — no conflict, no port change strictly needed.** They are separate
compose projects (separate networks, container names, volumes):

| Stack | Compose file | Host port | TiTiler inside |
| --- | --- | --- | --- |
| plain | `deploy/titiler/docker-compose.yml` | `8000` → TiTiler | uvicorn :8000 |
| caching | `deploy/titiler-caching/docker-compose.yml` | `8001` → nginx | uvicorn :8081 (internal, **not** published) |

- The caching stack's TiTiler listens on `8081` but is only reachable through
  nginx; it was already designed to coexist.
- Cache volume is project-scoped (`titiler-caching_tile-cache`). After moving
  the folder from an older name, the stack starts with a **cold cache**; the
  old volume stays orphaned until `docker volume prune`.

**Gotcha — the URLs differ, not just the port:**

| Endpoint | Base URL the client must use |
| --- | --- |
| plain | `http://localhost:8000` (no prefix) |
| caching | `http://localhost:8001/api/v1/titiler` (nginx strips the prefix via `rewrite`; uvicorn `--root-path` keeps docs consistent) |

Plain `http://localhost:8001/...` (without `/api/v1/titiler`) returns nginx
404 — the location guard only matches the prefixed path (plus exact
`/healthz`).

## 2. Port change: caching stack on `8001` (was `8080`)

Requested so both stacks run side by side on adjacent, easy-to-remember ports.

- `deploy/titiler-caching/docker-compose.yml`: nginx publishes `"8001:80"`.
- `deploy/titiler-caching/test-cache.sh`: default `BASE=...:8001/api/v1/titiler`.
- All docs/commands in `USAGE.md` updated to `:8001`.
- TiTiler stays on internal `:8081` (upstream `server titiler:8081` in
  `nginx.conf`); add `ports: ["8081:8081"]` only if you want it directly
  reachable on the host too.

## 3. Cache expiry: 7 days → 1 hour

Two knobs that must stay in sync (nginx prefers the upstream
`Cache-Control` `max-age` over `proxy_cache_valid` when deciding validity):

- `deploy/titiler-caching/nginx.conf`: `proxy_cache_valid 200 301 302 1h;`
  (was `7d`). `404 = 1m` and LRU eviction `inactive=14d` unchanged (separate
  clock).
- `deploy/titiler-caching/docker-compose.yml`:
  `TITILER_API_CACHECONTROL=public, max-age=3600` (was `604800`).

Effect: a rendered tile is valid for **render-time + 1 h** both in the nginx
disk cache and for compliant clients; after that the next request re-renders
once and is stored again. Data updates propagate as a wave at T₀+1 h.

## 4. UI switch between plain and caching TiTiler in the sandbox app

`src/maps/TiTilerDemo/TiTilerTileMap.jsx` previously hardcoded
`http://localhost:8000`. Added an endpoint switcher (top-right card):

- Presets: **plain** → `http://localhost:8000`, **caching** →
  `http://localhost:8001/api/v1/titiler` — each carrying the compose
  `startCommand` for its stack.
- `VITE_TITILER_URL` (`.env`) still honored: if it points at a non-preset
  URL it appears as a third "Custom (env)" option; if it equals a preset it
  selects that one. No env → unchanged default (plain).
- All URLs (`tileUrl`, `probeTileUrl`, `healthUrl`) derive from the selected
  base URL, so health probing, tile-error gating and Retry follow the switch.
- On switch: dismiss any open modal, clear suppression, bump `titilerLayerKey`
  (recreate TileLayer → reload tiles from the new endpoint). The reachability
  probe re-runs because `healthUrl` changed.
- Choice persists in `localStorage` (`titiler-demo-endpoint`).
- `TiTilerErrorModal.jsx`: hardcoded start command replaced by a
  `startCommand` prop, so "How to start it" always matches the selected stack.
- New `src/maps/TiTilerDemo/TiTilerEndpointSwitch.css` (z-index 900, below the
  error modal's 1000).

## 5. Bug: Uganda/Nepal demos fail through the caching stack, Manila works (nginx 414)

**Symptom:** on the caching endpoint, "Manila RGB" renders fine, but "Uganda
Multiband" and "Nepal Snow Cover" show the tile-error modal
("HTTP 414" detail). Same demos work on the plain `:8000` instance.

**Root cause — nginx request-line limit, not TiTiler:**
Uganda/Nepal pass their full 256-entry colormap inline as **url-encoded JSON
in the query string**, producing tile URLs far above nginx's default cap:

| Case | Tile URL length | nginx default (`large_client_header_buffers 4 8k`: request line ≤ one 8 KB buffer) | Result |
| --- | --- | --- | --- |
| Manila RGB (no colormap) | ~200–300 chars | fits | ✅ works |
| Uganda (colormap alone ≈ 9.0 KB, 257 entries) | **9 242** chars | exceeds | ❌ **414 Request-URI Too Large** |
| Nepal Snow (encoded colormap ≈ 10.3 KB) | ~10.9 KB | exceeds | ❌ 414 |

nginx rejects the request **before proxying** — TiTiler never sees it, so
nothing about the caching TiTiler config was wrong. The plain stack has no
nginx in front (uvicorn accepts the same URLs), which is why the identical
URLs worked on `:8000`.

**Why the error surfaced as the tile-error modal:** deck.gl TileLayer requests
get HTTP 414 → `onTileError` fires → the z0 probe tile is *also* 414 →
probe fails → modal kind `tile-error` (detail "HTTP 414"). `/healthz` stays
short, so "unreachable" never triggers — nginx was healthy all along.

**Fix (one line, verified):** in `deploy/titiler-caching/nginx.conf` (http block):

```nginx
# Long tile URLs: the DEMO COGs pass the full 256-entry colormap inline as
# url-encoded JSON in the query string (~9-11 KB request line; nginx's
# default 8 KB buffer would 414 them before proxying). One buffer of 32k
# caps the request line at ~32 KB - plenty of headroom.
large_client_header_buffers 4 32k;
```

Then recreate/restart the nginx container:
`docker compose -f deploy/titiler-caching/docker-compose.yml up -d`
(nginx config is baked via bind-mount `./nginx.conf:/etc/nginx/nginx.conf:ro`,
so a restart/recreate picks it up). Verified working: all three demos render
through the caching endpoint after the change.

**Diagnosis recipe (for future reference):**
1. Grab a failing tile URL from the error modal and measure its length:
   `echo -n "<url>" | wc -c`.
2. Reproduce the status code directly:
   `curl -s -o /dev/null -w "%{http_code}\n" "<long-url-against-:8001>"` → 414
   vs the same URL against `:8000` → 200.
3. Recall the nginx rule: *"A request line cannot exceed the size of one
   buffer, or the 414 (Request-URI Too Large) error is returned."* — with
   default `4 8k` that cap is 8 KB. Bump via `large_client_header_buffers`.

---

## Files touched in this session (final state)

```
deploy/titiler-caching/
├── docker-compose.yml      # nginx "8001:80"; TiTiler :8081 internal; max-age=3600
├── nginx.conf              # + large_client_header_buffers 4 32k; proxy_cache_valid 1h
├── USAGE.md                # created — run/compare both stacks
├── NGINX-CacheConcepts.md  # moved here from repo root; header aligned to this component
├── CachingTiTilerSetupSolutions.md  # this file
├── test-cache.sh           # BASE default → :8001
└── data/                   # local COGs mount (./data:/data:ro)
src/maps/TiTilerDemo/
├── TiTilerTileMap.jsx          # endpoint switcher (plain/caching/custom) + localStorage
├── TiTilerErrorModal.jsx       # startCommand prop (per selected endpoint)
├── TiTilerEndpointSwitch.css   # new — top-right control card
└── (NepalSnow/UgandaLUC/ManilaRGB unchanged — switch lives in the shared map)
```
