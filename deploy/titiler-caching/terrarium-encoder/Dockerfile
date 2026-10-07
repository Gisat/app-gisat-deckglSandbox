# Terrarium elevation-tile encoder for the titiler-caching stack.
# Serves EPSG:3857 {z}/{x}/{y}.png Terrarium tiles from a remote float32 COG
# via rasterio windowed reads (GDAL /vsicurl/). Builds from wheels — no apt
# GDAL compile needed.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# rasterio's manylinux wheel bundles its own GDAL but dynamically links a few
# system shared libs that python:3.12-slim does not ship. Without them rasterio
# fails to import: "ImportError: libexpat.so.1: cannot open shared object file".
# These are the bookworm packages providing them (expat, OpenMP, curl/TLS,
# PNG/JPEG/GIF/WebP/TIFF/OpenJPEG codecs, lzma, zstd).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 libexpat1 libcurl4 libssl3 \
        libpng16-16 libjpeg62-turbo libgif7 libwebp7 libtiff6 \
        liblzma5 libzstd1 libopenjp2-7 \
    && rm -rf /var/lib/apt/lists/*

# rasterio ships a bundled GDAL; fastapi/uvicorn for the HTTP layer; pillow for
# PNG encode; numpy for the packing math.
RUN pip install --no-cache-dir \
        "rasterio>=1.3" \
        "fastapi>=0.110" \
        "uvicorn[standard]>=0.29" \
        "numpy>=1.26" \
        "pillow>=10"

COPY terrarium_encoder.py /srv/terrarium_encoder.py

EXPOSE 8000

# GDAL /vsicurl/ tuning for fast remote-COG range reads (mirrors the TiTiler
# service in the same stack).
ENV ENCODER_COG_URL="" \
    GDAL_CACHEMAX=75% \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=536870912 \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_HTTP_VERSION=2 \
    CPL_TMPDIR=/tmp

CMD ["uvicorn", "terrarium_encoder:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
