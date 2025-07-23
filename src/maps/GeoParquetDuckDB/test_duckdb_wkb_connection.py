# test_wkb_connection.py
import duckdb
import os
import sys
import pyarrow.parquet as pq

# --- Configuration ---
# IMPORTANT: Path to your newly generated GeoParquet file with WKB geometry.
FILE_PATH = './be/EGMS_backend_filterable_wkb_geom.parquet'

# Assuming these are the names of your separate LON/LAT columns in the GeoParquet
LON_ATTR_COL = 'longitude'
LAT_ATTR_COL = 'latitude'


print("--- Testing DuckDB Compatibility with WKB Geometry for Filtering ---")
print(f"Attempting to read file: {FILE_PATH}")

# --- Ensure this file exists for the test ---
if not os.path.exists(FILE_PATH):
    print(f"Error: GeoParquet file not found at {FILE_PATH}")
    print("Please ensure you have generated this file using generate_data_wkb_geom.py and it's in the same directory.")
    sys.exit(1)

try:
    # 1. Initialize DuckDB
    con = duckdb.connect(database=':memory:', read_only=False)

    # 2. Load necessary extensions
    LOCAL_EXTENSIONS_DIR = os.path.join(os.path.dirname(__file__), 'duckdb_extensions')

    def load_ext_robust(ext_name):
        try:
            ext_path = os.path.join(LOCAL_EXTENSIONS_DIR, f"{ext_name}.duckdb_extension")
            if os.path.exists(ext_path):
                con.load_extension(ext_path)
                print(f"  Loaded local {ext_name} extension.")
            else:
                con.install_extension(ext_name) # Try installing from network if local not found
                con.load_extension(ext_name)
                print(f"  Installed/Loaded {ext_name} extension from network.")
        except Exception as e:
            print(f"  WARNING: Could not load {ext_name} extension: {e}")

    load_ext_robust("httpfs")
    load_ext_robust("spatial")
    load_ext_robust("arrow") # This one will likely give a warning/error if it's not downloaded
    load_ext_robust("nanoarrow") # This one will likely give a warning/error if not downloaded

    print("DuckDB initialized and essential extensions loaded (or attempted).")

    # 3. Attempt to read the GeoParquet file and register it as a view
    try:
        con.execute(f"CREATE OR REPLACE VIEW large_geo_data_view AS SELECT * FROM '{FILE_PATH}';")

        # Test a simple count query on the registered view
        test_read_query = "SELECT COUNT(*) FROM large_geo_data_view;"
        row_count = con.execute(test_read_query).fetchone()[0]
        print(f"\nSUCCESS: DuckDB can successfully read the file! Total rows: {row_count}")

        # Get and print schema from DuckDB's perspective
        print("DuckDB's inferred schema for 'large_geo_data_view':")
        schema_df = con.execute("DESCRIBE large_geo_data_view;").fetch_df()
        print(schema_df)

        # 4. Attempt a spatial query using ST_Intersects on the 'geometry_wkb' column
        # --- FIX: Removed '4326' from ST_GeomFromText ---
        test_bbox_query = f"""
        SELECT COUNT(*)
        FROM large_geo_data_view
        WHERE ST_Intersects(geometry_wkb, ST_GeomFromText('POLYGON((14.4 50.0, 14.5 50.0, 14.5 50.1, 14.4 50.1, 14.4 50.0))'))
        """
        spatial_count_wkb = con.execute(test_bbox_query).fetchone()[0]
        print(f"\nSUCCESS: Spatial query using ST_Intersects on 'geometry_wkb' worked! Count: {spatial_count_wkb}")

        # 5. Test spatial query using LON/LAT attributes (for filtering without geometry functions)
        test_lon_lat_query = f"""
        SELECT COUNT(*)
        FROM large_geo_data_view
        WHERE {LON_ATTR_COL} >= 14.4 AND {LON_ATTR_COL} <= 14.5 AND {LAT_ATTR_COL} >= 50.0 AND {LAT_ATTR_COL} <= 50.1
        """
        lon_lat_count = con.execute(test_lon_lat_query).fetchone()[0]
        print(f"SUCCESS: Spatial query using '{LON_ATTR_COL}'/'{LAT_ATTR_COL}' attributes worked! Count: {lon_lat_count}")


    except Exception as e:
        print(f"\nCRITICAL ERROR: DuckDB failed to query GeoParquet file (after initial read): {e}")
        print("This indicates a problem with DuckDB's ability to interpret WKB geometry for spatial operations, or missing LON/LAT attributes in the view.")
        sys.exit(1)

except Exception as e:
    print(f"CRITICAL ERROR: DuckDB initialization failed: {e}")
    sys.exit(1)

finally:
    if 'con' in locals() and con:
        con.close()
        print("\nDuckDB connection closed. Test finished.")
    else:
        print("\nDuckDB connection not established. Test finished with errors.")
