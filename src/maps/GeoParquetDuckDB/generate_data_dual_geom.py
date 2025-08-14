# generate_data_definitive.py
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

def generate_definitive_geoparquet(input_csv, output_parquet, lon_col, lat_col, crs):
    """
    Generates the definitive GeoParquet file with a WKB geometry column and a
    rendering column with the correct FixedSizeList data type for GeoArrow.
    """
    print("--- Starting Definitive GeoParquet Generation ---")

    # 1. Load data into a standard Pandas DataFrame
    df = pd.read_csv(input_csv)
    df.dropna(subset=[lon_col, lat_col], inplace=True)
    print(f"Loaded {len(df)} valid rows from CSV.")

    # 2. --- THE DEFINITIVE FIX: Create columns with explicit Arrow types ---

    # Create the WKB column (as a pyarrow array of binary type)
    wkb_geometries = [Point(xy).wkb for xy in zip(df[lon_col], df[lat_col])]
    geometry_array = pa.array(wkb_geometries, type=pa.binary())

    # Create the rendering coordinates as a FixedSizeList array
    coords_list = df[[lon_col, lat_col]].values.tolist()
    # Define the specific FixedSizeList type
    list_type = pa.list_(pa.field('coords', pa.float64()), 2)
    # Create the array with the explicit type
    render_coords_array = pa.array(coords_list, type=list_type)

    print("Created 'geometry' and 'render_coords' arrays with correct types. ✅")

    # 3. Build the final Arrow Table from our explicit arrays
    # Create the field for the WKB column (no special metadata needed)
    wkb_field = pa.field('geometry', geometry_array.type)

    # Create the field for the rendering column with full GeoArrow metadata
    geo_column_metadata = {
        b'ARROW:extension:name': b'geoarrow.point',
        b'ARROW:extension:metadata': json.dumps({"crs": f"EPSG:{crs}"}).encode('utf-8')
    }
    geo_render_field = pa.field('render_coords', render_coords_array.type, metadata=geo_column_metadata)

    # 4. Create the top-level GeoParquet metadata
    geoparquet_metadata = {
        "version": "1.0.0", "primary_column": "geometry",
        "columns": {"geometry": {"encoding": "WKB", "crs": f"EPSG:{crs}", "geometry_types": ["Point"]}}
    }

    # Create the final schema
    final_schema = pa.schema([wkb_field, geo_render_field]).with_metadata({b"geo": json.dumps(geoparquet_metadata).encode('utf-8')})

    # Create the final table
    final_arrow_table = pa.Table.from_arrays([geometry_array, render_coords_array], schema=final_schema)
    print("Created final Arrow Table with fully correct schema and data types.")

    # 5. Write the final table to a file
    pq.write_table(final_arrow_table, output_parquet, compression='snappy')
    print(f"\nSuccessfully wrote final GeoParquet file to: {output_parquet}")

if __name__ == "__main__":
    generate_definitive_geoparquet(
        input_csv=INPUT_CSV_PATH,
        output_parquet=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs=CRS_EPSG_CODE
    )
