# NGINX Cache Concepts — TiTiler tile-cache stack

**Date:** 2026-09-02 · **Component:** `deploy/titiler-caching/` (nginx :8001 → TiTiler :8081, disk proxy-cache)

Concise extraction of Q&A answers on the caching behavior of this stack. Companion to
[`titiler-nginx-cache-2026-08-20.md`](../../../titiler-nginx-cache-2026-08-20.md) (debugging write-up of the same deploy).

---

## 1. `docker-compose.yml` env vars — what they control

| Variable | What it does |
|---|---|
| `TITILER_API_CACHECONTROL=public, max-age=3600` | Sets the `Cache-Control` header TiTiler adds to **every successful GET/HEAD response** (status < 500, `/healthz` excluded) via `CacheControlMiddleware`. `3600` = 1 hour; `public` permits shared caches. **Default is no header at all** — this line does real work. |
| `TITILER_API_TELEMETRY_ENABLED=False` | Disables OpenTelemetry tracing inside TiTiler: no OTLP span exporter, no FastAPI/Logging auto-instrumentation, no per-router telemetry. **`False` is also the default** — the line is explicit/documentation. Set `True` only with an OTLP collector available. |

Both are read by TiTiler (`ApiSettings`, prefix `TITILER_API_`); **nginx never sees them**.

---

## 2. Client respects vs. ignores `Cache-Control`

- **Respecting client** (browser, GIS app, CDN): caches the tile locally and serves it for 1 hour; repeat requests for the same URL never touch the network. Expiry is anchored to the response `Date` (see §3), and the full query string is part of the identity.
- **Ignoring client** (misconfigured app, devtools "disable cache", SDKs with HTTP caching off): every request re-downloads from nginx — but nginx still answers `HIT` from disk and **TiTiler only renders cold tiles**. nginx's `proxy_cache` here does *not* honor client `no-cache`; its `$no_cache` flag is URI-based only.
- Map libraries (Leaflet/OpenLayers/MapLibre) keep **in-memory tile grids** that ignore HTTP rules but die with the page; the header is what extends caching across reloads/sessions.

```
respecting client:  browser cache (1h) ──► nginx disk cache (1h) ──► TiTiler (rarely hit)
ignoring client:    network every time ──► nginx disk cache (HIT) ──► TiTiler (cold only)
```

---

## 3. Timing model — why `proxy_cache_valid 1h` and `max-age=3600` stay in sync

Both clocks anchor to the **same instant T₀ (first render/store)** — they do not drift apart.

- **nginx side:** `proxy_cache_valid 1h` is an *absolute* expiry stamped at store time: `valid_sec = now + 1h`. First request after that forces an upstream refetch.
- **Client side:** `max-age` does **not** count from client receipt. Clients compute age ≈ `now − Date` (RFC 9111) and stay fresh while `age < max-age`.
- **The linchpin (verified in nginx source):** on a cache HIT, nginx replays the **stored upstream headers verbatim** — no `Age` header added, `Date` not refreshed. So every HIT carries the *original render-time `Date`* next to the original `max-age`. Every client, regardless of when it fetches, computes the same wall-clock expiry: **render time + 1h**.

Result: a client fetching at T₀+50 min (nginx-side) sees `age ≈ 50 min` and holds the tile only ~10 more minutes — expiring in lockstep with nginx at T₀+1h, not T₀+110 min.

- **Bonus (source-verified):** nginx prefers the upstream `Cache-Control: max-age` over `proxy_cache_valid` for its own validity (`valid_sec`); the directive is only the fallback when `valid_sec == 0`. Config keeps both at 1h, so they agree.
- **`inactive=14d`** (`proxy_cache_path`) is a separate clock: LRU disk-eviction age, reset on every hit — unrelated to freshness.
- Divergence happens only if an intermediary rewrites `Date`/`Age` or a client naively counts from receipt — rare, and self-correcting (a stale HIT's old `Date` makes compliant clients re-request immediately).
- Data updates therefore propagate as a **wave** at T₀+1h; `proxy_cache_lock` + `proxy_cache_background_update` dampen the refetch herd.

---

## 4. Explicit purge of a single `proxy_cache_key` (or part of a layer)

**Stock open-source nginx (`nginx:1.27-alpine`) has no purge API** — no `proxy_cache_purge`, no PURGE method. (That's the third-party `ngx_cache_purge` module or nginx **Plus**.)

But: keys are deterministic and stored under an MD5-of-key path, so **deleting the cache file purges that key**. Safe under a running nginx (source-verified): a missing file (`ENOENT`) makes the request a **miss** → refetch from TiTiler → new file. No reload/restart needed.

**On-disk layout** (`levels=1:2`, dirs carved from the *end* of the MD5 hex):

```
/var/cache/nginx/tiles/<md5[-1]>/<md5[-3:-1]>/<md5>
```

**Replicating the key** (`proxy_cache_key "$scheme$request_method$host$uri$is_args$args"`) — traps:

1. `$uri` is the **post-rewrite** URI: `/api/v1/titiler/cog/...` → `cog/...` (rewrite in nginx.conf applies).
2. `$host` = hostname **without port** (lowercased), not `$http_host`.
3. `$args` is the **raw** query string — keep `%20`/`%2C` exactly as sent. Different param order/encoding = different key.

**Purge script** (run where the named volume is visible, e.g. `docker run --rm -v <project>_tile-cache:/var/cache/nginx/tiles …`):

```python
#!/usr/bin/env python3
"""Purge nginx proxy_cache entries for specific tile URLs.

Replicates proxy_cache_key "$scheme$request_method$host$uri$is_args$args"
with the /api/v1/titiler rewrite applied, $host without port, raw $args.
Layout levels=1:2 -> md5 subdirs carved from the END of the hex.
"""
import hashlib, os, sys, urllib.parse

CACHE_ROOT = "/var/cache/nginx/tiles"   # path inside the nginx container

def purge(url: str):
    u = urllib.parse.urlsplit(url)
    host = u.hostname.lower()
    path = u.path
    if path.startswith("/api/v1/titiler"):      # mirror the nginx rewrite
        path = path[len("/api/v1/titiler"):] or "/"
    key = f"{u.scheme}GET{host}{path}{'?' + u.query if u.query else ''}"
    h = hashlib.md5(key.encode()).hexdigest()
    fp = f"{CACHE_ROOT}/{h[-1]}/{h[-3:-1]}/{h}"
    if os.path.exists(fp):
        os.unlink(fp)
        return fp
    return None

for url in sys.argv[1:]:
    fp = purge(url)
    print(f"purged: {url}\n  -> {fp}" if fp else f"NOT cached (key mismatch?): {url}")
```

Verify with `curl -sI <url> | grep -i x-cache-status`: first request after purge → `MISS` (re-render), second → `HIT`.

**"Only part of a layer":** granularity is per exact URL. Enumerate the exact keys: fixed `url=` (+ any `rescale=`/`bidx=` variants in use), loop over the `z/x/y` range (e.g. the bbox of the updated area at affected zooms), purge each. Unpurged remainder costs nothing until re-requested and ages out via `inactive=14d`.

**Alternatives:**

- `ngx_cache_purge` module → real `PURGE` endpoint, but must be compiled in (image fork). Still one key per request; partial-layer purges still need URL enumeration.
- nginx **Plus**: built-in purge — paid.
- **URL versioning** (logical purge): new query value = new key, old entries orphaned (linger until LRU eviction), first views re-render.

---

## Key takeaways (one-liners)

- Header 1h and `proxy_cache_valid 1h` govern **one shared window** (render-time + 1h), not two independent ones.
- nginx disk cache protects TiTiler even from clients that ignore `Cache-Control`.
- Purge = compute MD5 of the exact key, unlink the file; stock nginx needs no reload and heals on next request.
