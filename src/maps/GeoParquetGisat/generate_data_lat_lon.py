import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import numpy as np
import json
import matplotlib.cm as cm
import matplotlib.colors as colors # These imports are not used in this specific 'geom_only' version but kept if you add color.
from lonboard._geoarrow.geopandas_interop import geopandas_to_geoarrow


# --- Configuration Variables (Easily changeable) ---
# Path to your input CSV file
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# Path for your output GeoParquet file (changed name for clarity for geometry-only output)
OUTPUT_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1_geom_only.parquet'
# Column names for longitude and latitude in your CSV
LON_COLUMN_NAME = 'longitude'
LAT_COLUMN_NAME = 'latitude'
# Coordinate Reference System (CRS) for your points (EPSG:4326 is WGS84 for lon/lat)
CRS_EPSG_CODE = 4326

# NOTE: COLOR_SOURCE_COLUMN and related chroma settings are removed from config
# as this script focuses purely on geometry (and no other attributes).
# If you want geometry + color, use the previous script with color_source_col set.
# --- End Configuration Variables ---


# --- Helper Function for Robust PyArrow Type Reconstruction ---
def _map_lonboard_type_to_pyarrow_type(input_type_obj: object) -> pa.DataType:
    """
    Maps an arro3.core._core.DataType object from lonboard or a standard pyarrow.lib.DataType
    to a compatible pyarrow.lib.DataType object.
    """
    if isinstance(input_type_obj, pa.DataType):
        return input_type_obj

    type_str_full = str(input_type_obj)
    inner_type_str = type_str_full
    if '<' in type_str_full and '>' in type_str_full:
        inner_type_str = type_str_full.split('<', 1)[1].rsplit('>', 1)[0].strip()

    if inner_type_str == 'Int64':
        return pa.int64()
    elif inner_type_str == 'Float64':
        return pa.float64()
    elif inner_type_str == 'String' or inner_type_str == 'LargeString':
        return pa.string()
    elif inner_type_str == 'Bool':
        return pa.bool_()

    elif inner_type_str.startswith('FixedSizeList'):
        try:
            child_type_part = inner_type_str.split('data_type: ')[1].split(',')[0].strip()

            child_pa_type = None
            if child_type_part == 'Float64': child_pa_type = pa.float64()
            elif child_type_part == 'Int64': child_pa_type = pa.int64()
            elif child_type_part == 'UInt8': child_pa_type = pa.uint8()
            else:
                print(f"Warning: FixedSizeList child type '{child_type_part}' not explicitly handled in mapping. Falling back to string.")
                child_pa_type = pa.string()

            list_size_part = inner_type_str.split('}, ')[1].split(')')[0].strip()
            list_size = int(list_size_part)

            child_pa_field = pa.field("", child_pa_type, nullable=True)
            return pa.list_(child_pa_field, list_size)
        except Exception as e:
            print(f"Warning: Error parsing FixedSizeList type string '{inner_type_str}': {e}. Falling back to string conversion.")
            return pa.string()

    print(f"Warning: Unhandled arro3.core type: '{inner_type_str}'. Falling back to string conversion.")
    return pa.string()


# --- Main Data Generation Logic ---
def generate_geoparquet_geometry_only(input_csv_path: str, output_parquet_path: str,
                                      lon_col: str, lat_col: str, crs_epsg: int):
    """
    Generates a GeoParquet file containing ONLY the geometry column (FixedSizeList Points).

    Args:
        input_csv_path (str): Path to the input CSV file.
        output_parquet_path (str): Path to save the output GeoParquet file.
        lon_col (str): Name of the longitude column in the CSV.
        lat_col (str): Name of the latitude column in the CSV.
        crs_epsg (int): EPSG code for the coordinate reference system.
    """
    print("--- Starting GeoParquet Generation (Geometry Only) ---")
    print(f"Input CSV: {input_csv_path}")
    print(f"Output GeoParquet: {output_parquet_path}\n")

    # 1. Load DataFrame from CSV
    try:
        df = pd.read_csv(input_csv_path)
        print(f"Successfully loaded CSV with {len(df)} rows.")
    except FileNotFoundError:
        print(f"Error: CSV file not found at {input_csv_path}")
        return
    except Exception as e:
        print(f"Error loading CSV: {e}")
        return

    # 2. Ensure LON and LAT columns are numeric and create GeoPandas GeoDataFrame
    try:
        df[lon_col] = pd.to_numeric(df[lon_col], errors='coerce')
        df[lat_col] = pd.to_numeric(df[lat_col], errors='coerce')
        df.dropna(subset=[lon_col, lat_col], inplace=True)

        if df.empty:
            print("Warning: No valid data rows left after cleaning coordinates. Aborting.")
            return

        gdf = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(x=df[lon_col], y=df[lat_col], crs=crs_epsg))
        print(f"\nCreated GeoDataFrame with {len(gdf)} rows.")
    except KeyError:
        print(f"Error: Columns '{lon_col}' or '{lat_col}' not found in CSV. Aborting.")
        return
    except Exception as e:
        print(f"Error preparing GeoDataFrame: {e}. Aborting.")
        return

    # 3. Convert GeoDataFrame to PyArrow Table via lonboard (only to get geometry column)
    print("\n--- Extracting geometry from GeoDataFrame via lonboard ---")
    try:
        # lonboard is used here primarily to get the geometry column correctly encoded as GeoArrow.
        # Other attributes will be implicitly included in this intermediate table, but filtered below.
        intermediate_arrow_table = geopandas_to_geoarrow(gdf, preserve_index=False)
        print(f"Intermediate PyArrow Table (from lonboard) schema:\n{intermediate_arrow_table.schema}")

        geometry_field_lonboard = intermediate_arrow_table.schema.field('geometry')
        print(f"Lonboard-generated geometry type: {geometry_field_lonboard.type}")

        reconstructed_geom_type_check = _map_lonboard_type_to_pyarrow_type(geometry_field_lonboard.type)
        expected_geom_type = pa.list_(pa.field("", pa.float64()), 2)

        if reconstructed_geom_type_check.equals(expected_geom_type):
            print("Verification: Geometry column is a FixedSizeList of size 2. This is correct for Deck.gl!")
        else:
            print(f"Warning: Geometry column is NOT a FixedSizeList of size 2. Reconstructed type: {reconstructed_geom_type_check}. Expected: {expected_geom_type}")
            print("Please ensure lonboard and pyarrow versions are compatible if this is unexpected.")

    except Exception as e:
        print(f"Error during lonboard conversion: {e}. Aborting.")
        return

    # 4. Prepare GeoParquet File-Level Metadata
    print("\n--- Preparing GeoParquet File-Level Metadata ---")
    bbox_df = gdf.geometry.bounds
    calculated_bbox = [
        bbox_df['minx'].min(), bbox_df['miny'].min(),
        bbox_df['maxx'].max(), bbox_df['maxy'].max()
    ]
    print(f"Calculated bounding box: {calculated_bbox}")

    geoparquet_file_metadata = {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "GEOARROW",
                "crs": f"EPSG:{crs_epsg}",
                "bbox": calculated_bbox,
                "geometry_types": ["Point"]
            }
        }
    }
    # No 'colors' metadata needed as we are not including the color column
    geo_metadata_bytes = json.dumps(geoparquet_file_metadata).encode('utf-8')

    # 5. Create the FINAL PyArrow Table with ONLY geometry column and reconstructed schema/metadata
    print("\n--- Selecting ONLY geometry for final table reconstruction ---")

    # Get the geometry column from the intermediate table
    geom_column_from_lonboard = intermediate_arrow_table.column('geometry')
    geom_field_from_lonboard = intermediate_arrow_table.schema.field('geometry')

    reconstructed_column_arrays = []
    reconstructed_fields = []

    # Reconstruct Geometry Column Array and Field
    reconstructed_geom_type = _map_lonboard_type_to_pyarrow_type(geom_field_from_lonboard.type)

    data_to_convert_geom = []
    if isinstance(geom_column_from_lonboard, pa.ChunkedArray):
        for chunk in geom_column_from_lonboard.chunks:
            data_to_convert_geom.extend(chunk.to_pylist())
    else:
        data_to_convert_geom = geom_column_from_lonboard.to_pylist()

    reconstructed_geom_array = pa.array(data_to_convert_geom, type=reconstructed_geom_type)

    new_geom_field = pa.field(
        geom_field_from_lonboard.name,
        reconstructed_geom_type,
        nullable=geom_field_from_lonboard.nullable,
        metadata=geom_field_from_lonboard.metadata
    )
    reconstructed_fields.append(new_geom_field)
    reconstructed_column_arrays.append(reconstructed_geom_array)

    print("Only 'geometry' column selected for final GeoParquet.")


    # Create the final pyarrow.Schema object with reconstructed fields and file-level metadata
    final_schema = pa.schema(reconstructed_fields, metadata={b"geo": geo_metadata_bytes})

    # Create the final PyArrow Table
    final_arrow_table = pa.Table.from_arrays(reconstructed_column_arrays, schema=final_schema)
    print(f"Final PyArrow Table successfully reconstructed. Schema (geometry only):\n{final_arrow_table.schema}")
    print(f"Number of columns: {final_arrow_table.num_columns}, Rows: {final_arrow_table.num_rows}")

    # 6. Write the Final PyArrow Table to GeoParquet File
    print("\n--- Writing GeoParquet File ---")
    try:
        pq.write_table(final_arrow_table, output_parquet_path, compression='snappy')
        print(f"Successfully wrote GeoParquet to: {output_parquet_path}")
        print("\n--- Script Finished ---")
    except Exception as e:
        print(f"Error writing Parquet file: {e}. Aborting.")
        return


# --- Execute the script ---
if __name__ == "__main__":
    # This example will generate a GeoParquet file with only the geometry column.
    print("\n--- Generating GeoParquet: Geometry Only ---")
    generate_geoparquet_geometry_only(
        input_csv_path=INPUT_CSV_PATH,
        output_parquet_path=OUTPUT_GEOPARQUET_PATH, # This is testMK_geom_only.parquet
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs_epsg=CRS_EPSG_CODE
    )
