# generate_timeseries_geoparquet.py
import geopandas as gpd
import pandas as pd

# --- Configuration ---
# INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1_reshaped_long.csv' # Use the new reshaped file
INPUT_CSV_PATH = './sample_reshaped_long.csv' # Use the new reshaped file
# OUTPUT_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_timeseries.geoparquet'
OUTPUT_GEOPARQUET_PATH = './sample_timeseries.geoparquet'
LON_COLUMN_NAME = 'longitude'
LAT_COLUMN_NAME = 'latitude'
CRS_EPSG_CODE = 4326
# --- End Configuration ---

print("--- Starting Time-Series GeoParquet Generation ---")

# 1. Load the long-format data
df = pd.read_csv(INPUT_CSV_PATH)
df.dropna(subset=[LON_COLUMN_NAME, LAT_COLUMN_NAME], inplace=True)
print(f"Loaded {len(df)} rows.")

# 2. Create the GeoDataFrame, keeping all columns (including date and displacement)
gdf = gpd.GeoDataFrame(
    df,
    geometry=gpd.points_from_xy(x=df[LON_COLUMN_NAME], y=df[LAT_COLUMN_NAME]),
    crs=f"EPSG:{CRS_EPSG_CODE}"
)
print("Created GeoDataFrame.")

# 3. Save the final file
gdf.to_parquet(OUTPUT_GEOPARQUET_PATH, index=False, compression='snappy')
print(f"Successfully wrote time-series GeoParquet to: {OUTPUT_GEOPARQUET_PATH}")
