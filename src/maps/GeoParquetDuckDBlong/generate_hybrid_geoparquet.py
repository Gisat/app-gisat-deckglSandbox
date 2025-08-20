# generate_hybrid_from_wide.py
import duckdb
import geopandas as gpd
import pandas as pd
import os

# --- Configuration ---
# Point this to your ORIGINAL, WIDE-FORMAT CSV file
# INPUT_WIDE_CSV_PATH = './sample_wide.csv'
INPUT_WIDE_CSV_PATH = './sample_100k_wide.csv'
# INPUT_WIDE_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# OUTPUT_HYBRID_GEOPARQUET_PATH = './sample_hybrid.geoparquet'
OUTPUT_HYBRID_GEOPARQUET_PATH = './sample_100k_hybrid.geoparquet'
# OUTPUT_HYBRID_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid.geoparquet'
# List of all your static, non-date columns from the original CSV
STATIC_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]
# --- End Configuration ---

print(f"--- Starting Direct Hybrid GeoParquet Generation from Wide CSV ---")

con = duckdb.connect()

try:
    # Use an f-string to dynamically build the list of static columns for the query
    static_cols_str = ", ".join([f'"{col}"' for col in STATIC_COLUMNS])

    # This single, powerful query performs the entire transformation
    query = f"""
    -- Use a Common Table Expression (CTE) to unpivot the data first
    WITH UnpivotedData AS (
        UNPIVOT read_csv_auto('{INPUT_WIDE_CSV_PATH}')
        ON COLUMNS(* EXCLUDE ({static_cols_str}))
        INTO
            NAME date_str
            VALUE displacement
    )
    -- Now, group the unpivoted data to create the arrays
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

    # Create and save the final GeoDataFrame
    gdf = gpd.GeoDataFrame(
        df_hybrid,
        geometry=gpd.points_from_xy(x=df_hybrid['longitude'], y=df_hybrid['latitude']),
        crs="EPSG:4326"
    )

    print("Saving final hybrid GeoParquet file...")
    gdf.to_parquet(OUTPUT_HYBRID_GEOPARQUET_PATH, index=False, compression='snappy')
    print(f"Successfully wrote hybrid file to: {OUTPUT_HYBRID_GEOPARQUET_PATH}")

except Exception as e:
    print(f"An error occurred: {e}")

finally:
    con.close()
    print("DuckDB connection closed.")
