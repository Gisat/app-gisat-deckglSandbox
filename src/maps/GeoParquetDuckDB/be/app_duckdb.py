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
CORS(app) # Allow all origins for development

# --- Configuration ---
GEOPARQUET_PATH = './EGMS_backend_filterable_dual_geom.parquet'
CRS_EPSG_CODE = 4326

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

        # 1. Get filtered data from DuckDB
        query = f"SELECT render_coords FROM read_parquet('{GEOPARQUET_PATH}') WHERE ST_Intersects(geometry, ST_GeomFromText('{bbox_wkt}'))"
        result_table_from_db = duckdb_con.execute(query).fetch_arrow_table()

        if result_table_from_db.num_rows == 0: return ('', 204)

        # 2. --- THE DEFINITIVE FIX: Rebuild the table with COMPLETE metadata ---
        render_coords_array = result_table_from_db.column('render_coords')

        # 2a. Create a plain field without metadata first
        plain_field = pa.field('render_coords', render_coords_array.type)

        # 2b. Create the complete metadata dictionary
        full_column_metadata = {
            b'ARROW:extension:name': b'geoarrow.point',
            b'ARROW:extension:metadata': json.dumps({"crs": f"EPSG:{CRS_EPSG_CODE}"}).encode('utf-8')
        }

        # 2c. Use the .with_metadata() method to apply the full dictionary
        # This is a more robust way to attach it in older pyarrow versions
        geo_field = plain_field.with_metadata(full_column_metadata)

        # 2d. Create the top-level GeoParquet file metadata
        geoparquet_metadata = {
            "version": "1.0.0", "primary_column": "render_coords",
            "columns": { "render_coords": { "encoding": "geoarrow", "geometry_types": ["Point"] } }
        }

        # 2e. Create the final schema
        final_schema = pa.schema([geo_field]).with_metadata({b"geo": json.dumps(geoparquet_metadata).encode('utf-8')})

        # 2f. Create the final table
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
