# 3DFLUS Project - AI Assistant Instructions

## 1. Project Context
**Project Name:** 3DFLUS (Topic 3)
**Goal:** Build a high-performance geospatial visualization engine for massive InSAR point cloud data (1.5M+ points) using a "Server-Powered DuckDB" architecture.
**Phase:** Phase 1 (Backend API & Core Pipeline).

---

## 2. Architecture Overview
This project follows a strict **Decoupled Architecture**:
* **Backend (Dockerized Service):** Python/Flask app running DuckDB. It acts as a "streaming engine," sending binary Apache Arrow data to the client.
* **Frontend (Library Mode):** A React/Deck.gl application. The core logic resides in a reusable custom layer (`DuckDBGeoParquetLayer`) intended for publication as an NPM package.

---

## 3. Technology Stack & Constraints

### Backend (Python)
* **Framework:** Flask (served via `gunicorn` in production).
* **Database:** DuckDB (In-Memory mode with `spatial` extension).
* **Data Format:** Apache Arrow (IPC Stream). **NEVER use JSON for point data.**
* **Deployment:** Docker (Alpine/Slim based).

### Frontend (JavaScript/React)
* **Framework:** React + Next.js (Consumer).
* **Visualization:** Deck.gl (Custom `CompositeLayer`).
* **Data Loading:** `@loaders.gl/arrow` (for binary streams).
* **Build Tool:** Vite (Library Mode).

---

## 4. Coding Standards & Patterns

### A. Backend Patterns
**1. Singleton Database Connection:**
Never run `duckdb.connect()` inside a route. Use a Singleton pattern to ensure the connection (and the `spatial` extension) is loaded only once at startup.
# PREFERRED PATTERN
class Database:
_connection = None
@classmethod
def get_connection(cls):
if cls._connection is None:
cls._connection = duckdb.connect(database=':memory:')
cls._connection.load_extension('spatial')
# Initialize Views here...
return cls._connection

**2. Binary Responses:**
API endpoints returning map data must return **Arrow Streams**, not JSON objects.
# PREFERRED PATTERN
import pyarrow.ipc as ipc
# ... (execute query to get arrow_table) ...
sink = io.BytesIO()
with ipc.new_stream(sink, arrow_table.schema) as writer:
writer.write_table(arrow_table)
return send_file(sink, mimetype='application/vnd.apache.arrow.stream')

### B. Frontend Patterns (The "Library" Mindset)
**1. No Hardcoded Logic:**
The `DuckDBGeoParquetLayer` must be generic.
* ❌ **BAD:** `const url = 'http://localhost:5000'`
* ✅ **GOOD:** `const url = this.props.dataUrl`
* ❌ **BAD:** `d.displacement`
* ✅ **GOOD:** `this.props.getValue(d)`

**2. Tiling Strategy:**
We use "Virtual Tiling" (calculating tile coordinates in SQL/Python) rather than physical MVT tiles. The frontend sends the Viewport Bounding Box, and the Backend returns the relevant points.

---

## 5. Critical Rules ("The Guardrails")
1.  **Do NOT use `app.run()`:** The entry point must be a `wsgi.py` file suitable for Gunicorn.
2.  **Do NOT Serialize to JSON:** If a prompt asks to "send points to frontend," assume Arrow IPC format unless specified otherwise.
3.  **Do NOT Hardcode 3DFLUS Business Logic in the Layer:** Keep the Deck.gl layer pure. Business logic (color scales, specific filtering) belongs in the consuming App (Next.js), passed down via props.
4.  **Spatial Indexing:** Always ensure query performance relies on the pre-sorted Hilbert Index or Spatial View in DuckDB.
