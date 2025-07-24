# generate_data_minimal.py
import geopandas as gpd
import pandas as pd

# --- Configuration ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
OUTPUT_GEOPARQUET_PATH = './be/EGMS_backend_filterable_dual_geom.parquet'
LON_COLUMN_NAME = 'longitude'
LAT_COLUMN_NAME = 'latitude'
CRS_EPSG_CODE = 4326

# --- Column Export Configuration ---
EXPORT_ALL_COLUMNS = False

# This is now an empty list to exclude latitude and longitude from the final output.
COLUMNS_TO_KEEP = []
# --- End Configuration ---


def generate_minimal(input_csv, output_parquet, lon_col, lat_col, crs, export_all, columns_to_keep):
    """
    Generates a minimal GeoParquet file with only WKB and rendering coordinate columns.
    """
    print("--- Starting Minimal GeoParquet Generation ---")

    # 1. Load and prepare data
    df = pd.read_csv(input_csv)
    df.dropna(subset=[lon_col, lat_col], inplace=True)
    print(f"Loaded {len(df)} valid rows from CSV.")

    # 2. Create rendering and geometry columns
    df['render_coords'] = df[[lon_col, lat_col]].values.tolist()
    gdf = gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(x=df[lon_col], y=df[lat_col]),
        crs=f"EPSG:{crs}"
    )
    print("Created 'geometry' and 'render_coords' columns.")

    # 3. Filter columns if specified
    if not export_all:
        final_columns = columns_to_keep + ['geometry', 'render_coords']
        columns_that_exist = [col for col in final_columns if col in gdf.columns]

        print(f"\nSelecting final subset of columns: {columns_that_exist}")
        gdf = gdf[columns_that_exist]
    else:
        print("\nKeeping all original columns.")

    # 4. Save to GeoParquet
    print(f"Writing {len(gdf.columns)} columns to GeoParquet file: {output_parquet}")
    gdf.to_parquet(output_parquet, index=False, compression='snappy')

    print("\n--- Script Finished Successfully ---")


if __name__ == "__main__":
    generate_minimal(
        input_csv=INPUT_CSV_PATH,
        output_parquet=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs=CRS_EPSG_CODE,
        export_all=EXPORT_ALL_COLUMNS,
        columns_to_keep=COLUMNS_TO_KEEP
    )
