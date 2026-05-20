# DuckDB GeoParquet Backend

A Flask-based backend server that serves geospatial data from GeoParquet files using DuckDB. This backend supports multi-tier level-of-detail (LOD) queries for large vector datasets, enabling efficient visualization of millions of data points.

## overview

The backend provides two main API endpoints:
- `/api/dates` - retrieve available dates from the dataset
- `/api/data` - query filtered geospatial data with spatial, temporal, and tier-based filtering

**key features:**
- DuckDB for fast SQL queries on parquet files
- spatial filtering by tile coordinates and zoom tier
- time-series support with array extraction or single-value slicing
- Apache Arrow serialization for efficient data transfer
- CORS enabled for cross-origin requests
- Mode-based queries (static vs animation)

## requirements

- python 3.8+
- dependencies (see `requirements.txt`):
  - flask >= 3.0
  - flask-cors >= 4.0
  - gunicorn
  - duckdb == 1.1.3
  - pyarrow == 18.0.0

## installation & setup

### 1. create virtual environment (optional but recommended)

```bash
cd src/backend
python -m venv venv
source venv/bin/activate  # on Windows: venv\Scripts\activate
```

### 2. install dependencies

```bash
pip install -r requirements.txt
```

### 3. set environment variables

you **must** set the `GEOPARQUET_PATH` environment variable to point to your geoparquet file:

```bash
export GEOPARQUET_PATH='/path/to/your/egms_optimized_be.geoparquet'
```

**example:**
```bash
export GEOPARQUET_PATH='/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet'
```

default fallback: `/app/data/egms_optimized_be.geoparquet` (if not set)

## running the backend

### development (single-threaded, slower)

```bash
flask run --port 5000
```

### production (recommended, multi-worker)

```bash
gunicorn --bind 0.0.0.0:5000 wsgi:application
```

**with worker threads for better concurrency:**
```bash
gunicorn --bind 0.0.0.0:5000 --workers 4 wsgi:application
```

### complete example

```bash
# 1. activate virtual environment
source venv/bin/activate

# 2. set the geoparquet path
export GEOPARQUET_PATH='/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet'

# 3. run the server
gunicorn --bind 0.0.0.0:5000 wsgi:application
```

you should see:
```
[INFO] Starting gunicorn 21.x.x
[INFO] Listening at: http://0.0.0.0:5000 (...)
[INFO] Using worker: ...
```

## api endpoints

### GET /api/dates

retrieve all available dates in the dataset.

**query parameters:**
- `geoparquet_path` (optional) - override the default geoparquet path

**example:**
```bash
curl http://localhost:5000/api/dates
```

**response:**
```json
["2020-01-15", "2020-02-10", "2020-03-20", ...]
```

### GET /api/data

query geospatial data with filtering and spatial tiling.

**query parameters:**
| parameter | type | required | description |
|-----------|------|----------|-------------|
| `geoparquet_path` | string | no | path to geoparquet file |
| `tile_x` | int | no* | tile x-coordinate |
| `tile_y` | int | no* | tile y-coordinate |
| `tier` | int | no | LOD tier (0=overview, 1=mid, 2=detail) |
| `date_index` | int | no | date index (0-based) |
| `mode` | string | no | query mode: `static` or `animation` (default: `static`) |
| `is3D` | string | no | include 3D columns (height, mean_velocity) |
| `global` | string | no | fetch global tier-0 data instead of tile |
| `latitude_col` | string | no | latitude column name (default: `latitude`) |
| `longitude_col` | string | no | longitude column name (default: `longitude`) |
| `height_col` | string | no | height column name (default: `height`) |
| `size_col` | string | no | size/velocity column name (default: `mean_velocity`) |
| `color_col` | string | no | color column name (default: `color`) |
| `dates_col` | string | no | dates column name (default: `dates`) |
| `displacements_col` | string | no | displacements column name (default: `displacements`) |

*`tile_x` and `tile_y` are required unless `global=true`

**examples:**

fetch global overview (5% data):
```bash
curl "http://localhost:5000/api/data?global=true&date_index=0&mode=static"
```

fetch specific tile with 2D data:
```bash
curl "http://localhost:5000/api/data?tile_x=10&tile_y=20&tier=1&date_index=0&mode=static"
```

fetch 3D data (with height and velocity):
```bash
curl "http://localhost:5000/api/data?global=true&date_index=0&mode=static&is3D=true"
```

animation mode (full time-series array):
```bash
curl "http://localhost:5000/api/data?tile_x=10&tile_y=20&tier=2&mode=animation&is3D=true"
```

**response:**
- content-type: `application/vnd.apache.arrow.stream`
- binary arrow table serialized as IPC RecordBatchStream format
- can be loaded in frontend using `@loaders.gl/arrow` or `apache-arrow` library

## expected geoparquet schema

the backend expects the following columns in your geoparquet file:

| column | type | description |
|--------|------|-------------|
| `longitude` or `x` | float | geographic longitude |
| `latitude` or `y` | float | geographic latitude |
| `height` | float | elevation/height value |
| `mean_velocity` | float | velocity or size metric |
| `displacements` | array[float] | time-series displacements |
| `dates` | array[date] | date values for each time step |
| `tier_id` | int | LOD tier (0, 1, or 2) |
| `tile_x` | int | tile grid x-coordinate |
| `tile_y` | int | tile grid y-coordinate |

column names are customizable via query parameters.

## database setup (DuckDB)

the backend creates an in-memory DuckDB connection with spatial extensions:

```python
conn = duckdb.connect(database=':memory:', read_only=False)
conn.execute("INSTALL spatial; LOAD spatial;")
conn.execute(f"CREATE OR REPLACE VIEW egms_data AS SELECT * FROM read_parquet('{geoparquet_path}')")
```

this allows efficient SQL queries directly on the parquet file without loading it entirely into memory.

## cors configuration

CORS is enabled for all origins. if you need to restrict access, modify `app/__init__.py`:

```python
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:3000"]}})
```

## troubleshooting

### error: "no such file or directory"
make sure `GEOPARQUET_PATH` environment variable is set correctly:
```bash
echo $GEOPARQUET_PATH
```

### error: "table egms_data not found"
verify the geoparquet file exists and is readable:
```bash
ls -lh $GEOPARQUET_PATH
```

### error: "column not found"
check that column names match your geoparquet schema:
```bash
duckdb -c "SELECT * FROM read_parquet('$GEOPARQUET_PATH') LIMIT 1;" 
```

### server crashes with large datasets
reduce the number of workers or increase gunicorn timeout:
```bash
gunicorn --bind 0.0.0.0:5000 --workers 2 --timeout 120 wsgi:application
```

## performance notes

- **first request is slow** - DuckDB reads and indexes the parquet file (~5-10s depending on file size)
- **tier 0 queries** return ~5% of data (global overview, fastest)
- **tier 1 queries** return ~35% of data (mid-zoom)
- **tier 2 queries** return 100% of data for a tile (slowest, most detailed)
- **animation mode** fetches entire displacements array (larger transfer, multiple uses)
- **static mode** extracts single time-step value (smaller transfer, mode-specific)

## development

### add new query endpoints

1. edit `app/routes.py`
2. add new route function decorated with `@bp.route()`
3. use `Database().get_conn()` to access DuckDB
4. serialize to arrow with `pa.ipc.RecordBatchStreamWriter()`

### modify column mapping

column mappings are defined per-request via query parameters. to change defaults, edit `app/config.py`.

## deployment

### docker

see `Dockerfile` for containerized deployment:
```bash
docker build -t duckdb-backend .
docker run -p 5000:5000 -e GEOPARQUET_PATH=/data/file.geoparquet duckdb-backend
```

### environment variables (production)

set these before running gunicorn:
```bash
export GEOPARQUET_PATH='/path/to/data.geoparquet'
export FLASK_ENV='production'
```

## license

same as parent project (app-gisat-deckglSandbox)
