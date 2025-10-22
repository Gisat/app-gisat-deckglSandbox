# create_subset_geoparquet.py
import geopandas as gpd

# --- Configuration ---
INPUT_FILE = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid.geoparquet'
OUTPUT_FILE = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid_subset.geoparquet'
ROW_LIMIT = 10000
# --------------------

print(f"--- Creating a valid GeoParquet subset using GeoPandas ---")

try:
    # 1. Read the original, large GeoParquet file using GeoPandas
    print(f"Reading original file: {INPUT_FILE}")
    gdf = gpd.read_parquet(INPUT_FILE)
    print("Original file read successfully.")

    # 2. Take the first N rows to create the subset
    print(f"Creating subset with the first {ROW_LIMIT} rows...")
    gdf_subset = gdf.head(ROW_LIMIT)

    # 3. Save the subset to a new, valid GeoParquet file
    print(f"Saving new subset file to: {OUTPUT_FILE}")
    gdf_subset.to_parquet(OUTPUT_FILE, index=False, compression='snappy')

    print(f"✅ Successfully created subset file.")

except Exception as e:
    print(f"An error occurred: {e}")
