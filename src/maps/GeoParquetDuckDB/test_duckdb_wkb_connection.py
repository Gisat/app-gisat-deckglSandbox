# test_wkb_connection.py
import duckdb
import os
import sys

# --- Configuration ---
FILE_PATH = './be/EGMS_backend_filterable_dual_geom.parquet'

print("--- Testing DuckDB Compatibility with WKB and Arrow Geometry ---")
print(f"Attempting to read file: {FILE_PATH}")

if not os.path.exists(FILE_PATH):
    print(f"Error: GeoParquet file not found at {FILE_PATH}")
    sys.exit(1)

con = None
try:
    con = duckdb.connect(database=':memory:', read_only=False)

    # STAGE 1: Load data into a temporary table
    print("\nStage 1: Loading data as a standard table...")
    con.install_extension("httpfs")
    con.load_extension("httpfs")
    con.execute(f"CREATE OR REPLACE TABLE temp_data AS SELECT * FROM read_parquet('{FILE_PATH}');")
    print("  Data loaded into 'temp_data'.")

    # DIAGNOSTIC STEP: Check the actual column names
    print("\nActual table schema for 'temp_data':")
    schema_df = con.execute("DESCRIBE temp_data;").fetch_df()
    print(schema_df)


    # STAGE 2: Load spatial extension and perform query
    print("\nStage 2: Loading spatial extension and running query...")
    con.install_extension("spatial")
    con.load_extension("spatial")
    print("  'spatial' extension loaded.")

    bbox_wkt = 'POLYGON((14.4 50.0, 14.5 50.0, 14.5 50.1, 14.4 50.1, 14.4 50.0))'

    # FIX: Use the correct column name 'geometry' instead of 'geometry_wkb'
    final_query = f"""
    SELECT
        * EXCLUDE (geometry), -- Use the correct WKB column name here
        geometry_arrows
    FROM
        temp_data
    WHERE
        ST_Intersects(
            ST_GeomFromWKB(geometry), -- And use it here as well
            ST_GeomFromText('{bbox_wkt}')
        )
    """

    print("\nExecuting spatial query and fetching Arrow data...")
    result_arrow_table = con.execute(final_query).fetch_arrow_table()

    print(f"\nSUCCESS: Query executed. Fetched {len(result_arrow_table)} rows. ✅")
    print("Schema of the returned data:")
    print(result_arrow_table.schema)

except Exception as e:
    print(f"\nCRITICAL ERROR: The test failed. Reason: {e}")
    sys.exit(1)

finally:
    if con:
        con.close()
        print("\nDuckDB connection closed. Test finished.")
