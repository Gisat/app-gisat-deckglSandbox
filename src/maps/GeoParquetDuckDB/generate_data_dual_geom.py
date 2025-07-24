# generate_final_data.py
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import json
from shapely.geometry import Point

# --- Configuration ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
OUTPUT_GEOPARQUET_PATH = './be/EGMS_backend_filterable_dual_geom.parquet'
LON_COLUMN_NAME = 'longitude'
LAT_COLUMN_NAME = 'latitude'
CRS_EPSG_CODE = 4326
# --- End Configuration ---

def generate_final_geoparquet(input_csv, output_parquet, lon_col, lat_col, crs):
    """
    Generates the definitive GeoParquet file with a WKB geometry column for filtering
    and a GeoArrow-compatible rendering column for Deck.gl.
    """
    print("--- Starting Final GeoParquet Generation ---")

    # 1. Load data into a standard Pandas DataFrame
    df = pd.read_csv(input_csv)
    df.dropna(subset=[lon_col, lat_col], inplace=True)
    print(f"Loaded {len(df)} valid rows from CSV.")

    # 2. Create geometry columns using basic Python types
    # WKB for DuckDB filtering
    df['geometry'] = [Point(xy).wkb for xy in zip(df[lon_col], df[lat_col])]
    # List of coordinates for Deck.gl rendering
    df['render_coords'] = df[[lon_col, lat_col]].values.tolist()
    print("Created 'geometry' (WKB) and 'render_coords' (list) columns.")

    # 3. Keep only the essential columns for the final file
    df_final = df[['geometry', 'render_coords']]

    # 4. Convert the pure Pandas DataFrame to an Arrow Table
    arrow_table = pa.Table.from_pandas(df_final, preserve_index=False)
    print("Converted DataFrame to Arrow Table.")

    # 5. Add GeoArrow metadata to the 'render_coords' column's schema
    field_idx = arrow_table.schema.get_field_index('render_coords')
    field = arrow_table.schema.field(field_idx)
    geo_field = field.with_metadata({b'ARROW:extension:name': b'geoarrow.point'})
    schema_with_geoarrow = arrow_table.schema.set(field_idx, geo_field)
    print("Prepared schema with GeoArrow point metadata.")

    # 6. Create the top-level GeoParquet metadata
    geo_metadata = {
        "version": "1.0.0", "primary_column": "geometry",
        "columns": {"geometry": {"encoding": "WKB", "crs": f"EPSG:{crs}", "geometry_types": ["Point"]}}
    }
    final_schema = schema_with_geoarrow.with_metadata({b"geo": json.dumps(geo_metadata).encode('utf-8')})
    print("Prepared final schema with top-level GeoParquet metadata.")

    # 7. Re-create the table using the final schema for maximum compatibility
    final_arrow_table = pa.Table.from_arrays(arrow_table.columns, schema=final_schema)
    print("Re-created table with final schema. ✅")

    # 8. Write the final table to a file
    pq.write_table(final_arrow_table, output_parquet, compression='snappy')
    print(f"\nSuccessfully wrote final GeoParquet file to: {output_parquet}")


if __name__ == "__main__":
    generate_final_geoparquet(
        input_csv=INPUT_CSV_PATH,
        output_parquet=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs=CRS_EPSG_CODE
    )
