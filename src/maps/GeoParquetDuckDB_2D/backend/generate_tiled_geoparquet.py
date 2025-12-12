import duckdb
import os
import time

# --- CONFIGURATION ---
# 🛑 Update these paths for your machine
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
OUTPUT_PARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet'

# Grid Size for caching logic (Logic only, physical storage is continuous)
# 0.06 is approx 6.6km. Reduces requests by 4x compared to 0.03.
GRID_SIZE = 0.06

# Row Group Size: 12288 is a "Magic Number" for DuckDB/Parquet
# It ensures row groups are small enough (~1-2MB) for browser HTTP Range requests.
ROW_GROUP_SIZE = 12288

def generate_data():
    print(f"--- Starting Single-File Optimization (Grid: {GRID_SIZE}) ---")
    start_time = time.time()

    con = duckdb.connect()
    # Install/Load Spatial extension for Hilbert Curve & Geometry
    con.install_extension('spatial')
    con.load_extension('spatial')

    try:
        print("1. Processing Data...")
        print("   - Pivoting dates")
        print("   - Calculating Hilbert Curve (Spatial Sort)")
        print("   - Compressing Types (Float64 -> Float32)")

        # We construct the query to do everything in one pass:
        query = f"""
        -- 1. Unpivot the wide CSV (dates as columns) into long format
        WITH UnpivotedData AS (
            UNPIVOT read_csv_auto('{INPUT_CSV_PATH}')
            ON COLUMNS(* EXCLUDE (
                pid, mp_type, latitude, longitude, easting, northing, 
                height, height_wgs84, line, pixel, rmse, temporal_coherence, 
                amplitude_dispersion, incidence_angle, track_angle, los_east, 
                los_north, los_up, mean_velocity, mean_velocity_std, 
                acceleration, acceleration_std, seasonality, seasonality_std
            ))
            INTO NAME date_str VALUE displacement
        ),
        -- 2. Group back by Point, calculating Metadata & Tiers
        GroupedData AS (
            SELECT
                -- Identifiers
                pid,
                
                -- Geometry (Float32 is ~1m precision, sufficient for viz)
                latitude::FLOAT AS y,
                longitude::FLOAT AS x,
                
                -- Pre-calculated Tile Indices (Helps the frontend cache efficiently)
                FLOOR(longitude / {GRID_SIZE})::SMALLINT AS tile_x,
                FLOOR(latitude / {GRID_SIZE})::SMALLINT AS tile_y,

                -- Tier Logic (Determines priority)
                -- Tier 0 (Overview): 5%
                -- Tier 1 (Mid-Zoom): Next 30%
                -- Tier 2 (Deep-Zoom): Remaining 65%
                (CASE
                    WHEN ABS(HASH(pid) % 100) < 5 THEN 0
                    WHEN ABS(HASH(pid) % 100) < 35 THEN 1
                    ELSE 2
                END)::UTINYINT AS tier_id,

                -- 🛑 CRITICAL: Hilbert Curve Index
                -- This ensures points close in 2D space are close in the file.
                -- This makes fetching a bounding box extremely fast.
                ST_Hilbert(
                    ST_Point(longitude, latitude),
                    {{'min_x': 13.0, 'min_y': 49.0, 'max_x': 16.0, 'max_y': 51.0}}::BOX_2D
                ) AS hilbert_idx,

                -- Physics/Metrics: Compressed to Float32 or SmallInt
                -- Saves ~50% disk space compared to Doubles
                mp_type::UTINYINT AS mp_type,
                height::FLOAT AS height,
                height_wgs84::FLOAT AS height_wgs84,
                line::USMALLINT AS line,
                pixel::USMALLINT AS pixel,
                rmse::FLOAT AS rmse,
                temporal_coherence::FLOAT AS temporal_coherence,
                amplitude_dispersion::FLOAT AS amplitude_dispersion,
                incidence_angle::FLOAT AS incidence_angle,
                track_angle::FLOAT AS track_angle,
                los_east::FLOAT AS los_east,
                los_north::FLOAT AS los_north,
                los_up::FLOAT AS los_up,
                mean_velocity::FLOAT AS mean_velocity,
                mean_velocity_std::FLOAT AS mean_velocity_std,
                acceleration::FLOAT AS acceleration,
                acceleration_std::FLOAT AS acceleration_std,
                seasonality::FLOAT AS seasonality,
                seasonality_std::FLOAT AS seasonality_std,

                -- Time Series Lists
                -- We cast the displacements to Float32 as well
                LIST(STRPTIME(date_str, '%Y%m%d')::DATE) AS dates,
                LIST(displacement::FLOAT) AS displacements

            FROM UnpivotedData
            GROUP BY ALL
        )
        -- 3. Select final columns and SORT by Hilbert Index
        SELECT * EXCLUDE(hilbert_idx) 
        FROM GroupedData
        -- IMPORTANT: We sort by tier_id FIRST, then hilbert_idx.
        -- This ensures Tier 0 points are all together, Tier 1 are all together, etc.
        -- Within each tier, they are spatially sorted (Hilbert).
        ORDER BY tier_id ASC, hilbert_idx ASC
        """

        print(f"2. Writing Optimized Parquet to: {OUTPUT_PARQUET_PATH}")
        print(f"   - Row Group Size: {ROW_GROUP_SIZE}")
        print(f"   - Compression: ZSTD")

        con.execute(f"""
        COPY ({query}) TO '{OUTPUT_PARQUET_PATH}' (
            FORMAT PARQUET,
            ROW_GROUP_SIZE {ROW_GROUP_SIZE},
            COMPRESSION ZSTD
        );
        """)

        print(f"✅ Success! File created.")
        print(f"⏱️  Time taken: {time.time() - start_time:.2f} s")

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"❌ Error: {e}")
    finally:
        con.close()

if __name__ == "__main__":
    generate_data()