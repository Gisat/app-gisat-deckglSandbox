# app_hybrid.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import duckdb
import os
from functools import lru_cache

app = Flask(__name__)
CORS(app)

# --- Configuration ---
# GEOPARQUET_PATH = './sample_hybrid.geoparquet'
GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid.geoparquet'
# GEOPARQUET_PATH = './sample_100k_hybrid.geoparquet'

# --- DuckDB Connection ---
# This connection is created once when the app starts
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

# --- Cached Query Function ---
@lru_cache(maxsize=256) # Remembers the results of the 256 most recent queries
def get_data_from_db(geoparquet_path, bbox_wkt, db_index):
    """
    This function's results are cached. If called again with the same
    arguments, it will return the saved result instead of running the query.
    """
    print(f"--- CACHE MISS: Running new DuckDB query for index {db_index - 1} ---")
    query = """
    SELECT
        longitude,
        latitude,
        displacements[?] AS displacement
    FROM read_parquet(?)
    WHERE ST_Intersects(geometry, ST_GeomFromText(?))
    """
    params = [db_index, geoparquet_path, bbox_wkt]
    return duckdb_con.execute(query, params).fetchdf()

# --- API Endpoints ---
@app.route('/api/dates')
def get_dates():
    """Returns the single array of dates for the frontend slider."""
    try:
        query = "SELECT dates FROM read_parquet(?) LIMIT 1"
        dates_list_objects = duckdb_con.execute(query, [GEOPARQUET_PATH]).fetchone()[0]
        # Convert each date object to an 'YYYY-MM-DD' string for JSON
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        print(f"Error in /api/dates: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/hybrid-data')
def get_hybrid_data():
    """Gets filtered data for a specific map view and date index."""
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

        # Call the cached function to get the data
        result_df = get_data_from_db(GEOPARQUET_PATH, bbox_wkt, db_index)

        result_json = result_df.to_json(orient="records")

        from flask import Response
        return Response(result_json, mimetype='application/json')
    except Exception as e:
        print(f"Error during DuckDB query: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    if not os.path.exists(GEOPARQUET_PATH):
        print(f"FATAL: GeoParquet file not found at '{GEOPARQUET_PATH}'")
    else:
        print("\n--- Starting Flask Backend with Caching ---")
        app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
