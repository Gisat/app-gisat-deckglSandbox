# generate_hybrid_geoparquet.py
import duckdb
import geopandas as gpd
import pandas as pd
import os

# --- Configuration ---
INPUT_WIDE_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
OUTPUT_HYBRID_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid_optimized.geoparquet' # Changed output name
# List of all your static, non-date columns
STATIC_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]
# --- NEW: Row Group Size Configuration ---
OPTIMAL_ROW_GROUP_SIZE = 122880 # Recommended by DuckDB docs
# --- End Configuration ---

print(f"--- Starting Spatially Optimized Hybrid GeoParquet Generation ---")

con = duckdb.connect()

try:
    static_cols_str = ", ".join([f'"{col}"' for col in STATIC_COLUMNS])

    query = f"""
    WITH UnpivotedData AS (
        UNPIVOT read_csv_auto('{INPUT_WIDE_CSV_PATH}')
        ON COLUMNS(* EXCLUDE ({static_cols_str}))
        INTO NAME date_str VALUE displacement
    )
    SELECT
        {static_cols_str},
        LIST(STRPTIME(date_str, '%Y%m%d')::DATE) AS dates,
        LIST(displacement) AS displacements
    FROM UnpivotedData
    GROUP BY {static_cols_str};
    """

    print("Running DuckDB transformation query...")
    df_hybrid = con.execute(query).fetchdf()
    print(f"Transformation complete. Created hybrid DataFrame with {len(df_hybrid)} rows.")

    # Create the GeoDataFrame
    gdf = gpd.GeoDataFrame(
        df_hybrid,
        geometry=gpd.points_from_xy(x=df_hybrid['longitude'], y=df_hybrid['latitude']),
        crs="EPSG:4326"
    )

    # Spatially sort the data using Hilbert curve
    print("Spatially sorting the data...")
    gdf['hilbert'] = gdf.geometry.hilbert_distance()
    gdf_sorted = gdf.sort_values('hilbert').drop(columns=['hilbert'])
    print("Sorting complete.")

    # --- UPDATED: Save with specified row_group_size ---
    print(f"Saving final hybrid GeoParquet file with row group size: {OPTIMAL_ROW_GROUP_SIZE}...")
    gdf_sorted.to_parquet(
        OUTPUT_HYBRID_GEOPARQUET_PATH,
        index=False,
        compression='snappy', # Snappy is generally a good balance
        row_group_size=OPTIMAL_ROW_GROUP_SIZE # Explicitly set row group size
    )
    print(f"Successfully wrote optimized file to: {OUTPUT_HYBRID_GEOPARQUET_PATH}")
    # --- END UPDATE ---

except Exception as e:
    print(f"An error occurred: {e}")

finally:
    con.close()
    print("DuckDB connection closed.")
