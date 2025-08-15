# generate_simple_geoparquet.py
import geopandas as gpd
import pandas as pd

# --- Configuration ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
OUTPUT_GEOPARQUET_PATH = './be/egms_simple.geoparquet' # Use a new name
LON_COLUMN_NAME = 'longitude' # Use the correct name for your CSV
LAT_COLUMN_NAME = 'latitude' # Use the correct name for your CSV
CRS_EPSG_CODE = 4326
# --- End Configuration ---

def generate_simple_file(input_csv, output_parquet, lon_col, lat_col, crs):
    print("--- Starting Simple GeoParquet Generation ---")

    # 1. Load data
    df = pd.read_csv(input_csv)
    df.dropna(subset=[lon_col, lat_col], inplace=True)
    print(f"Loaded {len(df)} valid rows.")

    # 2. Create a GeoDataFrame
    # This creates the 'geometry' column (in WKB format when saved)
    # and keeps the original longitude/latitude columns.
    gdf = gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(x=df[lon_col], y=df[lat_col]),
        crs=f"EPSG:{crs}"
    )
    print("Created GeoDataFrame.")

    # 3. Save to GeoParquet
    # GeoPandas handles the metadata correctly.
    gdf.to_parquet(output_parquet, index=False, compression='snappy')
    print(f"Successfully wrote simple GeoParquet to: {output_parquet}")

if __name__ == "__main__":
    generate_simple_file(
        input_csv=INPUT_CSV_PATH,
        output_parquet=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs=CRS_EPSG_CODE
    )
