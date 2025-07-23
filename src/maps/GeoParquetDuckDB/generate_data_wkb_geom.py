# generate_data_wkb_geom.py
import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import numpy as np
import json
# No need for matplotlib or lonboard imports here as we're only generating WKB/attributes
# import matplotlib.cm as cm
# import matplotlib.colors as colors
# from lonboard._geoarrow.geopandas_interop import geopandas_to_geoarrow


# --- Configuration Variables (Easily changeable) ---
# Path to your input CSV file
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# NEW OUTPUT PATH for the WKB-only file (this will be the backend's source)
OUTPUT_GEOPARQUET_PATH = './be/EGMS_backend_filterable_wkb_geom.parquet'

# Column names for longitude and latitude in your CSV (these will be preserved as attributes)
LON_COLUMN_NAME = 'longitude' # Ensure this matches your CSV's actual LON column name
LAT_COLUMN_NAME = 'latitude' # Ensure this matches your CSV's actual LAT column name
CRS_EPSG_CODE = 4326

# --- End Configuration Variables ---


# --- Helper Function for PyArrow Type Reconstruction (Simplified for WKB output) ---
# This helper is simplified as we are targeting specific simple types for WKB output.
def _map_simple_type_to_pyarrow_type(input_type_obj: object) -> pa.DataType:
    """
    Maps a Python/Pandas dtype or a simple PyArrow DataType object to a compatible
    pyarrow.lib.DataType object.
    """
    if isinstance(input_type_obj, pa.DataType):
        return input_type_obj

    # Handle common pandas dtypes
    if pd.api.types.is_integer_dtype(input_type_obj):
        return pa.int64()
    elif pd.api.types.is_float_dtype(input_type_obj):
        return pa.float64()
    elif pd.api.types.is_string_dtype(input_type_obj) or pd.api.types.is_object_dtype(input_type_obj):
        return pa.string()
    elif pd.api.types.is_bool_dtype(input_type_obj):
        return pa.bool_()
    elif pd.api.types.is_datetime64_any_dtype(input_type_obj):
        return pa.timestamp('ms') # Or 'us', 'ns' depending on precision needed
    elif pd.api.types.is_timedelta64_dtype(input_type_obj):
        return pa.duration('ms') # Or 'us', 'ns'
    elif isinstance(input_type_obj, np.dtype): # Handle numpy dtypes directly
        if input_type_obj == np.int64: return pa.int64()
        if input_type_obj == np.float64: return pa.float64()
        if input_type_obj == np.bool_: return pa.bool_()
        if input_type_obj == np.object_: return pa.string() # Fallback for object dtype

    print(f"Warning: Unhandled input type '{input_type_obj}'. Falling back to string conversion.")
    return pa.string()


# --- Main Data Generation Logic (Modified to produce a WKB-only file for backend filtering) ---
def generate_geoparquet_wkb_geom(input_csv_path: str, output_parquet_path: str,
                                 lon_col: str, lat_col: str, crs_epsg: int):
    """
    Generates a GeoParquet file that includes ONLY WKB geometry and specified longitude/latitude attributes
    for backend filtering (to avoid GeoArrow FixedSizeList incompatibility in DuckDB).
    """
    print("--- Starting GeoParquet Generation (WKB Geometry Only) ---")
    print(f"Input CSV: {input_csv_path}")
    print(f"Output GeoParquet: {output_parquet_path}\n")

    # 1. Load DataFrame from CSV
    try:
        df = pd.read_csv(input_csv_path)
        print(f"Successfully loaded CSV with {len(df)} rows.")
    except FileNotFoundError: print(f"Error: CSV file not found at {input_csv_path}"); return
    except Exception as e: print(f"Error loading CSV: {e}"); return

    # 2. Ensure LON and LAT columns are numeric and create GeoPandas GeoDataFrame
    try:
        df[lon_col] = pd.to_numeric(df[lon_col], errors='coerce')
        df[lat_col] = pd.to_numeric(df[lat_col], errors='coerce')
        df.dropna(subset=[lon_col, lat_col], inplace=True)
        if df.empty: print("Warning: No valid data rows left. Aborting."); return

        # Create GeoDataFrame: This preserves all original df columns as attributes.
        gdf = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(x=df[lon_col], y=df[lat_col], crs=crs_epsg))
        print(f"\nCreated GeoDataFrame with {len(gdf)} rows.")
    except KeyError: print(f"Error: Columns '{lon_col}' or '{lat_col}' not found in CSV. Aborting."); return
    except Exception as e: print(f"Error preparing GeoDataFrame: {e}. Aborting."); return

    # --- NEW: Create the WKB geometry column directly ---
    gdf['geometry_wkb'] = gdf.geometry.to_wkb()
    print("Created 'geometry_wkb' column.")

    # 3. Create the FINAL PyArrow Table (selecting ONLY WKB, LON, LAT attributes)
    print("\n--- Reconstructing Final PyArrow Table (WKB only + attributes) ---")

    reconstructed_column_arrays = []
    reconstructed_fields = []

    # Define the specific columns to include in the final output file for the backend.
    # This ensures the output file is as small as possible while being filterable.
    # We select 'geometry_wkb', and the original 'longitude' and 'latitude' columns.
    columns_to_include_in_output = ['geometry_wkb', lon_col, lat_col]

    # Loop through the desired columns and extract them from gdf, converting to PyArrow arrays
    for col_name in columns_to_include_in_output:
        try:
            # Extract data from GeoDataFrame column
            data_values = gdf[col_name].values

            # Determine PyArrow type using the helper function
            # For 'geometry_wkb', it's binary. For lon/lat, it's float.
            if col_name == 'geometry_wkb':
                reconstructed_type = pa.binary()
            else:
                reconstructed_type = _map_simple_type_to_pyarrow_type(gdf[col_name].dtype)

            # Create the new pyarrow.lib.Array
            reconstructed_array = pa.array(data_values, type=reconstructed_type, from_pandas=False) # from_pandas=False to avoid inference issues


            # Create the new pyarrow.lib.Field
            new_field = pa.field(col_name, reconstructed_type, nullable=True) # Assume nullable

            reconstructed_fields.append(new_field)
            reconstructed_column_arrays.append(reconstructed_array)
        except KeyError:
            print(f"CRITICAL ERROR: Required column '{col_name}' not found in GeoDataFrame. Aborting generation.")
            return # Abort generation if critical column is missing

    # 4. Prepare GeoParquet File-Level Metadata
    print("\n--- Preparing GeoParquet File-Level Metadata ---")
    bbox_df = gdf.geometry.bounds
    calculated_bbox = [
        bbox_df['minx'].min(), bbox_df['miny'].min(),
        bbox_df['maxx'].max(), bbox_df['maxy'].max()
    ]

    geoparquet_file_metadata = {
        "version": "1.0.0", # WKB is standard in GeoParquet 1.0.0
        "primary_column": "geometry_wkb", # Set primary to WKB for DuckDB/GDAL compatibility
        "columns": {
            "geometry_wkb": { # Metadata for WKB geometry
                "encoding": "WKB",
                "crs": f"EPSG:{crs_epsg}",
                "bbox": calculated_bbox,
                "geometry_types": ["Point"]
            },
        }
    }
    geo_metadata_bytes = json.dumps(geoparquet_file_metadata).encode('utf-8')

    final_schema = pa.schema(reconstructed_fields, metadata={b"geo": geo_metadata_bytes})
    final_arrow_table = pa.Table.from_arrays(reconstructed_column_arrays, schema=final_schema)

    print(f"Final PyArrow Table reconstructed. Schema:\n{final_arrow_table.schema}")
    print(f"Number of columns: {final_arrow_table.num_columns}, Rows: {final_arrow_table.num_rows}")
    print(f"--- Output file will contain columns: {final_arrow_table.schema.names} ---")


    # 5. Write the Final PyArrow Table to GeoParquet File
    print("\n--- Writing GeoParquet File ---")
    try:
        pq.write_table(final_arrow_table, output_parquet_path, compression='snappy')
        print(f"Successfully wrote GeoParquet to: {output_parquet_path}")
        print("\n--- Script Finished ---")
    except Exception as e: print(f"Error writing Parquet file: {e}. Aborting."); return


# --- Execute the script ---
if __name__ == "__main__":
    # This will generate the GeoParquet file with WKB geometry and specified attributes.
    generate_geoparquet_wkb_geom(
        input_csv_path=INPUT_CSV_PATH,
        output_parquet_path=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs_epsg=CRS_EPSG_CODE
    )
