# Raw float32 elevation-tile encoder for the titiler-caching stack.
# Serves EPSG:3857 {z}/{x}/{y}.f32 headerless little-endian float32 tiles from
# a remote float32 COG via rasterio windowed reads (GDAL /vsicurl/). Builds
# from wheels — no apt GDAL compile needed.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# rasterio's manylinux wheel bundles its own GDAL but dynamically links a few
# system shared libs that python:3.12-slim does not ship. Without them rasterio
# fails to import: "ImportError: libexpat.so.1: cannot open shared object file".
# These are the bookworm packages providing them (expat, OpenMP, curl/TLS,
# PNG/JPEG/GIF/WebP/TIFF/OpenJPEG codecs, lzma, zstd). Unchanged from the
# terrarium encoder image — rasterio needs them regardless of PIL.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 libexpat1 libcurl4 libssl3 \
        libpng16-16 libjpeg62-turbo libgif7 libwebp7 libtiff6 \
        liblzma5 libzstd1 libopenjp2-7 \
    && rm -rf /var/lib/apt/lists/*

# rasterio ships a bundled GDAL; fastapi/uvicorn for the HTTP layer; numpy for
# the float32 packing. NO Pillow — this encoder emits raw float32 bytes, never
# a PNG, so it has no image pipeline to serve.
RUN pip install --no-cache-dir \
        "rasterio>=1.3" \
        "fastapi>=0.110" \
        "uvicorn[standard]>=0.29" \
        "numpy>=1.26"

COPY terrain_float32_encoder.py /srv/terrain_float32_encoder.py

EXPOSE 8000

# GDAL /vsicurl/ tuning for fast remote-COG range reads (mirrors the TiTiler
# and terrarium services in the same stack).
ENV ENCODER_COG_URL="" \
    GDAL_CACHEMAX=75% \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=536870912 \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_HTTP_VERSION=2 \
    CPL_TMPDIR=/tmp

CMD ["uvicorn", "terrain_float32_encoder:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
