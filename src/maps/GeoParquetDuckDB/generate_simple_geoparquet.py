# generate_simple_geoparquet.py
import geopandas as gpd
import pandas as pd

# --- Configuration ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
OUTPUT_GEOPARQUET_PATH = './be/egms_simple.geoparquet'
LON_COLUMN_NAME = 'longitude'
LAT_COLUMN_NAME = 'latitude'
CRS_EPSG_CODE = 4326
# --- End Configuration ---

def generate_simple_file(input_csv, output_parquet, lon_col, lat_col, crs):
    print("--- Starting Simple GeoParquet Generation ---")

    # 1. Load all data from the CSV
    df = pd.read_csv(input_csv)
    df.dropna(subset=[lon_col, lat_col], inplace=True)
    print(f"Loaded {len(df)} valid rows with {len(df.columns)} columns.")

    # 2. Create a GeoDataFrame
    # This step creates the 'geometry' column while preserving all other columns from the original DataFrame.
    gdf = gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(x=df[lon_col], y=df[lat_col]),
        crs=f"EPSG:{crs}"
    )
    print("Created GeoDataFrame, preserving all attribute columns.")

    # 3. Save to GeoParquet
    # The output file will now contain the geometry column plus all original attributes.
    gdf.to_parquet(output_parquet, index=False, compression='snappy')
    print(f"Successfully wrote GeoParquet to: {output_parquet}")
    print(f"Final file includes columns: {gdf.columns.tolist()}")

if __name__ == "__main__":
    generate_simple_file(
        input_csv=INPUT_CSV_PATH,
        output_parquet=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs=CRS_EPSG_CODE
    )
