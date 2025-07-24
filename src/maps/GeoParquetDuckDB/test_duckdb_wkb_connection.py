# final_script_with_counts.py
import duckdb
import os
import sys

# --- Configuration ---
FILE_PATH = './be/EGMS_backend_filterable_dual_geom.parquet'

print("--- Running Final GeoParquet Query Script ---")

if not os.path.exists(FILE_PATH):
    print(f"Error: GeoParquet file not found at {FILE_PATH}")
    sys.exit(1)

con = None
try:
    con = duckdb.connect(database=':memory:', read_only=False)

    # Stage 1: Load data into a temp table
    con.execute(f"CREATE OR REPLACE TABLE temp_data AS SELECT * FROM read_parquet('{FILE_PATH}');")

    # --- ADDED: Get and print the original row count ---
    original_count = con.execute("SELECT COUNT(*) FROM temp_data;").fetchone()[0]
    print(f"\nTotal original rows in file: {original_count:,}")
    # ----------------------------------------------------

    # Stage 2: Load the spatial extension
    con.install_extension("spatial")
    con.load_extension("spatial")

    # Define the bounding box for the spatial filter
    bbox_wkt = 'POLYGON((14.4 50.0, 14.5 50.0, 14.5 50.1, 14.4 50.1, 14.4 50.0))'

    # Final, cleaned query
    final_query = f"""
    SELECT
        * EXCLUDE (geometry)
    FROM
        temp_data
    WHERE
        ST_Intersects(
            ST_GeomFromWKB(geometry),
            ST_GeomFromText('{bbox_wkt}')
        )
    """

    print("Executing spatial query and fetching results...")

    result_arrow_table = con.execute(final_query).fetch_arrow_table()
    filtered_count = len(result_arrow_table)

    print(f"\nSUCCESS: Query complete. Filtered rows: {filtered_count:,} ✅")
    print("Schema of returned data:")
    print(result_arrow_table.schema)

except Exception as e:
    print(f"\nCRITICAL ERROR: The script failed. Reason: {e}")
    sys.exit(1)

finally:
    if con:
        con.close()
        print("\nDuckDB connection closed. Script finished.")
