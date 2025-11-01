# generate_hybrid_geoparquet.py
import duckdb
import geopandas as gpd
import pandas as pd
import os

# --- Configuration ---
INPUT_WIDE_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# Update the output path to reflect the new structure
OUTPUT_HYBRID_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_hybrid_optimized_bbox.geoparquet'
# List of all your static, non-date columns
STATIC_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]
# --- Row Group Size Configuration ---
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
    # Note: requires shapely >= 2.0 for hilbert_distance
    try:
        gdf['hilbert'] = gdf.geometry.hilbert_distance()
        gdf_sorted = gdf.sort_values('hilbert').drop(columns=['hilbert'])
        print("Sorting complete.")
    except AttributeError:
        print("⚠️ Warning: Could not perform Hilbert sorting. Requires shapely >= 2.0. Proceeding without sorting.")
        gdf_sorted = gdf # Use unsorted data if Hilbert fails


    # --- NEW: Add Bounding Box Columns ---
    # For points, the min and max of the bbox are just the x/y coordinates.
    # These simple numeric columns *can* have statistics in Parquet,
    # enabling DuckDB to perform row group pruning on spatial queries.
    print("Creating numeric bbox columns for spatial indexing...")
    gdf_sorted['bbox_xmin'] = gdf_sorted.geometry.x
    gdf_sorted['bbox_ymin'] = gdf_sorted.geometry.y
    gdf_sorted['bbox_xmax'] = gdf_sorted.geometry.x
    gdf_sorted['bbox_ymax'] = gdf_sorted.geometry.y
    print("Bbox columns created.")
    # --- END NEW ---


    # --- Save with specified row_group_size ---
    print(f"Saving final hybrid GeoParquet file with row group size: {OPTIMAL_ROW_GROUP_SIZE}...")
    gdf_sorted.to_parquet(
        OUTPUT_HYBRID_GEOPARQUET_PATH,
        index=False,
        compression='snappy', # Snappy is generally a good balance
        row_group_size=OPTIMAL_ROW_GROUP_SIZE # Explicitly set row group size
    )
    print(f"Successfully wrote optimized file to: {OUTPUT_HYBRID_GEOPARQUET_PATH}")

except Exception as e:
    print(f"An error occurred: {e}")

finally:
    con.close()
    print("DuckDB connection closed.")
