# app_timeseries.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import duckdb
import os

app = Flask(__name__)
CORS(app)

# --- Configuration ---
# Point to your reshaped, long-format file
GEOPARQUET_PATH = './sample_timeseries.geoparquet'

# --- DuckDB Connection ---
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

@app.route('/api/timeseries-data')
def get_timeseries_data():
    try:
        min_x = request.args.get('minx', type=float)
        min_y = request.args.get('miny', type=float)
        max_x = request.args.get('maxx', type=float)
        max_y = request.args.get('maxy', type=float)
        target_date = request.args.get('date') # e.g., '2022-03-31'

        if None in [min_x, min_y, max_x, max_y] or not target_date:
            return jsonify({"error": "Missing required parameters."}), 400
    except Exception as e:
        return jsonify({"error": f"Invalid parameters: {e}"}), 400

    try:
        bbox_wkt = f'POLYGON(({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, {min_x} {max_y}, {min_x} {min_y}))'

        # This query filters by space and a single date, selecting the displacement value
        query = """
        SELECT longitude, latitude, displacement
        FROM read_parquet(?)
        WHERE ST_Intersects(geometry, ST_GeomFromText(?)) AND date = ?
        """

        result_json = duckdb_con.execute(query, [GEOPARQUET_PATH, bbox_wkt, target_date]).fetchdf().to_json(orient="records")

        from flask import Response
        return Response(result_json, mimetype='application/json')

    except Exception as e:
        print(f"Error during DuckDB query: {e}")
        return jsonify({"error": "Internal server error."}), 500

if __name__ == '__main__':
    print("\n--- Starting Flask Backend for Time-Series ---")
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
