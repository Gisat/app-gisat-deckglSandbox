# app.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import duckdb
import os

app = Flask(__name__)
CORS(app) # Allow all origins for development

# --- Configuration ---
# Ensure this points to the GeoParquet file created by the simple generation script
GEOPARQUET_PATH = './egms_simple.geoparquet'

# --- DuckDB Connection ---
try:
    print("Initializing DuckDB connection...")
    duckdb_con = duckdb.connect(database=':memory:', read_only=False)
    duckdb_con.install_extension("spatial")
    duckdb_con.load_extension("spatial")
    print("DuckDB connection ready. ✅")
except Exception as e:
    duckdb_con = None

@app.route('/api/data')
def get_filtered_data():
    if not duckdb_con:
        return jsonify({"error": "Database connection not available."}), 500

    # 1. Get spatial and attribute filters from the request
    try:
        min_x = request.args.get('minx', type=float)
        min_y = request.args.get('miny', type=float)
        max_x = request.args.get('maxx', type=float)
        max_y = request.args.get('maxy', type=float)

        # This matches the single value sent by your slider
        max_velocity = request.args.get('max_velocity', default=100.0, type=float)

        if None in [min_x, min_y, max_x, max_y]:
            return jsonify({"error": "Bounding box not provided."}), 400
    except Exception as e:
        return jsonify({"error": f"Invalid filter parameters: {e}"}), 400

    try:
        # 2. Construct the SQL query
        bbox_wkt = f'POLYGON(({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))'

        # This query selects the columns needed by your frontend
        # and filters using the absolute value of mean_velocity to match the slider
        query = f"""
        SELECT
            longitude,
            latitude,
            mean_velocity
        FROM
            read_parquet('{GEOPARQUET_PATH}')
        WHERE
            ST_Intersects(geometry, ST_GeomFromText($bbox)) AND
            abs(mean_velocity) <= $max_vel
        """

        # 3. Execute query and return result as JSON
        params = {'bbox': bbox_wkt, 'max_vel': max_velocity}
        result_json = duckdb_con.execute(query, params).fetchdf().to_json(orient="records")

        from flask import Response
        return Response(result_json, mimetype='application/json')

    except Exception as e:
        print(f"Error during DuckDB query: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    if not os.path.exists(GEOPARQUET_PATH):
        print(f"FATAL: GeoParquet file not found at '{GEOPARQUET_PATH}'")
    else:
        print("\n--- Starting Flask Backend for JSON ---")
        app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
