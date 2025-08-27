# app_hybrid.py
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import duckdb
import os
import io
import pyarrow as pa # Import pyarrow

app = Flask(__name__)
CORS(app)

# --- Configuration ---
GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid.geoparquet'
# GEOPARQUET_PATH = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/egms_hybrid.geoparquet'

# --- DuckDB Connection ---
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

@app.route('/api/dates')
def get_dates():
    """Returns the single array of dates for the frontend slider (as JSON)."""
    try:
        query = "SELECT dates FROM read_parquet(?) LIMIT 1"
        dates_list_objects = duckdb_con.execute(query, [GEOPARQUET_PATH]).fetchone()[0]
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        print(f"Error in /api/dates: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/hybrid-data')
def get_hybrid_data():
    """Gets filtered data and returns it in the binary Arrow IPC format."""
    try:
        min_x = request.args.get('minx', type=float)
        min_y = request.args.get('miny', type=float)
        max_x = request.args.get('maxx', type=float)
        max_y = request.args.get('maxy', type=float)
        date_index = request.args.get('date_index', type=int)
        if None in [min_x, min_y, max_x, max_y, date_index]:
            return jsonify({"error": "Missing required parameters."}), 400
    except Exception as e:
        return jsonify({"error": f"Invalid filter parameters: {e}"}), 400

    try:
        bbox_wkt = f'POLYGON(({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))'
        db_index = date_index + 1

        query = """
        SELECT longitude, latitude, displacements[?] AS displacement
        FROM read_parquet(?)
        WHERE ST_Intersects(geometry, ST_GeomFromText(?))
        """
        params = [db_index, GEOPARQUET_PATH, bbox_wkt]

        # --- Fetch data as a PyArrow Table ---
        arrow_table = duckdb_con.execute(query, params).fetch_arrow_table()

        # --- Write the table to an in-memory buffer in Arrow IPC format ---
        output_buffer = io.BytesIO()
        with pa.ipc.RecordBatchStreamWriter(output_buffer, arrow_table.schema) as writer:
            writer.write_table(arrow_table)
        output_buffer.seek(0)

        # --- Send the binary Arrow data ---
        return send_file(output_buffer, mimetype='application/vnd.apache.arrow.stream')

    except Exception as e:
        print(f"Error during DuckDB query: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    print("\n--- Starting Flask Backend for Arrow ---")
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
