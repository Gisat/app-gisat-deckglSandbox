# =============================================================================
# Tileserver-RS runtime image — self-contained build context.
#
# Mirrors deploy/titiler-caching/<encoder>/Dockerfile: a small, local context
# (this directory) that ships everything the image needs. Like the encoders,
# which `COPY` their Python source, this `COPY`s the prebuilt native binary.
#
# WHY NOT APT-GET LIBGDAL HERE
#   The upstream pattern (terrarium-encoder) relies on a prebuilt wheel that
#   BUNDLES GDAL, so no system GDAL is installed. tileserver-rs is a dynamically
#   linked binary against the system GDAL (libgdal.so.32), so it needs those
#   shared libs present. Two ways to satisfy that are supported below:
#
#     (A) ONLINE BUILD — uncomment the apt-get block. Needs internet at build
#         time (a normal Docker host).
#     (B) OFFLINE BUILD — ship the libs in ./runtime-libs/ (populated by
#         ../../../../tileserver-rs/build-native.sh --collect-libs or manually
#         with `ldd` + cp). No network needed.
#
# The binary needs libgdal.so.32 + libsqlite3.so.0 (directly) and their
# transitive chain — see the repo's ldd output. There is no RPATH, so the
# loader searches the standard paths (and LD_LIBRARY_PATH).
# =============================================================================
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

# --- (A) ONLINE BUILD -------------------------------------------------------
# Uncomment on a Docker host with internet access. Installs the runtime GDAL
# stack (shared libs only — no -dev, no compiler).
# RUN apt-get update && \
#     apt-get install -y --no-install-recommends --no-install-suggests \
#       libgdal32 libsqlite3-0 libcurl4 libpng16-16 libjpeg62-turbo libwebp7 \
#       libtiff6 libproj25 libgeos-c1v5 libhdf5-103-1 libnetcdf19 \
#       libpoppler126 libxerces-c3.2 libcfitsio10 libgomp1 libgcc-s1 \
#       ca-certificates curl zlib1g libbz2-1.0 libexpat1 liblcms2-2 \
#       libopenjp2-7 libdeflate0 \
#     && apt-get clean && rm -rf /var/lib/apt/lists/*
# ---------------------------------------------------------------------------

# --- (B) OFFLINE BUILD ------------------------------------------------------
# Ship the libs in the build context. Populate runtime-libs/ on a Debian 12
# host that has GDAL (this repo's host does):
#   mkdir -p runtime-libs
#   ldd tileserver-rs | awk '/=> \//{print $3}' | sort -u \
#     | xargs -I{} cp -Lv {} runtime-libs/
# curl/ca-certificates would be needed for the HTTPS /vsicurl/ reads and an
# HTTP healthcheck, but the OFFLINE path ships neither (curl is only in the
# online apt block) — so the healthcheck below uses bash /dev/tcp instead.
# The binary's own TLS for /vsicurl/ comes from the linked libcurl/gnutls in
# runtime-libs/, and the remote COG is fetched over HTTPS from inside the
# process, so no curl BINARY is required for tile serving.
COPY runtime-libs/ /usr/lib/x86_64-linux-gnu/
RUN ldconfig
# ---------------------------------------------------------------------------

# --- GDAL / PROJ DATA (required at runtime, NOT part of libgdal32/libproj25) --
# The shared libs are useless for reprojection without their data files:
#   /usr/share/gdal      ← GDAL data (drivers.ini, SRS tables)   — pkg gdal-data
#   /usr/share/proj      ← PROJ database (proj.db: CRS defs)     — pkg proj-data
# Debian ships these in `gdal-data` / `proj-data`, which are dependencies of the
# -dev packages, NOT of libgdal32 / libproj25. Without them GDAL resolves most
# CRS from cached state but FAILS intermittently on the code paths that read
# proj.db → sporadic HTTP tile errors (probe also fails → app shows its tile
# error modal). Verified: the same binary run where these exist (socat/native)
# works; only the image lacked them.
#
# Collected from /usr/share on a Debian 12 host with GDAL 3.6.2 (see the
# runtime-libs comment above for the collector pattern).
COPY gdal-data/gdal/ /usr/share/gdal/
COPY gdal-data/proj/ /usr/share/proj/
# Point GDAL/PROJ explicitly, so this does not rely on compiled-in defaults
# (which match here, but explicit is robust across GDAL rebuilds).
ENV GDAL_DATA=/usr/share/gdal \
    PROJ_DATA=/usr/share/proj \
    PROJ_LIB=/usr/share/proj

WORKDIR /app

# The prebuilt binary (copied into this context — see README).
COPY tileserver-rs ./tileserver-rs
RUN chmod +x ./tileserver-rs

RUN mkdir -p /data

ENV RUST_LOG=info \
    HOST=0.0.0.0 \
    PORT=8080

# GDAL /vsicurl/ tuning — identical to tileserver-rs/run-native.sh and the
# other stacks (CPL_VSIL_CURL_CACHE_SIZE is PER OPEN DATASET; the COG path
# opens one per overview level, so keep it small).
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif,.TIF,.tiff \
    CPL_VSIL_CURL_CACHE_SIZE=67108864 \
    VSI_CACHE=FALSE \
    VSI_CACHE_SIZE=0 \
    GDAL_CACHEMAX=200 \
    GDAL_BAND_BLOCK_CACHE=HASHSET \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_HTTP_VERSION=2 \
    GDAL_HTTP_MAX_RETRY=3 \
    GDAL_HTTP_RETRY_DELAY=1 \
    GDAL_HTTP_MULTIRANGE=YES \
    GTIFF_SRS_SOURCE=EPSG

EXPOSE 8080
VOLUME ["/data"]

# Healthcheck: debian:12-slim ships NO curl/wget (only bash + coreutils), and
# the binary has no self-check flag. bash's /dev/tcp needs no extra package, so
# it is the reliable in-image probe. (An earlier revision used `curl -f`, which
# could NEVER pass in the offline image — curl is only installed by the
# commented-out online apt block. That made every container report unhealthy.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080' || exit 1

ENTRYPOINT ["/app/tileserver-rs"]
CMD ["--config", "/app/config.toml"]
