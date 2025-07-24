import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import numpy as np
import json
import matplotlib.cm as cm # Keep imports for other functions if they use them
import matplotlib.colors as colors
from lonboard._geoarrow.geopandas_interop import geopandas_to_geoarrow


# --- Configuration Variables (Easily changeable) ---
# Path to your input CSV file
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# Path for your output GeoParquet file (changed name for clarity for geometry-only output)
OUTPUT_GEOPARQUET_PATH = './EGMS_L2b_146_0296_IW2_VV_2019_2023_1_lat_lon_filter.parquet'

# Column names for longitude and latitude in your CSV (these will be preserved as attributes)
LON_COLUMN_NAME = 'longitude' # Ensure this matches your CSV's actual LON column name
LAT_COLUMN_NAME = 'latitude' # Ensure this matches your CSV's actual LAT column name
CRS_EPSG_CODE = 4326

# NOTE: COLOR_SOURCE_COLUMN and related chroma settings are for other functions in this file.
# They are not directly used in generate_geoparquet_filterable_backend below.
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


# --- Main Data Generation Logic (Modified to preserve only necessary attributes for backend filtering) ---
def generate_geoparquet_filterable_backend(input_csv_path: str, output_parquet_path: str,
                                          lon_col: str, lat_col: str, crs_epsg: int):
    """
    Generates a GeoParquet file that includes GeoArrow FixedSizeList point geometries
    AND only the specified longitude/latitude attributes for backend filtering.
    """
    print("--- Starting GeoParquet Generation (for Filterable Backend) ---")
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

        # Create GeoDataFrame: This preserves all original df columns as attributes initially.
        gdf = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(x=df[lon_col], y=df[lat_col], crs=crs_epsg))
        print(f"\nCreated GeoDataFrame with {len(gdf)} rows.")
    except KeyError:
        print(f"Error: Columns '{lon_col}' or '{lat_col}' not found in CSV. Aborting.")
        return
    except Exception as e:
        print(f"Error preparing GeoDataFrame: {e}. Aborting.")
        return

    # 3. Convert GeoDataFrame to PyArrow Table via lonboard (preserving all original attributes temporarily)
    print("\n--- Converting GeoDataFrame to PyArrow Table via lonboard (preserving all attributes temporarily) ---")
    try:
        # geopandas_to_geoarrow will convert all columns in gdf and encode geometry.
        # This intermediate table contains ALL original attributes + geometry.
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
    geo_metadata_bytes = json.dumps(geoparquet_file_metadata).encode('utf-8')

    # 5. Create the FINAL PyArrow Table (SELECTING ONLY DESIRED COLUMNS)
    print("\n--- Reconstructing Final PyArrow Table (selecting minimum attributes for filtering) ---")

    reconstructed_column_arrays = []
    reconstructed_fields = []

    # Define the specific columns to select for the final output file
    # This ensures the output file is as small as possible while being filterable.
    columns_to_include_in_output = ['geometry', lon_col, lat_col]

    # Loop through the columns_to_include_in_output and extract them from intermediate_arrow_table
    for field_name in columns_to_include_in_output:
        try:
            field_from_lonboard = intermediate_arrow_table.schema.field(field_name)
            column_from_lonboard = intermediate_arrow_table.column(field_name)

            reconstructed_type = _map_lonboard_type_to_pyarrow_type(field_from_lonboard.type)
            data_to_convert = []
            if isinstance(column_from_lonboard, pa.ChunkedArray):
                for chunk in column_from_lonboard.chunks: data_to_convert.extend(chunk.to_pylist())
            else: data_to_convert = column_from_lonboard.to_pylist()

            reconstructed_array = pa.array(data_to_convert, type=reconstructed_type)

            new_field = pa.field(field_from_lonboard.name, reconstructed_type, nullable=field_from_lonboard.nullable, metadata=field_from_lonboard.metadata)

            reconstructed_fields.append(new_field)
            reconstructed_column_arrays.append(reconstructed_array)
        except KeyError:
            print(f"CRITICAL ERROR: Required column '{field_name}' (LON/LAT or geometry) not found in intermediate table. Aborting.")
            # This should not happen if input CSV and `lon_col`/`lat_col` are correct.
            return # Abort generation if critical column is missing

    final_schema = pa.schema(reconstructed_fields, metadata={b"geo": geo_metadata_bytes})
    final_arrow_table = pa.Table.from_arrays(reconstructed_column_arrays, schema=final_schema)

    print(f"Final PyArrow Table reconstructed. Schema:\n{final_arrow_table.schema}")
    print(f"Number of columns: {final_arrow_table.num_columns}, Rows: {final_arrow_table.num_rows}")
    print(f"--- Output file will contain only: {final_arrow_table.schema.names} ---")

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
    # This will generate the GeoParquet file specifically for the backend to use.
    generate_geoparquet_filterable_backend(
        input_csv_path=INPUT_CSV_PATH,
        output_parquet_path=OUTPUT_GEOPARQUET_PATH, # This will be the filterable backend file
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs_epsg=CRS_EPSG_CODE
    )
