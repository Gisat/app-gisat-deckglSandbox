#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# collect-runtime-libs.sh — regenerate the OFFLINE build context for the
# tileserver-rs runtime image.
#
# WHY THIS EXISTS
#   tileserver-runtime/Dockerfile builds a Debian 12 image with NO network
#   access (the host we build on has no container egress). So the shared
#   libraries the binary links against, plus the GDAL/PROJ DATA files, are
#   shipped inside the build context and COPYd in — mirroring how
#   deploy/titiler-caching/<encoder>/ ships its Python source.
#
#   Those files are NOT committed (180+ MB of vendored .so/.db ages badly and
#   bloats git). Regenerate them with this script on a Debian 12 host that has
#   the GDAL runtime installed (the same host that built the binary).
#
# WHAT IT COLLECTS
#   runtime-libs/   every shared object from `ldd` of the binary (first level;
#                   the binary links libgdal/libsqlite3 directly and their
#                   transitive deps are pulled in by ldd's own resolution).
#   gdal-data/gdal/ /usr/share/gdal   — GDAL data (drivers.ini, SRS tables).
#                   Package: gdal-data  (NOT a dep of libgdal32!).
#   gdal-data/proj/ /usr/share/proj   — PROJ database (proj.db, CRS defs).
#                   Package: proj-data  (NOT a dep of libproj25!).
#
# USAGE
#   cd deploy/tileserver
#   ./collect-runtime-libs.sh [/path/to/tileserver-rs-binary]
#
#   Default binary path: ../../../tileserver-rs/target/release/tileserver-rs
#   After running, copy the binary into the context too:
#     cp ../../../tileserver-rs/target/release/tileserver-rs tileserver-runtime/
#   (this script does that for you when the default path is used).
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="$SCRIPT_DIR/tileserver-runtime"
BIN="${1:-$SCRIPT_DIR/../../../tileserver-rs/target/release/tileserver-rs}"

if [[ ! -x "$BIN" ]]; then
    echo "ERROR: binary not found/executable: $BIN" >&2
    echo "       Build it first: cd ../../../tileserver-rs && ./build-native.sh" >&2
    exit 1
fi

echo "== collect-runtime-libs.sh =="
echo "  binary : $BIN"
echo "  context: $CTX"
echo

mkdir -p "$CTX/runtime-libs" "$CTX/gdal-data/gdal" "$CTX/gdal-data/proj"

# --- 1. shared libraries ---------------------------------------------------
echo "== shared libraries (ldd) =="
rm -f "$CTX"/runtime-libs/*.so* 2>/dev/null || true
count=0
while IFS= read -r so; do
    if [[ -f "$so" ]]; then
        cp -L "$so" "$CTX/runtime-libs/" && count=$((count + 1))
    fi
done < <(ldd "$BIN" 2>/dev/null | awk '/=> \//{print $3}' | sort -u)
echo "  copied $count shared libraries"

# --- 1b. NSS resolver modules ---------------------------------------------
# glibc dlopen()s these at getaddrinfo() time for the `hosts:` sources named in
# /etc/nsswitch.conf, so they are NOT link-time deps and `ldd` never lists them.
# Without libnss_dns.so.2, name resolution INSIDE the image fails even though
# `getent hosts` works: GDAL's /vsicurl/ -> libcurl -> getaddrinfo() returns
# "Could not resolve host" -> HTTP response code 0 -> GDALOpenEx NULL -> the
# source fails to register ("Loaded 0 tile source(s)") -> every /data/... 404s.
# Ship them alongside the other runtime libs; pair with /etc/nsswitch.conf
# (COPYd in the Dockerfile) so glibc actually consults the dns module.
# NOTE: libnss3.so/libnssutil3.so in runtime-libs are Mozilla NSS (unrelated to
# glibc name resolution) — do not confuse them with these.
echo "== NSS resolver modules (dlopen, not in ldd) =="
for so in libnss_dns.so.2 libnss_files.so.2 libnss_myhostname.so.2; do
    p=$(ldconfig -p 2>/dev/null | awk -v n="$so" '$1==n {print $NF; exit}')
    [[ -z "$p" ]] && p=$(find /lib /usr/lib -name "$so" 2>/dev/null | head -1)
    if [[ -n "$p" && -f "$p" ]]; then
        cp -L "$p" "$CTX/runtime-libs/" && echo "  OK   $so <- $p"
    else
        # libnss_dns is REQUIRED; the others are nice-to-have.
        if [[ "$so" == "libnss_dns.so.2" ]]; then
            echo "  FAIL $so MISSING — in-image DNS will break (libcurl: Could not resolve host)" >&2
            exit 1
        fi
        echo "  skip $so (not on this host)"
    fi
done

# Sanity: the two the binary needs DIRECTLY.
for need in libgdal.so libsqlite3.so; do
    if ls "$CTX"/runtime-libs/${need}* >/dev/null 2>&1; then
        echo "  OK   $need present"
    else
        echo "  FAIL $need MISSING — the image will not run" >&2
        exit 1
    fi
done

# --- 2. GDAL data ----------------------------------------------------------
echo "== GDAL data (/usr/share/gdal) =="
if [[ -d /usr/share/gdal ]]; then
    cp -a /usr/share/gdal/. "$CTX/gdal-data/gdal/"
    echo "  copied $(find "$CTX/gdal-data/gdal" -type f | wc -l) files"
else
    echo "  WARN /usr/share/gdal absent — install the 'gdal-data' package" >&2
fi

# --- 3. PROJ data ----------------------------------------------------------
echo "== PROJ data (/usr/share/proj) =="
if [[ -d /usr/share/proj ]]; then
    cp -a /usr/share/proj/. "$CTX/gdal-data/proj/"
    echo "  copied $(find "$CTX/gdal-data/proj" -type f | wc -l) files"
    if [[ -f "$CTX/gdal-data/proj/proj.db" ]]; then
        echo "  OK   proj.db present (CRS database — required for reprojection)"
    else
        echo "  FAIL proj.db MISSING — install the 'proj-data' package" >&2
        exit 1
    fi
else
    echo "  WARN /usr/share/proj absent — install the 'proj-data' package" >&2
fi

# --- 3b. CA trust store ----------------------------------------------------
# libcurl-gnutls (GDAL's /vsicurl/ TLS backend) verifies the server cert against
# /etc/ssl/certs/ca-certificates.crt. The OFFLINE image installs nothing from
# the network, so WITHOUT this bundle every HTTPS read aborts at the TLS
# handshake -> libcurl returns connection 0 -> GDAL reports
# "HTTP response code: 0" -> GDALOpenEx NULL -> the source fails to register
# ("Loaded 0 tile source(s)") -> every /data/... 404s. DNS can be perfectly
# fine and you still get this: it is certificate trust, not name resolution.
# Ship the host's bundle and point CURL_CA_BUNDLE at it (env set in the
# Dockerfile); the gnutls/libcurl compile-time default already matches this path.
echo "== CA trust store (/etc/ssl/certs/ca-certificates.crt) =="
if [[ -f /etc/ssl/certs/ca-certificates.crt ]]; then
    mkdir -p "$CTX/ca-certs"
    cp -L /etc/ssl/certs/ca-certificates.crt "$CTX/ca-certs/ca-certificates.crt"
    echo "  OK   ca-certificates.crt ($(stat -c %s "$CTX/ca-certs/ca-certificates.crt") bytes)"
else
    echo "  FAIL ca-certificates.crt MISSING on this host — install 'ca-certificates'" >&2
    echo "       (in-image HTTPS /vsicurl/ would fail with 'HTTP response code: 0')" >&2
    exit 1
fi

# --- 4. the binary itself --------------------------------------------------
if [[ "$BIN" == "$SCRIPT_DIR/../../../tileserver-rs/target/release/tileserver-rs" ]]; then
    echo "== binary =="
    cp -f "$BIN" "$CTX/tileserver-rs"
    chmod +x "$CTX/tileserver-rs"
    echo "  copied $(stat -c %s "$CTX/tileserver-rs") bytes"
fi

echo
echo "== done =="
du -sh "$CTX/runtime-libs" "$CTX/gdal-data" "$CTX/ca-certs" "$CTX/tileserver-rs" 2>/dev/null
echo "  total context: $(du -sh "$CTX" | cut -f1)"
echo
echo "Next:  docker compose -f deploy/tileserver/docker-compose.yml up -d --build"