# app.py
from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import duckdb
import io
import os
import pyarrow as pa
import pyarrow.parquet as pq
import json

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}})

# --- Configuration ---
GEOPARQUET_PATH = './EGMS_backend_filterable_dual_geom.parquet'
CRS_EPSG_CODE = 4326 # The EPSG code used in your data

# --- DuckDB Connection ---
try:
    print("Initializing DuckDB connection...")
    duckdb_con = duckdb.connect(database=':memory:', read_only=False)
    duckdb_con.install_extension("spatial")
    duckdb_con.load_extension("spatial")
    print("DuckDB connection ready. ✅")
except Exception as e:
    duckdb_con = None

# --- API Endpoint for Filtered Data ---
@app.route('/api/filtered-geoparquet')
def filtered_geoparquet():
    if not duckdb_con:
        return jsonify({"error": "Backend database connection not available."}), 500

    try:
        min_x = request.args.get('minx', type=float)
        min_y = request.args.get('miny', type=float)
        max_x = request.args.get('maxx', type=float)
        max_y = request.args.get('maxy', type=float)
        if None in [min_x, min_y, max_x, max_y]:
            return jsonify({"error": "Bounding box not provided."}), 400
    except Exception as e:
        return jsonify({"error": f"Invalid bounding box parameters: {e}"}), 400

    try:
        bbox_wkt = f'POLYGON(({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))'

        # 1. Get filtered data from DuckDB. This result has no metadata.
        query = f"SELECT render_coords FROM read_parquet('{GEOPARQUET_PATH}') WHERE ST_Intersects(geometry, ST_GeomFromText('{bbox_wkt}'))"
        result_table_from_db = duckdb_con.execute(query).fetch_arrow_table()

        if result_table_from_db.num_rows == 0: return ('', 204)

        # 2. --- THE DEFINITIVE FIX: Rebuild the entire schema from scratch ---

        render_coords_array = result_table_from_db.column('render_coords')

        # 2a. Create the column-level metadata for GeoArrow
        geo_field = pa.field('render_coords', render_coords_array.type, metadata={b'ARROW:extension:name': b'geoarrow.point'})

        # 2b. Create the top-level GeoParquet file metadata
        geoparquet_metadata = {
            "version": "1.0.0",
            "primary_column": "render_coords", # This file's primary column is the one we're sending
            "columns": {
                "render_coords": {
                    "encoding": "geoarrow", # The encoding is GeoArrow Point
                    "crs": f"EPSG:{CRS_EPSG_CODE}",
                    "geometry_types": ["Point"]
                }
            }
        }

        # 2c. Create the final schema, combining the field and the top-level metadata
        final_schema = pa.schema([geo_field]).with_metadata({b"geo": json.dumps(geoparquet_metadata).encode('utf-8')})

        # 2d. Create the final table with the corrected data and schema
        final_table_to_send = pa.Table.from_arrays([render_coords_array], schema=final_schema)
        print("Rebuilt table with complete GeoParquet and GeoArrow metadata. ✅")

        # 3. Write this fully corrected table to the buffer and send
        output_buffer = io.BytesIO()
        pq.write_table(final_table_to_send, output_buffer, compression='snappy')
        output_buffer.seek(0)

        return send_file(output_buffer, mimetype='application/octet-stream', as_attachment=False)

    except Exception as e:
        print(f"Error during query or data preparation: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    if not os.path.exists(GEOPARQUET_PATH):
        print(f"FATAL: GeoParquet file not found at '{GEOPARQUET_PATH}'")
    else:
        print("\n--- Starting Flask Backend with DuckDB ---")
        app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
