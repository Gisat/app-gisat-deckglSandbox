# generate_timeseries_geoparquet_chunked.py
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import json
from shapely.geometry import Point

# --- Configuration ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1_reshaped_long.csv' # Use the new reshaped file
# INPUT_CSV_PATH = './sample_reshaped_long.csv' # Use the new reshaped file
OUTPUT_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_timeseries.geoparquet'
# OUTPUT_GEOPARQUET_PATH = './sample_timeseries.geoparquet'
LON_COLUMN_NAME = 'longitude'
LAT_COLUMN_NAME = 'latitude'
CRS_EPSG_CODE = 4326
CHUNK_SIZE = 5000000 # Process 5 million rows at a time
# --- End Configuration ---

print("--- Starting Robust Chunked Time-Series GeoParquet Generation ---")

chunk_iterator = pd.read_csv(INPUT_CSV_PATH, chunksize=CHUNK_SIZE)
parquet_writer = None
total_rows = 0

for i, df_chunk in enumerate(chunk_iterator):
    print(f"Processing chunk #{i+1}...")

    # 1. --- THE FIX: Manually create the WKB geometry column ---
    # We work with the plain pandas DataFrame and avoid creating a GeoDataFrame here.
    df_chunk['geometry'] = [Point(xy).wkb for xy in zip(df_chunk[LON_COLUMN_NAME], df_chunk[LAT_COLUMN_NAME])]

    # 2. Convert the plain pandas DataFrame chunk to a PyArrow Table.
    # This is safe because all columns now have standard types (bytes, strings, numbers).
    arrow_table_chunk = pa.Table.from_pandas(df_chunk, preserve_index=False)

    # 3. For the first chunk, create the full GeoParquet schema and initialize the writer
    if parquet_writer is None:
        print("Initializing Parquet writer with full GeoParquet schema...")

        # Create the top-level GeoParquet file metadata
        geoparquet_metadata = {
            "version": "1.0.0",
            "primary_column": "geometry",
            "columns": {
                "geometry": {
                    "encoding": "WKB",
                    "crs": f"EPSG:{CRS_EPSG_CODE}",
                    "geometry_types": ["Point"]
                }
            }
        }
        geo_metadata_bytes = json.dumps(geoparquet_metadata).encode('utf-8')

        # Add this metadata to the schema of our first chunk
        final_schema = arrow_table_chunk.schema.with_metadata({b"geo": geo_metadata_bytes})

        # Open the Parquet file for writing using this final schema
        parquet_writer = pq.ParquetWriter(OUTPUT_GEOPARQUET_PATH, final_schema, compression='snappy')

    # 4. Write the current chunk to the Parquet file
    parquet_writer.write_table(arrow_table_chunk)
    total_rows += len(df_chunk)
    print(f"  ...wrote {len(df_chunk)} rows. Total rows so far: {total_rows}")

# 5. Close the writer to finalize the file
if parquet_writer:
    parquet_writer.close()
    print("\n--- Script Finished Successfully ---")
    print(f"Successfully wrote {total_rows} total rows to: {OUTPUT_GEOPARQUET_PATH}")
else:
    print("No data was processed.")
