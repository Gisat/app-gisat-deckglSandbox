# generate_hybrid_geoparquet.py
import duckdb
import geopandas as gpd
import pandas as pd
import os

# --- Configuration ---
# Point this to your ORIGINAL, WIDE-FORMAT CSV file
# INPUT_WIDE_CSV_PATH = './sample_wide.csv'
# INPUT_WIDE_CSV_PATH = './sample_100k_wide.csv'
INPUT_WIDE_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# OUTPUT_HYBRID_GEOPARQUET_PATH = './sample_hybrid.geoparquet'
# OUTPUT_HYBRID_GEOPARQUET_PATH = './sample_100k_hybrid.geoparquet'
OUTPUT_HYBRID_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid.geoparquet'
# List of all your static, non-date columns from the original CSV
STATIC_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]
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

    # --- FIX: Spatially sort the data correctly in two steps ---
    print("Spatially sorting the data...")
    # 1. Create a new, temporary column containing the hilbert distance
    gdf['hilbert'] = gdf.geometry.hilbert_distance()

    # 2. Sort the DataFrame BY THE NAME of the new column, then drop it
    gdf_sorted = gdf.sort_values('hilbert').drop(columns=['hilbert'])
    print("Sorting complete.")

    print("Saving final hybrid GeoParquet file...")
    gdf_sorted.to_parquet(OUTPUT_HYBRID_GEOPARQUET_PATH, index=False, compression='snappy')
    print(f"Successfully wrote spatially sorted file to: {OUTPUT_HYBRID_GEOPARQUET_PATH}")

except Exception as e:
    print(f"An error occurred: {e}")

finally:
    con.close()
    print("DuckDB connection closed.")
