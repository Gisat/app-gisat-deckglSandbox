# app_polygons.py
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import duckdb
import os
import io
import pyarrow as pa

app = Flask(__name__)
CORS(app)

# --- Configuration ---
GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/SO_Praha_Neratovice+h-z-geoportalu+cl_risk_4326.geoparquet'

# --- DuckDB Connection ---
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

@app.route('/api/polygon-data')
def get_polygon_data():
    try:
        min_x = request.args.get('minx', type=float)
        min_y = request.args.get('miny', type=float)
        max_x = request.args.get('maxx', type=float)
        max_y = request.args.get('maxy', type=float)
    except Exception as e:
        return jsonify({"error": f"Invalid filter parameters: {e}"}), 400

    try:
        bbox_wkt = f'POLYGON(({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))'

        # ✅ This query converts geometry to a GeoJSON string, matching the 'object-row-table' approach.
        query = """
        SELECT
            "id_ruian", "dokonceni", "typ_kod", "h", "avg_vel_l_e3", "range_vel_l_e3",
            "range_vel_cum_e3", "avg_abs_accel_e3", "cnt_mp_e3", "cl_risk_e3",
            ST_AsGeoJSON(geometry) as geometry
        FROM read_parquet(?)
        WHERE ST_Intersects(geometry, ST_GeomFromText(?))
        """
        params = [GEOPARQUET_PATH, bbox_wkt]
        arrow_table = duckdb_con.execute(query, params).fetch_arrow_table()
        output_buffer = io.BytesIO()
        with pa.ipc.RecordBatchStreamWriter(output_buffer, arrow_table.schema) as writer:
            writer.write_table(arrow_table)
        output_buffer.seek(0)
        return send_file(output_buffer, mimetype='application/vnd.apache.arrow.stream')
    except Exception as e:
        print(f"Error during DuckDB query: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    print("\n--- Starting Flask Backend for 3D Polygons ---")
    app.run(debug=True, port=5001, host='0.0.0.0', use_reloader=False)
