# Tileserver-TiTiler-Eval.md — app design and deployment considerations

> **Purpose:** what a tiler comparison means once you ask "how
> do I cache this, and up to what load?"
>
> **Status:** analysis / knowhow. Not an implementation plan. No code change is
> proposed here; where a change would be needed it is marked **→ ACTION**.
>
> **Supersedes nothing.** This file is app design and deployment-specific reading. See also:
> [`USAGE.md`](../USAGE.md), [`DEMOS.md`](../DEMOS.md).

---

## 0. TL;DR

1. TiTiler exposes
   per-request `indexes` / `rescale` / `colormap` / `expression`; tileserver-rs
   does not. It is the **cacheability precondition**  not a defect.
2. Params **live** (chosen per request) ⇒ keys explode ⇒ any *shared* cache above
   rung 1 thrashes. Params **frozen** (baked in config) ⇒ keys are stable ⇒ the
   whole ladder above rung 1 is available.
3. **This Demo deployment chose frozen.** Both demo sources bake their rendering
   decision into `config.toml` (`resampling`, `minzoom`/`maxzoom`, and for
   `io-lulc` a full `[sources.colormap]` + `rescale_mode = "none"`). The only
   thing the client varies is `z/x/y` — which is exactly a stable key.
4. Therefore the in-process RAM cache (`[cache] enabled = true`, 512 MB,
   TTL 3600 s) is **sufficient for the demo**, and rungs 2+ are *reachable* if
   the demo ever needs them — precisely because the keys were frozen on purpose.
5. The demo's real ceilings are **not** cache-key cardinality. They are:
   **(a) the STAC dynamic mosaic's per-tile `/search` + N-asset open cost**, and
   **(b) the dataset-cache byte budget** the mosaic competes for. See §5.

---

## 1. App with a given band/rescale/colormap decision.

*"where do I want the band/rescale/colormap decision made — in every request, or once at deploy?"* For this deployment the
answer is unambiguous and already written in config:

| Capability | Who decides, this deployment | Where |
|---|---|---|
| Band selection | **frozen** — 3-band RGB served straight; 1-band LULC via colormap | `config.toml` `[sources]` |
| Rescale | **frozen** — `rescale_mode = "none"` (mandatory for categorical) | `[sources.colormap]` |
| Colormap | **frozen** — 9-class IO legend baked in | `[sources.colormap]` |
| Resampling | **frozen per source** — `bilinear` (imagery) / `nearest` (classes) | `[sources]` + `[raster]` |
| `expression` (band math) | **unused** | — |
| Resampling per request | **live** (`?resampling=`) | query |

So the deployment sits squarely on the **frozen** side of the fork. That is what
licenses everything in §4.

**One nuance the parent doc does not spell out:** the frozen/live split is not
all-or-nothing per request. A **shared cache honors a stable key prefix
(`source/z/x/y`) and ignores unstable suffixes** only if the *whole* URL is the
key. There is no partial-keying in a standard proxy cache. Which means:

- Everything that varies must be **below** the cache key (in config), never
  **in** the request — or it silently fragments the cache.
- The single live parameter in use (`?resampling=`) is a real **→ RISK**: a
  burst that alternates `bilinear` and `nearest` on the same tile writes two
  entries for one tile. At demo scale this is harmless (RAM, TTL-bounded), but
  it is the pattern to watch if the ladder is ever climbed.

→ **ACTION (only if rung 2+ is ever adopted):** forbid per-request `?resampling=`
    for cached sources, or fold it into the key deliberately. Today: no action.

---

## 2. What "cache thrash, not cache waste" means here

Restated for this deployment:

- A cache **miss is not extra cost** — it is the render you would have paid with
  no cache at all.
- The harm is **eviction**: one-shot, high-cardinality keys fill a finite store
  and push out the genuinely reused entries — so the cache *degrades the traffic
  it was meant to help*.
- **Exploration UI = high-cardinality traffic.** That is why the parent doc's
  live-params architecture and any shared cache above rung 1 are *structurally*
  incompatible: the knob-turning **is** the thrash generator.

**This deployment generates no such traffic.** The client sends `z/x/y` only.
The knobs were turned once, by the operator, in `config.toml`. The cache
therefore sees a **stable, low-cardinality** key space — the regime a cache is
actually good at.

The corollary worth stating plainly: **the demo is cacheable not because it is
small, but because it is frozen.** Scale would not break the key space; it would
only require moving the cache to a shared store (rung 3+), which frozen keys
permit.

---

## 3. The caching ladder, applied to this container

Rungs from the analysis, with this deployment's specifics:

| Rung | Mechanism | This demo | Notes |
|---|---|---|---|
| 1 | in-process RAM (tileserver-rs `[cache]`) | **IN USE** — 512 MB, TTL 3600 s, `enabled = true` | plus `dataset_cache` handle cache (see §5) |
| 2 | nginx `proxy_cache` in front (disk, survives restart) | reachable, **not used** | tileserver-rs already emits `Cache-Control` + `Vary: Accept-Encoding` on tiles ⇒ nginx cooperates out of the box |
| 3 | shared front cache across replicas | n/a (single container) | would need multi-replica first |
| 4 | shared store (Redis) or **pre-computed PMTiles/MBTiles** | n/a | the `deploy/tileserver` model already *prefers* pre-built sources when they fit |
| 5 | object store + CDN | n/a | out of scope for a local demo |

### Where rung 1 actually breaks here

Four walls, checked against this container:

1. **Capacity** — 512 MB / (~15 KB raster tile) ≈ **35k tiles**. A Manila-Luzon
   pyramid to z15 is far more than that. So the RAM cache holds a *working set*,
   not a layer. For a demo viewport at z8–z13 this is comfortably adequate.
2. **Scope** — one process. Fine: the demo is one container.
3. **Durability** — lost on `docker compose up --force-recreate`. Note the
   container is `restart: unless-stopped`, so ordinary restarts keep the process
   and the cache; a **recreate wipes it**. First pan after a recreate is cold.
4. **Consistency** — n/a single-instance.

**Verdict:** rung 1 is correctly sized for the demo. The ladder above it is
reachable *because* §1 froze the keys — no structural blocker.

→ **ACTION (optional, cheap):** if cold-after-recreate becomes annoying, add an
    nginx `proxy_cache` sidecar pointing at `localhost:8080/data/...` — rung 2,
    disk-backed, survives recreate, zero server change.

---

## 4. Why the RAM cache "works" here — and precisely how far

*"the per-request surface is missing on purpose, and its
absence is what makes the cache work"* applies literally to this container:

- Every canonical request is `/data/{source}/{z}/{x}/{y}.png` — a **stable key**.
- The `io-lulc` rendering decision (colormap, `rescale_mode = "none"`, `nearest`)
  lives in config, **not** in the URL. So the same tile always maps to the same
  cache entry — no fragmentation.
- The manifest shows this is **already exercised**: the container is built from
  the Gisat fork's `integration/demo-fixes` release, which serves *canonical*
  `z/x/y` requests from the tile cache (see the `[cache]` comment in
  `config.toml`). Without that patch, upstream only cached
  `Accept-Encoding` re-encode variants. Confirm against the live image ⏱.

**How far it goes:** the cache accelerates **repeat** reads of the same tile
(pan back, re-open the demo, second user). It does *not* accelerate the **first**
render of a tile — that is a COG range-read + warp + encode, and no cache
setting changes it except a local copy of the COG (rung 2 with a local file, or
pre-built tiles).

---

## 4a. Rung-1 sufficiency for site-specific apps (deployment doctrine)

> **This is the doctrine the `Tileserver-RS` demo category is built on.** The
> target is not a public/global dataset, but an **application-user-specific
> solution scoped to one location area** — Misicuni (Cochabamba, Bolivia) or
> Manila (Luzon). Global/continental datasets open to a broad public are a
> different beast and need higher rungs; that is explicitly *out of scope* here.

The question this section answers: **how far can Rung 1 (in-process RAM) get us,
when its lightweight, straightforward, operationally efficient shape is the
attractive part?** For a site-specific app: **all the way**, provided the four
conditions in §4a.3 hold.

### 4a.1 Why "site-specific" collapses the problem

The caching problem in the abstract is unbounded because the *data* is bounded
nowhere. A site-specific app rejects that premise: the dataset is **one bounded
area, known at deploy time**. Sizing two representative sites at ~20 KB/tile:

| Site | Scope | Pyramid to native z | Bytes | Rung-1 fit at 12 GB |
|---|---|---|---|---|
| **Misicuni** | reservoir / catchment, ~30–60 km box | ~500–1,500 tiles | ~30 MB | trivial |
| **Manila (Luzon)** | regional composite, 5.6°×5.45° | ~87,000 tiles | ~2.6 GB | 4–5× headroom |

**Sizing rule:** if the site fits a bbox you'd draw on a regional map, its full
pyramid fits in a few GB. 12 GB is generous for site work, not tight.

### 4a.2 How far 12 GB actually gets

At ~20 KB/tile, **12 GB ≈ 0.6 M tiles** — ~24× the 512 MB default. Against the
Manila pyramid (~2.6 GB) that means **the entire layer is resident**:

| Property | 512 MB (default) | **12 GB** |
|---|---|---|
| Tiles held | ~26k | **~600k** |
| Manila full pyramid (~87k tiles) | ~30% only | **entire layer, 4–5× over** |
| Eviction / thrash | possible | **eliminated for this layer** |
| Survives restart | ✗ | **✗ (unchanged — RAM)** |
| Shared across replicas | ✗ | **✗ (unchanged)** |
| Kills first-render cold cost | ✗ | **✗ (unchanged)** |

12 GB is the **ceiling of the Rung-1 approach**: all the storage the
architecture can use, none of the three walls it cannot cross.

### 4a.3 The four conditions — the boundary statement

> **Rung 1 is fully sufficient when ALL four hold:**
> **(1) single site  ∧  (2) bounded region  ∧  (3) frozen params  ∧  (4) one instance.**
>
> Add *any one* of — multi-site in one server · public/worldwide data · live
> parameter exploration · multiple replicas — and you have crossed into a
> rung-2+ need.

Assessment for the site-specific target:

| Condition | Site-specific reality | Status |
|---|---|---|
| (1) single site | one app, one location | ✔ |
| (2) bounded region | site-sized bbox, known at deploy | ✔ |
| (3) frozen params | colormap/rescale/resampling baked per site in config | ✔ |
| (4) one instance | one app, one site, one container | ✔ |

**(3) is the one that is easy to lose.** If a user can vary band × rescale ×
colormap per request, keys explode *even for a tiny site* (500 spatial tiles ×
100 combos = 50k keys) — see §1/§2. Freezing the rendering per site (a site
*warrants* its own tuned rendering, decided once) is what keeps Rung 1 valid.

### 4a.4 The three walls, and why they are small for a site

| Wall | Rung 1 behavior | Cost for a site-specific app |
|---|---|---|
| **Restart / redeploy** | RAM lost on `--force-recreate` | recover = **one cold sweep of the site** — the one number that decides this (see below) |
| **No cross-replica share** | each replica warms independently | only bites if running **>1 instance for the same site** — usually N/A |
| **First-render cold cost** | unchanged by RAM | **finite and prepayable** precisely because the site is bounded |

Re-warm cost, the deciding number:
- **Misicuni** (~1k tiles): ~3–8 min if re-warmed serially — nobody notices.
- **Manila** (~87k tiles full pyramid): hours if re-warmed serially — but you
  re-warm only the **viewports actually visited**, a small fraction ⇒ minutes.

**Why bounded data is different:** unbounded data makes cold cost *recurring*;
site-bounded data makes it *finite and prepayable*.

### 4a.5 The mitigation that keeps you in Rung 1

Two moves, both staying inside Rung 1's spirit (no new cache tier):

1. **Local copy of the site COG** — site-sized, tens–hundreds of MB. Converts
   cold renders from network-bound (0.15–0.5 s) to milliseconds, and makes
   restart-recovery trivial. *This alone removes the restart wall's sting.*
2. **Startup prewarm** over the site's tile grid (or the visited subset) — a
   one-time sweep that repopulates the resident layer after a deploy.

> **Rung 1 + 12 GB + local site COG + config-frozen params + startup prewarm is a
> complete, production-credible solution for a single-site app** — no nginx, no
> Redis, no CDN, no operator burden; the whole site served from RAM.

### 4a.6 The boundary is per-app, and it drifts

The four conditions are per-*app*, and scope creep is the real risk: a "site
demo" quietly grows a second region, then a third. **The invariant to protect is
one server instance = one bounded, frozen, single-instance dataset.** If that
ever breaks, the culprit will be scope creep, not the cache.

---

## 5. The real bottlenecks in this STAC deployment (not cache keys)

These are where the demo actually costs time, and they are **orthogonal to the
TiTiler-vs-tileserver caching question**:

**(a) STAC dynamic mosaic — per-tile `/search` + N opens.** For `io-lulc`, every
new tile issues a bbox `/search` and then opens/composites up to
`mosaic_max_assets = 8` COGs. The RAM tile cache helps only on *repeat*; the
first touch of every tile pays search + 8 opens. This is the dominant cost, and
it is **not** a key-cardinality problem — it is a per-tile discovery cost.

→ **ACTION (design, not urgent):** if `io-lulc` cold latency ever matters, the
   lever is a **MosaicJSON-style precomputed index** (which tileserver-rs does
   not have as an artifact) or a narrower `stac_bbox`, **not** a bigger cache.

**(b) Dataset-cache byte budget is shared and consumption-based.** Each open COG
handle is charged a flat 16 MiB (`BASE_COST_BYTES`) against a 256 MB default
budget (1 GiB in this config per the source comment — verify ⏱). A STAC mosaic
at low zoom matches many items; `mosaic_max_assets = 8` exists precisely to stop
a single tile saturating the budget and rendering blank. The parent doc's
"dataset handle cache" row is the mechanism; here it is a **tuning surface**, not
a caching-tier.

→ **ACTION (documented, already mitigated):** the `mosaic_max_assets` cap and
   the 1 GiB budget in `config.toml` are the current mitigations. Treat raising
   the budget as a *host-memory* decision, not a cache decision.

**(c) GDAL `/vsicurl/` tuning is shared, not server-specific.** The container
bakes GDAL tuning into `tileserver-runtime/Dockerfile` ENV (see `USAGE.md`). The
parent doc's Appendix A block applies verbatim. This is the one lever that
affects **both** servers equally and the demo already pulls it.

---

## 5a. `io-lulc` — scope, and the realistic Rung-1 verdict

### 5a.1 It is a global dataset, served at a bounded extent

Two facts, at two different layers — both true, do not conflate them:

| Layer | Fact |
|---|---|
| **Product / dataset** | **global** — `io-10m-annual-lulc`, one COG per Sentinel-2 MGRS supercell per year (2017–2024). The `config.toml` comment is **correct**. |
| **Served extent** | **bounded** — this deployment serves a chosen extent only (demo pins Munich via `stac_bbox`; intended production scope = **Europe**). |

The **rung is set by the served extent, not by the dataset.** The global product
is what makes Rung 1 *non-trivial to keep*: nothing in the format stops someone
widening the extent later (§4a.6 — the invariant to protect).

The audience (corporate / specialists) does **not** change the rung. It is a
demand-side fact (how many, how often) and only widens the safety margin; the
rung is set by supply-side facts (what data, how scoped, how keyed, how many
replicas). See §4a.3.

### 5a.2 Sizing a Europe extent — geometric count

Generous continental bbox (lon −25→45, lat 34→71.5), 256 px tiles, uniform
estimate (see the empty-tile caveat in 5a.3):

| z | tiles at that zoom | cumulative to z |
|---|---|---|
| 10 | 39,000 | 52,000 |
| 11 | 154,800 | 207,000 |
| 12 | 616,900 | 824,000 |
| 13 | 2,461,000 | 3,285,000 |
| 14 | 9,835,000 | 13,120,000 |
| 15 | 39,328,000 | **52,448,000** |

RAM at ~20 KB/tile: **Europe to z15 ≈ 52 M tiles ≈ ~1 TB** (range
~750 GB–1.5 TB across 15–30 KB tiles). **Full-Europe at native zoom does not fit
in 12 GB — it is 60–100× over.** No realistic single-machine RAM changes that.

### 5a.3 But "the whole pyramid" is the wrong question

The resident set is **what gets requested**, and two facts collapse the number:

1. **Zoom range.** Europe served to a specialist is browsed at overview zooms
   (z6–z12); z13–15 only where someone actually zooms in. Tile count
   **quadruples per zoom level**:

   | Europe, served to | tiles | @20 KB |
   |---|---|---|
   | z10 | 52 k | ~1 GB |
   | z11 | 207 k | ~4 GB |
   | z12 | 824 k | ~16 GB |
   | z13 | 3.3 M | ~64 GB |

2. **Tile cost is not uniform.** Most of a European pyramid is empty ocean /
   no-data / class-uniform and compresses to a few hundred bytes, not 15 KB. A
   60 % near-empty fraction cuts the effective average several-fold. Real
   pyramids routinely run 3–5× under the uniform estimate.

### 5a.4 The realistic verdict

> **Europe is Rung 1 at overview zooms (z6–z12), not at native zoom.** 12 GB
> buys roughly **Europe-to-z11/z12 as a fully resident working set** — a
> genuinely useful specialist browsing map — with normal evict/refill behavior
> for the deep-zoom tiles only a few people touch.

That is a legitimate configuration, but note it is **no longer "whole layer
resident"** — it is a **resident working set**, i.e. the Rung-1 wall from §4a.2
reappears for the served extent:

| Served scope | Rung-1 fit at 12 GB |
|---|---|
| Munich demo bbox (current `stac_bbox`) | ✔ trivially resident |
| Europe, overview zooms (≤ z11) | ✔ resident |
| Europe to z12 | ~ borderline (fits if tiles are light) |
| Europe to z14–15 | ✘ 60–100× over RAM |

### 5a.5 The two knobs that decide it

Both already exist in `config.toml`; no code change needed:

1. **`maxzoom`** (currently `14`) — every zoom added **quadruples** the tile
   count. Dropping 15→12 cuts the pyramid ~64×. **The single biggest lever.**
2. **`stac_bbox`** (currently Munich, `[11.2, 47.9, 11.9, 48.4]`) — the served
   extent. Munich → Europe is ~10⁴× more area at the same zoom. The product is
   global; this line is what you *serve*.

**Latent question to settle ⏱:** is the demo's Munich `stac_bbox` the intended
production extent, or a placeholder for a wider European service? If the latter,
this bbox is the knob that defines the real Rung-1 envelope and will need
widening — and it, not `maxzoom`, may be the binding constraint.

### 5a.6 To make the number defensible (open work)

The 5a.2 figures are geometric. To convert to a real figure for *these* tiles:

- **Measure the mean tile size + empty-tile fraction** by sampling live
  `io-lulc` tiles from the container (the no-data fraction is the wildcard that
  moves ~750 GB ↔ ~1 TB, and can pull z12-Europe under 12 GB).
- **Fix the intended served extent** (EU? Europe-minus-Russia? Munich widened
  how far?) and the intended **`maxzoom`** (z12 vs z15 is a 64× difference).

Output would be a RAM table for candidate **extent × maxzoom** combos — the
evidence needed to state "12 GB supports *this* configuration" rather than a
range.

---

## 6. Re-reading the parent doc's "Bottom line" for this container

| Parent conclusion | Reading for `deploy/tileserver` |
|---|---|
| Pick by the data, not the benchmark | The demo picks tileserver-rs for a **frozen** COG + a STAC mosaic — both are tileserver-rs-native shapes. ✔ consistent |
| The asymmetric gap: TiTiler's per-request params | **Irrelevant to this deployment** — the demo does not explore params; it freezes them. The gap would bite only if a generic explorer UI sat on top. |
| tileserver-rs raster is no longer "secondary" | Confirmed by the demo itself: it renders RGB COG **and** a colormapped STAC mosaic through the same binary. |
| Neither persists (no disk cache) | True here: RAM only. Rung 2 (nginx) is the documented upgrade path, not required for the demo. |
| DEM/terrain is a tileserver-rs strength | Latent here — no DEM source in this container yet. Relevant if the terrain demos are wired through `deploy/tileserver`. |

---

## 7. Decision flow for a future change (keeps the fence posts straight)

Use this when someone asks "should we make X configurable per request?"

```
Does the request need to vary band / rescale / colormap / expression?
        │
        ├── NO  → keep it in config.toml. Keys stay stable. Rung 1 cache works;
        │         rungs 2+ remain open.  ← THIS DEPLOYMENT'S DEFAULT
        │
        └── YES → you are choosing a LIVE parameter surface.
                  Accept: TiTiler only; no shared/disk/edge cache above it
                  (thrash — see §2). OR materialise the variants as
                  separate sources with stable ids (pre-render / pre-extract)
                  and stay on the frozen path using Rung 1 tileserver-rs.
```

**The two coherent architectures again, as a one-liner:** *live params ⇒
in-process cache only; frozen params ⇒ the whole ladder is yours.* You cannot
buy rung 5 caching for a knob-turning UI.

---
