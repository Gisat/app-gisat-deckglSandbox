from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import duckdb
import io
import pyarrow as pa
import time

app = Flask(__name__)
CORS(app)

# 🛑 CONFIGURATION - REUSING THE OPTIMIZED 2D FILE (It contains Z data!)
GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet'

print("--- Initializing DuckDB and Loading Extensions (3D Mode) ---")
# 1. Connect once at startup
duckdb_con = duckdb.connect(database=':memory:', read_only=False)
duckdb_con.install_extension("spatial")
duckdb_con.load_extension("spatial")

# 2. Create a "Hot" View
print(f"--- Creating View for {GEOPARQUET_PATH} ---")
try:
    start_time = time.time()
    duckdb_con.execute(f"CREATE OR REPLACE VIEW egms_data_3d AS SELECT * FROM read_parquet('{GEOPARQUET_PATH}')")
    
    # 3. Warm up
    row_count = duckdb_con.execute("SELECT count(*) FROM egms_data_3d").fetchone()[0]
    print(f"✅ View 'egms_data_3d' ready. Total Rows: {row_count}. Time: {time.time() - start_time:.2f}s")
except Exception as e:
    print(f"❌ CRITICAL ERROR initializing view: {e}")

@app.route('/api/dates')
def get_dates():
    try:
        query = "SELECT dates FROM egms_data_3d LIMIT 1"
        dates_list_objects = duckdb_con.execute(query).fetchone()[0]
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/3d-data')
def get_3d_data():
    try:
        # Parameters
        tile_x = request.args.get('tile_x', type=int)
        tile_y = request.args.get('tile_y', type=int)
        date_index = request.args.get('date_index', type=int, default=0)
        mode = request.args.get('mode', type=str, default='static')
        target_tier = request.args.get('tier', type=int, default=0)

        db_index = date_index + 1
        
        # Select Height for 3D
        base_cols = "x AS longitude, y AS latitude, height"

        if mode == 'animation':
            selection_col = "displacements" # Returns list of floats
            # Also select mean_velocity for 3D sizing logic if needed?
            # The frontend uses mean_velocity for size. Let's include it.
            base_cols += ", mean_velocity"
        else:
            selection_col = "displacements[?] AS displacement"
            base_cols += ", mean_velocity"
            
        is_global = request.args.get('global') == 'true'

        if is_global:
            # Tier 0 (Global)
            query = f"""
            SELECT {base_cols}, {selection_col}
            FROM egms_data_3d WHERE tier_id = 0
            """
            
            if mode == 'animation':
                 final_params = []
            else:
                 final_params = [db_index]

        else:
            # Tier 1 & 2 (Tiled)
            if tile_x is None or tile_y is None:
                return jsonify({"error": "tile_x and tile_y are required for tiled requests"}), 400

            query = f"""
            SELECT {base_cols}, {selection_col}
            FROM egms_data_3d
            WHERE
                tile_x = ?
                AND tile_y = ?
                AND tier_id = ?
            """
            
            if mode == 'animation':
                final_params = [tile_x, tile_y, target_tier]
            else:
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
    print("\n--- Starting 3D Backend ---")
    # Threaded=False for stability
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=False)
