# =============================================================================
# Tileserver-RS runtime image — self-contained build context.
#
# The image ships a PREBUILT native binary plus everything it needs at runtime
# (the GDAL shared-library chain, a CA trust store, GDAL/PROJ data files and
# the glibc NSS resolver config). Nothing is compiled here.
#
# WHERE THE BINARY COMES FROM — the Gisat fork's GitHub release
#   The runtime files are published as a versioned tarball attached to a
#   release on the fork:
#
#     https://github.com/twosix-code/tileserver-rs/releases/download/<TAG>/tileserver-gisat.tar.gz
#
#   The archive is the whole runtime build context (binary + runtime-libs/ +
#   gdal-data/ + ca-certs/ + nsswitch.conf) under a single top-level
#   `tileserver-gisat/` directory, so it is extracted with --strip-components=1
#   to land the files directly at /tmp/tsr-runtime. Override the release with
#   --build-arg TILESERVER_RELEASE_TAG=... (default: gisat-v2.39.0).
#
#   WHY DOWNLOAD INSTEAD OF COPY FROM A LOCAL CONTEXT
#     - The vendored inputs (~219 MB of .so/.db files) are .gitignore'd and age
#       badly; the release pins them to a tag the source commit is reachable at.
#     - Mounting the built binary by hand is no longer required — the build is
#       reproducible from the tag alone.
#   The trade-off: this build needs NETWORK at build time (to fetch the asset).
#   The release asset's sha256 is verified before extraction, so a truncated or
#   tampered download fails the build loudly.
#
# WHY NOT APT-GET LIBGDAL HERE
#   The upstream pattern (terrarium-encoder) relies on a prebuilt wheel that
#   BUNDLES GDAL, so no system GDAL is installed. tileserver-rs is a dynamically
#   linked binary against the system GDAL (libgdal.so.32), so it needs those
#   shared libs present — the tarball ships them under runtime-libs/.
#   The binary needs libgdal.so.32 + libsqlite3.so.0 (directly) and their
#   transitive chain. There is no RPATH, so the loader searches the standard
#   paths (and LD_LIBRARY_PATH).
# =============================================================================
FROM debian:12-slim

ARG TILESERVER_RELEASE_TAG=gisat-v2.39.0
ARG TILESERVER_ASSET_SHA256=eb948886b81a2b00ac9548e7e7ee559c0eaf972c6bb80b28c0136eec5e831b8e

ENV DEBIAN_FRONTEND=noninteractive

# --- Fetch + verify + extract the runtime from the fork's release ------------
# `ca-certificates` + `curl` are installed ONLY for this build step, then the
# apt lists are wiped. They are not needed at runtime (the binary's own TLS for
# /vsicurl/ comes from the libcurl/gnutls in runtime-libs/, and the healthcheck
# uses bash /dev/tcp — see below).
RUN apt-get update && \
    apt-get install -y --no-install-recommends --no-install-suggests \
      curl ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/tsr-runtime
RUN curl -fsSL -o tileserver-gisat.tar.gz \
      "https://github.com/twosix-code/tileserver-rs/releases/download/${TILESERVER_RELEASE_TAG}/tileserver-gisat.tar.gz" && \
    echo "${TILESERVER_ASSET_SHA256}  tileserver-gisat.tar.gz" | sha256sum -c - && \
    tar -xzf tileserver-gisat.tar.gz --strip-components=1 && \
    rm -f tileserver-gisat.tar.gz

# --- Runtime libs (GDAL shared-library chain + glibc NSS modules) ------------
# Offline-style vendoring: the release ships every .so in runtime-libs/,
# including libnss_dns.so.2 / libnss_files.so.2 (which glibc dlopen()s, so
# `ldd` never lists them).
RUN cp -a /tmp/tsr-runtime/runtime-libs/. /usr/lib/x86_64-linux-gnu/ && ldconfig

# --- CA trust store for libcurl-gnutls ---------------------------------------
# TLS verification of remote /vsicurl/ COGs. Without it the handshake aborts ->
# "HTTP response code: 0" -> GDALOpenEx NULL -> source never loads.
RUN cp /tmp/tsr-runtime/ca-certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# --- GDAL / PROJ DATA (required at runtime, NOT part of libgdal32/libproj25) --
#   /usr/share/gdal      ← GDAL data (drivers.ini, SRS tables)   — pkg gdal-data
#   /usr/share/proj      ← PROJ database (proj.db: CRS defs)     — pkg proj-data
# Without them GDAL resolves most CRS from cached state but FAILS intermittently
# on the code paths that read proj.db → sporadic HTTP tile errors (probe also
# fails → app shows its tile error modal).
RUN cp -a /tmp/tsr-runtime/gdal-data/gdal/. /usr/share/gdal/ && \
    cp -a /tmp/tsr-runtime/gdal-data/proj/. /usr/share/proj/

# Point GDAL/PROJ explicitly, so this does not rely on compiled-in defaults
# (which match here, but explicit is robust across GDAL rebuilds).
ENV GDAL_DATA=/usr/share/gdal \
    PROJ_DATA=/usr/share/proj \
    PROJ_LIB=/usr/share/proj \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# --- glibc NSS resolver config (REQUIRED for HTTPS /vsicurl/) ----------------
# debian:12-slim ships NO /etc/nsswitch.conf. Without it, getaddrinfo() inside
# libcurl has no `hosts:` source and returns "Could not resolve host" even
# though `getent hosts` still works (glibc uses its own fallbacks there).
# That surfaces as "HTTP response code: 0" from GDAL, a NULL GDALOpenEx, the
# remote COG failing to register ("Loaded 0 tile source(s)") and every
# /data/{source}/... request 404ing.
RUN cp /tmp/tsr-runtime/nsswitch.conf /etc/nsswitch.conf

WORKDIR /app

# --- The prebuilt binary (from the release tarball) --------------------------
RUN cp /tmp/tsr-runtime/tileserver-rs /app/tileserver-rs && \
    chmod +x /app/tileserver-rs && \
    rm -rf /tmp/tsr-runtime

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
# could NEVER pass in the final image — curl is only installed transiently at
# build time to fetch the release asset, then removed with the apt lists. That
# made every container report unhealthy.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080' || exit 1

ENTRYPOINT ["/app/tileserver-rs"]
CMD ["--config", "/app/config.toml"]
