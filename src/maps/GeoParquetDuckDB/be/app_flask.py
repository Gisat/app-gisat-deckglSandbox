# app_flask.py
from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import pyarrow.dataset as ds
import pyarrow.parquet as pq
import pyarrow as pa
import io
import os

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# --- Configuration for Backend ---
# Point to the LOCAL path of the GeoParquet file that includes your attributes (LON_CENTER, LAT_CENTER, etc.).
# Make sure you've run generate_data.py to create this file.
LARGE_GEOPARQUET_SOURCE = './EGMS_L2b_146_0296_IW2_VV_2019_2023_1_geom_only.parquet'

# --- Load the large GeoParquet file ONCE as a PyArrow Dataset (Binary-First) ---
try:
    print(f"Loading large GeoParquet file as PyArrow Dataset: {LARGE_GEOPARQUET_SOURCE}")
    global geo_parquet_dataset
    geo_parquet_dataset = ds.dataset(LARGE_GEOPARQUET_SOURCE, format='parquet')

    print(f"PyArrow Dataset loaded. Schema:\n{geo_parquet_dataset.schema}")
except Exception as e:
    print(f"CRITICAL ERROR: Failed to load large GeoParquet file as PyArrow Dataset: {e}")
    geo_parquet_dataset = None

# --- API Endpoint for Filtered GeoParquet Data ---
@app.route('/api/filtered-geoparquet') # Keep the same endpoint URL for frontend
def filtered_geoparquet():
    if geo_parquet_dataset is None:
        return jsonify({"error": "Backend data not loaded. Check server logs."}), 500

    # --- REMOVED: BBOX parsing and validation ---
    # These parameters are no longer used for filtering in this version.
    # min_x = request.args.get('minx', type=float)
    # min_y = request.args.get('miny', type=float)
    # max_x = request.args.get('maxx', type=float)
    # max_y = request.args.get('maxy', type=float)
    # if None in [min_x, min_y, max_x, max_y]:
    #     min_x, min_y, max_x, max_y = 14.42, 50.03, 14.46, 50.06
    #     print(f"Warning: No BBOX provided, using default for Prague: {min_x}, {min_y}, {max_x}, {max_y}")
    # else:
    #     print(f"Received BBOX query: minx={min_x}, miny={min_y}, maxx={max_x}, max_y={max_y}")

    try:
        # 1. Read the ENTIRE Dataset into a PyArrow Table (no filtering applied)
        # This will load the whole file into server memory for sending.
        filtered_pyarrow_table = geo_parquet_dataset.to_table() # <-- FIX: No filter_expr or columns argument

        # 2. Select all columns for the output (or specific ones if you want to explicitly limit output)
        # This line is technically redundant now as .to_table() loads all.
        # columns_to_select = geo_parquet_dataset.schema.names

        print(f"Loaded ENTIRE PyArrow Table. Rows: {filtered_pyarrow_table.num_rows}")
        print(f"Schema (full table):\n{filtered_pyarrow_table.schema}")

        # 3. Write the PyArrow Table to an in-memory BytesIO buffer as GeoParquet.
        output_buffer = io.BytesIO()
        pq.write_table(
            filtered_pyarrow_table,
            output_buffer,
            compression='snappy', # Use snappy compression
        )
        output_buffer.seek(0)

        # 4. Send the GeoParquet file back to the client.
        file_size_mb = output_buffer.tell() / (1024 * 1024)
        print(f"Returning ENTIRE GeoParquet file. Size: {file_size_mb:.2f} MB")

        response = send_file(output_buffer, mimetype='application/octet-stream', as_attachment=False, download_name='full_data.parquet') # Changed download_name for clarity

        print("\n--- Backend Response Headers (DEBUG) ---")
        for header, value in response.headers.items():
            print(f"  {header}: {value}")
        print("------------------------------------------")

        return response

    except Exception as e:
        print(f"Error executing PyArrow Dataset query or sending file: {e}")
        return jsonify({"error": str(e)}), 500

# --- How to Run the Flask Application ---
if __name__ == '__main__':
    print("\n--- Starting Flask Backend ---")
    print("Flask app will be accessible at http://127.0.0.1:5000")
    app.run(debug=True, port=5000, host='0.0.0.0')
