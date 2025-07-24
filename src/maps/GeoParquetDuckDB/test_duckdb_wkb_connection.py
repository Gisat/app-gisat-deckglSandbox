# test_ideal_geoparquet_clean.py
import duckdb
import os
import sys

# --- Configuration ---
FILE_PATH = './be/EGMS_backend_filterable_dual_geom.parquet'
BBOX_WKT = 'POLYGON((14.4 50.0, 14.5 50.0, 14.5 50.1, 14.4 50.1, 14.4 50.0))'
# --- End Configuration ---


def main():
    """
    Main function to run the GeoParquet query test.
    """
    print(f"--- Testing Optimized GeoParquet Query for {os.path.basename(FILE_PATH)} ---")

    if not os.path.exists(FILE_PATH):
        print(f"Error: GeoParquet file not found at {FILE_PATH}")
        sys.exit(1)

    con = None
    try:
        con = duckdb.connect(database=':memory:', read_only=False)
        con.install_extension("spatial")
        con.load_extension("spatial")

        original_count = con.execute(f"SELECT COUNT(*) FROM read_parquet('{FILE_PATH}');").fetchone()[0]
        print(f"\nTotal original rows in file: {original_count:,}")

        final_query = f"""
        SELECT
            * EXCLUDE (geometry)
        FROM
            read_parquet('{FILE_PATH}')
        WHERE
            ST_Intersects(geometry, ST_GeomFromText('{BBOX_WKT}'))
        """

        print("Executing optimized spatial query...")
        result_arrow_table = con.execute(final_query).fetch_arrow_table()
        filtered_count = len(result_arrow_table)

        print(f"\nSUCCESS: Query complete. Filtered rows: {filtered_count:,} ✅")
        print("Schema of the returned data:")
        print(result_arrow_table.schema)

    except Exception as e:
        print(f"\nCRITICAL ERROR: The script failed. Reason: {e}", file=sys.stderr)
        sys.exit(1)

    finally:
        if con:
            con.close()
            print("\nDuckDB connection closed. Script finished.")


if __name__ == "__main__":
    main()
