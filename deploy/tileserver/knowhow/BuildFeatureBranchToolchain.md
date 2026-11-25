# Building `tileserver-rs` (feature branch `tileserver-rs-gisat`)

**Repo:** `~/.openclaw/work/gits/Gisat/DynamicServerSideTiles/tileserver-rs`
**Branch:** `tileserver-rs-gisat`
**Last verified:** 2026-10-16 11:32 (`cargo build --release` → 41,202,104 bytes, `tileserver-rs 2.38.0`)

---

## TL;DR — just run the script

```bash
cd tileserver-rs
./build-native.sh              # preflight every dependency, then build
```

Options:

```bash
./build-native.sh --check      # preflight only (no build)
./build-native.sh --feat "raster stac"   # override the feature set
```

It builds with the default feature set **`frontend stac raster`**:

```
cargo build --release --features "frontend stac raster"
```

The script checks each dependency (`cargo`/`rustc`, C/C++ toolchain, GDAL dev headers,
libclang, node/pnpm + client assets) and prints ✅/❌ per item, exiting non-zero if
anything is missing — so a crash-wiped environment reports exactly what to fix instead
of failing deep inside `bindgen`/`cmake`.

**Verification after a build:**

```bash
./target/release/tileserver-rs --version          # → tileserver-rs 2.38.0
readlink -f /proc/$(pgrep -f 'tileserver-rs --config' | head -1)/exe   # which binary is running
```

---

## Toolchain (as baked into the image)

The supported path is the **system** toolchain. A conda-env was used historically but is
no longer required (and does not survive container restarts — see Appendix A).

| Need | Package / location |
|------|--------------------|
| Rust | **user-installed** via rustup → `~/.cargo/bin` (NOT baked in; wiped by a crash, see §Gotchas) |
| C/C++ | `build-essential` (`cc`/`gcc`/`g++`), `cmake`, `make`, `nasm`, `pkg-config` |
| GDAL dev | `libgdal-dev` → `/usr/include/gdal/gdal.h`, `gdal-config` (3.6.2 here) |
| libclang | `libclang-dev` (+ `libclang-14-dev`) → `/lib/x86_64-linux-gnu/libclang-14.so`, `/usr/lib/llvm-14/include/clang-c/Index.h` |
| Other headers | `libsqlite3-dev`, `libssl-dev`, `libcurl4-openssl-dev`, `zlib` |
| Client assets | `node` (v24) + `pnpm`; needs `apps/client/.output/public` (see §Gotchas) |

Dockerfile package list (kept for reference / rebuilding the image):

```bash
sudo apt-get update && sudo apt-get install -y --no-install-recommends \
  build-essential pkg-config cmake nasm \
  libclang-dev libgdal-dev libsqlite3-dev libssl-dev libcurl4-openssl-dev \
  libicu-dev libpng-dev libjpeg-dev libwebp-dev libuv1-dev \
  libglfw3-dev libopengl-dev libgl-dev libegl-dev libx11-dev \
  git curl ca-certificates
```

---

## Gotchas (current)

### `Assets::get` not found (E0599) — client assets missing

The `frontend` feature embeds `apps/client/.output/public` via `rust-embed`. If that dir
doesn't exist, the build fails with `Assets::get` E0599. Produce it with:

```bash
pnpm install --filter @tileserver-rs/client
pnpm run generate        # in apps/client — prerenders the routes
```

`build-native.sh` checks for this directory up front.

### `gdal-config` is the truth, not `ldconfig`

A false **"libgdal.so not in ldconfig"** appears when an **alternate-prefix GDAL** is on
`PATH` — e.g. `gdal-config` reporting **3.10.x** from a conda/opt prefix while the system
has **3.6.2**. The alternate `gdal-config` is found, but its `lib/` is not in the loader
cache, so an `ldconfig`-only probe reports it missing even though it is right there.

- The script resolves the library via **`gdal-config --libs`** and only falls back to
  `ldconfig`; it warns when `gdal-config` is not `/usr/bin/gdal-config`.
- Mixed installs are a real hazard: headers from one GDAL, library from another. If you
  intentionally build against an alternate GDAL, put its `lib/` on **`LD_LIBRARY_PATH` at
  run time** too, or the server may load a different `libgdal` than it was built against.

### `mbgl-sys` compiles against its **stub**

MapLibre Native itself is not built (`cmake --preset linux-opengl` in
`crates/mbgl-sys/vendor/maplibre-native` is not run). Fine for the raster/COG tile path
this demo uses; native GL rendering would need the real `libmbgl-core.a` built too.

### Cargo lives in the overlay, not the image

`cargo`/`rustc` are installed as the user via:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

They live in `~/.cargo` + `~/.rustup`, which are **inside the container overlay** — a
container crash wipes them (as happened 2026-10-16). Reinstall with the command above;
the script's preflight will flag them missing. If this must survive crashes, bake Rust
into the image or mount it persistently.

---

## Appendix A — historical note (conda-era blockers, no longer the route)

The first successful build (2026-10-15) ran against a **conda-env** and had to solve
these, in order. **None apply to the system-toolchain path**; recorded only so the
history is not lost:

1. **No C toolchain** → conda-env provided `cc`/`gcc` + GDAL; env wired `CC`,
   `PKG_CONFIG_PATH`, `GDAL_CONFIG`, `PROJ_DATA`.
2. **`bindgen`: libclang not found** → `LIBCLANG_PATH=/home/node/conda-env/lib`.
3. **`stdio.h`/`stddef.h` not found** → bindgen needed the conda sysroot + GCC internal
   includes in `BINDGEN_EXTRA_CLANG_ARGS`.
4. **`Assets::get` E0599** → still applies today; see Gotchas.

The conda-env (`/home/node/conda-env`) was wiped by the 2026-10-16 container crash, and
the build now succeeds cleanly with **no env vars at all** using the image's baked-in
system toolchain.

---

## Appendix B — runtime side

For *why* the Manila COG behaves the way it does at run time (bare-URL range reads,
byte-bounded dataset cache, memory measurements), see:

- `Manila-RGBA-COG-Development-Summary.md`
- `tileserver-rs-oom-handoff.md`
