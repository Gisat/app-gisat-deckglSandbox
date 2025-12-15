from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import duckdb
import io
import pyarrow as pa
import time

app = Flask(__name__)
CORS(app)

# 🛑 CONFIGURATION
# GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet'
GEOPARQUET_PATH = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet'

print("--- Initializing DuckDB and Loading Extensions ---")
# 1. Connect once at startup
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

# 2. Create a "Hot" View
# This loads the Parquet metadata into memory once, avoiding I/O for metadata on every request.
print(f"--- Creating View for {GEOPARQUET_PATH} ---")
try:
    start_time = time.time()
    duckdb_con.execute(f"CREATE OR REPLACE VIEW egms_data AS SELECT * FROM read_parquet('{GEOPARQUET_PATH}')")

    # 3. Warm up / Verification
    # Running a simple count forces DuckDB to read the footer and row groups layout.
    row_count = duckdb_con.execute("SELECT count(*) FROM egms_data").fetchone()[0]
    print(f"✅ View 'egms_data' ready. Total Rows: {row_count}. Time: {time.time() - start_time:.2f}s")
except Exception as e:
    print(f"❌ CRITICAL ERROR initializing view: {e}")

@app.route('/api/dates')
def get_dates():
    try:
        # Query the View instead of the file
        query = "SELECT dates FROM egms_data LIMIT 1"
        dates_list_objects = duckdb_con.execute(query).fetchone()[0]
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/hybrid-data')
def get_hybrid_data():
    try:
        # Parameters
        tile_x = request.args.get('tile_x', type=int)
        tile_y = request.args.get('tile_y', type=int)
        date_index = request.args.get('date_index', type=int, default=0)
        mode = request.args.get('mode', type=str, default='static')
        target_tier = request.args.get('tier', type=int, default=0)

        db_index = date_index + 1

        # --- CONFIGURATION LOGIC ---
        # Define what column to select based on mode
        if mode == 'animation':
            selection_col = "displacements"
            # We don't need params for selection_col in animation mode
        else:
            selection_col = "displacements[?] AS displacement"

        is_global = request.args.get('global') == 'true'

        if is_global:
            # Global fetch for Tier 0
            query = f"""
            SELECT x AS longitude, y AS latitude, {selection_col}
            FROM egms_data WHERE tier_id = 0
            """

            if mode == 'animation':
                 # Query: SELECT ... displacements ... WHERE tier_id = 0
                 # Params: None
                 final_params = []
            else:
                 # Query: SELECT ... displacements[?] ... WHERE tier_id = 0
                 # Params: [date_index]
                 final_params = [db_index]

        else:
            # Standard Tiled Fetch (Tier 1 & 2)
            if tile_x is None or tile_y is None:
                return jsonify({"error": "tile_x and tile_y are required for tiled requests"}), 400

            query = f"""
            SELECT
                x AS longitude,
                y AS latitude,
                {selection_col}
            FROM egms_data
            WHERE
                tile_x = ?
                AND tile_y = ?
                AND tier_id = ?
            """

            if mode == 'animation':
                # Query: ... displacements ... WHERE tile_x=? AND tile_y=? AND tier_id=?
                final_params = [tile_x, tile_y, target_tier]
            else:
                # Query: ... displacements[?] ... WHERE tile_x=? AND tile_y=? AND tier_id=?
                final_params = [db_index, tile_x, tile_y, target_tier]

        # Execute
        arrow_table = duckdb_con.execute(query, final_params).fetch_arrow_table()

        # Send
        output_buffer = io.BytesIO()
        with pa.ipc.RecordBatchStreamWriter(output_buffer, arrow_table.schema) as writer:
            writer.write_table(arrow_table)
        output_buffer.seek(0)

        return send_file(output_buffer, mimetype='application/vnd.apache.arrow.stream')

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("\n--- Starting Backend (Persistent View Enabled) ---")
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
