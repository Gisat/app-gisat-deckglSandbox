import duckdb
import os
import time

# --- CONFIGURATION ---
# 1. Input: Path to your InSAR CSV data
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'

# 2. Output: Where to save the optimized GeoParquet
OUTPUT_PARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_virtual_tiles_lod.geoparquet'

# 3. Grid Size: 0.10 degrees (Must match React Frontend)
GRID_SIZE = 0.10

# 4. Row Group Size: Optimized for selective reading
ROW_GROUP_SIZE = 15000

# 5. Static Columns to exclude from unpivoting
STATIC_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]
# --- END CONFIGURATION ---

def generate_data():
    print(f"--- Starting Virtual Tiling + LOD Generation ---")
    start_time = time.time()

    # Initialize DuckDB
    con = duckdb.connect()
    con.install_extension('spatial')
    con.load_extension('spatial')

    try:
        # Format the list of static columns for the SQL query
        static_cols_str = ", ".join([f'"{col}"' for col in STATIC_COLUMNS])

        # --- THE QUERY ---
        # Note: No trailing semicolon inside this string!
        query = f"""
        WITH UnpivotedData AS (
            UNPIVOT read_csv_auto('{INPUT_CSV_PATH}')
            ON COLUMNS(* EXCLUDE ({static_cols_str}))
            INTO NAME date_str VALUE displacement
        ),
        GroupedData AS (
            SELECT
                {static_cols_str},
                LIST(STRPTIME(date_str, '%Y%m%d')::DATE) AS dates,
                LIST(displacement) AS displacements
            FROM UnpivotedData
            GROUP BY {static_cols_str}
        )
        SELECT
            * EXCLUDE (latitude, longitude),

            -- 1. Create "Virtual Tile" Indices (Integers)
            FLOOR(longitude / {GRID_SIZE})::INTEGER AS tile_x,
            FLOOR(latitude / {GRID_SIZE})::INTEGER AS tile_y,

            -- 2. Create LOD Sampling Index (0-100)
            ABS(HASH(pid) % 100)::SMALLINT AS sample_idx,

            -- 3. BBox Columns (For Metadata Pruning)
            longitude AS bbox_xmin,
            latitude AS bbox_ymin,
            longitude AS bbox_xmax,
            latitude AS bbox_ymax,

            -- 4. Geometry
            ST_GeomFromWKB(ST_AsWKB(ST_Point(longitude, latitude))) AS geometry

        FROM GroupedData

        -- 🛑 THE GOLDEN SORT ORDER
        ORDER BY tile_x ASC, tile_y ASC, sample_idx ASC
        """

        print("🚀 Running transformation and sorting...")
        print("   (This may take a minute...)")

        # Execute the COPY command
        copy_cmd = f"""
        COPY ({query}) TO '{OUTPUT_PARQUET_PATH}' (
            FORMAT PARQUET,
            ROW_GROUP_SIZE {ROW_GROUP_SIZE},
            COMPRESSION SNAPPY
        );
        """
        con.execute(copy_cmd)

        elapsed = time.time() - start_time
        print(f"✅ Success! File generated at: {OUTPUT_PARQUET_PATH}")
        print(f"⏱️  Time taken: {elapsed:.2f} seconds")

        # --- VERIFICATION ---
        print("\n🔎 Verifying output schema...")
        # We explicitly use read_parquet to avoid the 'Binder Error'
        check_sql = f"DESCRIBE SELECT * FROM read_parquet('{OUTPUT_PARQUET_PATH}')"
        result = con.sql(check_sql).fetchall()

        columns = [r[0] for r in result]
        if 'tile_x' in columns and 'sample_idx' in columns:
            print("   OK: 'tile_x' and 'sample_idx' columns found.")
        else:
            print("   ⚠️ WARNING: New columns missing!")

    except Exception as e:
        print(f"\n❌ ERROR: {e}")

    finally:
        con.close()

if __name__ == "__main__":
    generate_data()
