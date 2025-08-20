# app_hybrid.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import duckdb
import os

app = Flask(__name__)
CORS(app)

# --- Configuration ---
# GEOPARQUET_PATH = './sample_hybrid.geoparquet'
# GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid.geoparquet'
GEOPARQUET_PATH = './sample_100k_hybrid.geoparquet'

# --- DuckDB Connection ---
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

# --- API Endpoints ---
@app.route('/api/dates')
def get_dates():
    """Returns the single array of dates for the frontend slider."""
    try:
        # --- FIX: Use the more robust read_parquet() function ---
        query = "SELECT dates FROM read_parquet(?) LIMIT 1"
        dates_list = duckdb_con.execute(query, [GEOPARQUET_PATH]).fetchone()[0]
        return jsonify(dates_list)
    except Exception as e:
        print(f"Error in /api/dates: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/hybrid-data')
def get_hybrid_data():
    try:
        min_x = request.args.get('minx', type=float)
        min_y = request.args.get('miny', type=float)
        max_x = request.args.get('maxx', type=float)
        max_y = request.args.get('maxy', type=float)
        date_index = request.args.get('date_index', type=int)

        if None in [min_x, min_y, max_x, max_y, date_index]:
            return jsonify({"error": "Missing required parameters."}), 400
    except Exception as e:
        return jsonify({"error": f"Invalid parameters: {e}"}), 400

    try:
        bbox_wkt = f'POLYGON(({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))'

        # DuckDB arrays are 1-based, so we add 1 to the 0-based index from the frontend
        db_index = date_index + 1

        # --- FIX: Cleaner way to pass parameters ---
        query = """
        SELECT
            longitude,
            latitude,
            displacements[?] AS displacement
        FROM read_parquet(?)
        WHERE ST_Intersects(geometry, ST_GeomFromText(?))
        """

        params = [db_index, GEOPARQUET_PATH, bbox_wkt]
        result_json = duckdb_con.execute(query, params).fetchdf().to_json(orient="records")

        from flask import Response
        return Response(result_json, mimetype='application/json')
    except Exception as e:
        print(f"Error during DuckDB query: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    print("\n--- Starting Flask Backend for Hybrid Data ---")
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
