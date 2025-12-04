import duckdb
import os
import time

# --- CONFIGURATION ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# 🛑 UPDATE: Outputting to v2
OUTPUT_PARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_tiered_v2.geoparquet'

# 🛑 UPDATED: Grid Size: 0.03 (for higher tile precision)
GRID_SIZE = 0.03

# Row Group Size: 25,000 (Optimized for ~2MB chunks)
ROW_GROUP_SIZE = 25000

STATIC_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]

def generate_data():
    print(f"--- Starting 3-Tier Optimization v2 (Grid: {GRID_SIZE}) ---")
    start_time = time.time()

    con = duckdb.connect()
    con.install_extension('spatial')
    con.load_extension('spatial')

    try:
        static_cols_str = ", ".join([f'"{col}"' for col in STATIC_COLUMNS])

        print("1. Reading and Grouping Data...")
        con.execute(f"""
        CREATE TEMP TABLE RawGrouped AS
        WITH UnpivotedData AS (
            UNPIVOT read_csv_auto('{INPUT_CSV_PATH}')
            ON COLUMNS(* EXCLUDE ({static_cols_str}))
            INTO NAME date_str VALUE displacement
        )
        SELECT
            {static_cols_str},
            LIST(STRPTIME(date_str, '%Y%m%d')::DATE) AS dates,
            LIST(displacement::FLOAT) AS displacements
        FROM UnpivotedData
        GROUP BY {static_cols_str}
        """)

        print("2. Calculating Extent for Hilbert Sort...")
        result_tuple = con.sql("SELECT ST_Extent(ST_Point(longitude, latitude)) FROM RawGrouped").fetchone()
        bounds_struct = result_tuple[0]

        min_x = bounds_struct['min_x']
        min_y = bounds_struct['min_y']
        max_x = bounds_struct['max_x']
        max_y = bounds_struct['max_y']

        if max_x == min_x: max_x += 0.0001
        if max_y == min_y: max_y += 0.0001

        print(f"   Bounds used: {min_x}, {min_y}, {max_x}, {max_y}")

        print("3. Sorting (3-Tier + Hilbert) and Writing...")

        query = f"""
        SELECT
            * EXCLUDE (latitude, longitude),

            longitude AS x,
            latitude  AS y,

            FLOOR(longitude / {GRID_SIZE})::INTEGER AS tile_x,
            FLOOR(latitude / {GRID_SIZE})::INTEGER AS tile_y,
            ABS(HASH(pid) % 100)::SMALLINT AS sample_idx,

            -- 🛑 UPDATED 3-TIER LOGIC
            -- Tier 0: 0-5%   (Overview)
            -- Tier 1: 5-35%  (Mid-Res: 30% more points)
            -- Tier 2: 35-100% (High-Res: 65% more points)
            (CASE
                WHEN ABS(HASH(pid) % 100) < 5 THEN 0
                WHEN ABS(HASH(pid) % 100) < 35 THEN 1
                ELSE 2
            END)::SMALLINT AS tier_id,

            ST_GeomFromWKB(ST_AsWKB(ST_Point(longitude, latitude))) AS geometry

        FROM RawGrouped

        ORDER BY
            tier_id ASC,
            ST_Hilbert(
                ST_Point(longitude, latitude),
                {{'min_x': {min_x}, 'min_y': {min_y}, 'max_x': {max_x}, 'max_y': {max_y}}}::BOX_2D
            ) ASC
        """

        con.execute(f"""
        COPY ({query}) TO '{OUTPUT_PARQUET_PATH}' (
            FORMAT PARQUET,
            ROW_GROUP_SIZE {ROW_GROUP_SIZE},
            COMPRESSION ZSTD
        );
        """)

        print(f"✅ Success! Optimized file: {OUTPUT_PARQUET_PATH}")
        print(f"⏱️  Time taken: {time.time() - start_time:.2f} s")

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"❌ Error: {e}")
    finally:
        con.close()

if __name__ == "__main__":
    generate_data()
