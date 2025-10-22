# check_crs.py
import geopandas as gpd

# --- Configuration ---
# Point this to your smaller subset file
INPUT_FILE = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid_subset.geoparquet'
# --------------------

try:
    print(f"Reading CRS from: {INPUT_FILE}")
    gdf = gpd.read_parquet(INPUT_FILE)
    print("\n-----------------------------------------")
    print(f"✅ The detected CRS of your file is: {gdf.crs}")
    print("-----------------------------------------")

except Exception as e:
    print(f"An error occurred: {e}")
