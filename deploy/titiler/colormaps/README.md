# Server-side registered colormaps (TiTiler)

This directory is mounted into **both** TiTiler stacks as `COLORMAP_DIRECTORY`
(`/colormaps`), scanned by rio-tiler at **startup**:

- `deploy/titiler/docker-compose.yml` → `./colormaps:/colormaps:ro`
- `deploy/titiler-caching/docker-compose.yml` → `../titiler/colormaps:/colormaps:ro`

Every `.json` (or `.npy`) file here registers a colormap referenced in tile URLs
by the short `colormap_name=<file-stem>`. Because the client only sends the
short name, the tile query stays small and the nginx tile cache
(`deploy/titiler-caching`, cache key = full `$args`) engages — unlike a full
~10 KB inline `colormap` ramp, which bypasses the cache entirely.

## Why server-side (the `colormap_name` short-circuit)

TiTiler's colormap dependency (`src/titiler/core/titiler/core/dependencies.py`):

```python
if colormap_name:
    return cmap.get(colormap_name)   # returns early — colormap override never read
if colormap:
    ... parse inline override ...
    return c
```

A request with **both** `colormap_name` and a compact `colormap` override is
NOT merged — the inline override is silently dropped. So you cannot get both
"short query for caching" and "custom alpha/transparency" from a client-only
change. The server-side registered colormap gives you both: transparency is
baked into the registered ramp, and the client references it by name.

## File format

JSON is a 256-entry dict mapping post-rescale byte values `0–255` to **RGBA**
or RGB arrays (`[r, g, b, a]`, alpha defaults to 255 when omitted). rgb can also
be a hex string (`"#440154"`). Example:

```json
{
  "0": [68, 1, 84, 0],
  "1": [68, 2, 85, 0],
  "...": "...",
  "255": [254, 232, 37, 255]
}
```

A missing/invalid key defaults to `[0,0,0,0]` (transparent black) at render time
via the LUT; you normally want all 256 entries present.

## Rules / conventions

1. **File stem = `colormap_name`.** `ghs_pop_transparent_low.json` →
   `colormap_name=ghs_pop_transparent_low`. Keep names lowercase, `_`-separated.
2. **`COLORMAP_DIRECTORY` is scanned at startup only.** After adding or editing
   a colormap, restart **both** stacks or tiles 400 with "Invalid colormap name":
   ```bash
   docker compose -f deploy/titiler/docker-compose.yml up -d --force-recreate
   docker compose -f deploy/titiler-caching/docker-compose.yml up -d --force-recreate
   ```
3. **Verify registration:**
   ```bash
   curl -s http://localhost:8000/colorMaps | grep -o <your-name>
   # or fetch the definition
   curl -s http://localhost:8000/colorMaps/<your-name>
   ```
   (Both routes are `/colorMaps` — capital M. There is no lowercase `/colormaps`
   route; it 404s.)
4. **Generate from `src/maps/TiTilerDemo/colormaps.js`, never hand-typed**, so
   visuals stay byte-for-byte identical to the client-side ramp (see
   `measure-ghs-cache.sh` history). The GHS file embeds alpha=0 on bytes 0–10
   (population < ~0.43/px and nodata, which clamps to byte 0, transparent) and
   alpha=255 elsewhere.

## Current registered colormaps

| Name | Purpose |
| --- | --- |
| `ghs_pop_transparent_low` | GHS population density: viridis ramp with low-density rural/background (bytes 0–10) fully transparent — "landmass dim, cities lit". |
