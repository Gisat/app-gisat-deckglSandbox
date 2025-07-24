# generate_data_dual_geom.py
import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import numpy as np
import json
import matplotlib.cm as cm
import matplotlib.colors as colors
from lonboard._geoarrow.geopandas_interop import geopandas_to_geoarrow


# --- Configuration Variables (Easily changeable) ---
# Path to your input CSV file
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
# NEW OUTPUT PATH for the dual geometry file (this will be the backend's source)
OUTPUT_GEOPARQUET_PATH = './be/EGMS_backend_filterable_dual_geom.parquet'

# Column names for longitude and latitude in your CSV (these will be preserved as attributes)
LON_COLUMN_NAME = 'longitude' # Ensure this matches your CSV's actual LON column name
LAT_COLUMN_NAME = 'latitude' # Ensure this matches your CSV's actual LAT column name
CRS_EPSG_CODE = 4326

# --- End Configuration Variables ---


# --- Helper Function for Robust PyArrow Type Reconstruction ---
def _map_lonboard_type_to_pyarrow_type(input_type_obj: object) -> pa.DataType:
    if isinstance(input_type_obj, pa.DataType): return input_type_obj
    type_str_full = str(input_type_obj)
    inner_type_str = type_str_full
    if '<' in type_str_full and '>' in type_str_full: inner_type_str = type_str_full.split('<', 1)[1].rsplit('>', 1)[0].strip()

    if inner_type_str == 'Int64':
        return pa.int64()
    elif inner_type_str == 'Float64':
        return pa.float64()
    elif inner_type_str == 'String' or inner_type_str == 'LargeString':
        return pa.string()
    elif inner_type_str == 'Binary' or inner_type_str == 'LargeBinary': return pa.binary()
    elif inner_type_str == 'Bool':
        return pa.bool_()

    elif inner_type_str.startswith('FixedSizeList'):
        try:
            child_type_part = inner_type_str.split('data_type: ')[1].split(',')[0].strip()

            child_pa_type = None
            if child_type_part == 'Float64': child_pa_type = pa.float64()
            elif child_type_part == 'Int64': child_pa_type = pa.int64()
            elif child_type_part == 'UInt8': child_pa_type = pa.uint8()
            else: print(f"Warning: FixedSizeList child type '{child_type_part}' not explicitly handled in mapping. Falling back to string."); child_pa_type = pa.string()

            list_size_part = inner_type_str.split('}, ')[1].split(')')[0].strip()
            list_size = int(list_size_part)

            child_pa_field = pa.field("", child_pa_type, nullable=True)
            return pa.list_(child_pa_field, list_size)
        except Exception as e:
            print(f"Warning: Error parsing FixedSizeList type string '{inner_type_str}': {e}. Falling back to string conversion.")
            return pa.string()

    print(f"Warning: Unhandled arro3.core type: '{inner_type_str}'. Falling back to string conversion.")
    return pa.string()


# --- Main Data Generation Logic (Modified to produce a file with two geometry columns) ---
def generate_geoparquet_dual_geometry(input_csv_path: str, output_parquet_path: str,
                                      lon_col: str, lat_col: str, crs_epsg: int):
    """
    Generates a GeoParquet file that includes:
    1. 'geometry' (WKB, for DuckDB filtering)
    2. 'geometry_arrows' (GeoArrow FixedSizeList, for Deck.gl)
    3. Specified longitude/latitude attributes (for pyarrow.dataset filtering).
    """
    print("--- Starting GeoParquet Generation (Dual Geometry - Specific Naming) ---")
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

    # --- Step A: Create the WKB geometry column (named 'geometry_wkb' initially) ---
    gdf['geometry_wkb'] = gdf.geometry.to_wkb()
    print("Created 'geometry_wkb' column.")

    # 3. Convert GeoDataFrame to PyArrow Table via lonboard (for 'geometry' as GeoArrow FixedSizeList)
    print("\n--- Extracting GeoArrow FixedSizeList via lonboard (for 'geometry_arrows') ---")
    try:
        # geopandas_to_geoarrow processes the primary 'geometry' column (from gdf) into GeoArrow FixedSizeList.
        # It will also convert other attributes to PyArrow arrays, including 'geometry_wkb' we just made.
        intermediate_arrow_table = geopandas_to_geoarrow(gdf, preserve_index=False)
        print(f"Intermediate PyArrow Table (from lonboard) schema:\n{intermediate_arrow_table.schema}")

        # Verification for the column that *will become* 'geometry_arrows'
        geometry_field_lonboard = intermediate_arrow_table.schema.field('geometry') # This is still named 'geometry' here
        reconstructed_geom_type_check = _map_lonboard_type_to_pyarrow_type(geometry_field_lonboard.type)
        expected_geom_type = pa.list_(pa.field("", pa.float64()), 2)
        if reconstructed_geom_type_check.equals(expected_geom_type): print("Verification: Geometry column (for GeoArrow) is a FixedSizeList of size 2. Correct!")
        else: print(f"Warning: Geometry column (for GeoArrow) is NOT FixedSizeList. Reconstructed: {reconstructed_geom_type_check}. Expected: {expected_geom_type}")
    except Exception as e: print(f"Error during lonboard conversion for geometry: {e}. Aborting."); return

    # 4. Prepare GeoParquet File-Level Metadata
    print("\n--- Preparing GeoParquet File-Level Metadata ---")
    bbox_df = gdf.geometry.bounds
    calculated_bbox = [
        bbox_df['minx'].min(), bbox_df['miny'].min(),
        bbox_df['maxx'].max(), bbox_df['maxy'].max()
    ]
    geoparquet_file_metadata = {
        "version": "1.1.0",
        "primary_column": "geometry", # <-- NEW: Primary is the WKB column ('geometry') for DuckDB/GDAL
        "columns": {
            "geometry": { # <-- NEW: This entry is now for the WKB geometry
                "encoding": "WKB",
                "crs": f"EPSG:{crs_epsg}",
                "bbox": calculated_bbox,
                "geometry_types": ["Point"]
            },
            "geometry_arrows": { # <-- NEW: This entry is for the GeoArrow FixedSizeList geometry
                "encoding": "GEOARROW", # GeoArrow FixedSizeList
                "crs": f"EPSG:{crs_epsg}",
                "bbox": calculated_bbox,
                "geometry_types": ["Point"]
            }
        }
    }
    geo_metadata_bytes = json.dumps(geoparquet_file_metadata).encode('utf-8')

    # 5. Create the FINAL PyArrow Table (SELECTING ONLY DESIRED COLUMNS with exact names)
    print("\n--- Reconstructing Final PyArrow Table (Dual Geometry - Final Column Selection) ---")

    reconstructed_column_arrays = []
    reconstructed_fields = []

    # Define the specific columns to select and their desired final names/sources.
    # Order matters here if you have a specific order preference.
    columns_config = [
        {'source_name': 'geometry_wkb', 'final_name': 'geometry', 'is_geometry': True, 'encoding': 'WKB'}, # For DuckDB
        {'source_name': 'geometry', 'final_name': 'geometry_arrows', 'is_geometry': True, 'encoding': 'GEOARROW'}, # For Deck.gl
        {'source_name': lon_col, 'final_name': lon_col, 'is_geometry': False},
        {'source_name': lat_col, 'final_name': lat_col, 'is_geometry': False},
        # Add other attributes here if you want to include them, e.g.,
        # {'source_name': 'ID_CELL', 'final_name': 'ID_CELL', 'is_geometry': False},
        # {'source_name': 'VEL_LA_UP', 'final_name': 'VEL_LA_UP', 'is_geometry': False},
        # {'source_name': 'VEL_LA_EW', 'final_name': 'VEL_LA_EW', 'is_geometry': False},
        # {'source_name': 'SVEL_LA_UP', 'final_name': 'SVEL_LA_UP', 'is_geometry': False},
        # {'source_name': 'SVEL_LA_EW', 'final_name': 'SVEL_LA_EW', 'is_geometry': False},
        # {'source_name': 'AZ_ANG', 'final_name': 'AZ_ANG', 'is_geometry': False},
    ]

    for col_cfg in columns_config:
        try:
            field_from_lonboard = intermediate_arrow_table.schema.field(col_cfg['source_name'])
            column_from_lonboard = intermediate_arrow_table.column(col_cfg['source_name'])

            # Reconstruct Data Type based on its original type and final encoding goal
            if col_cfg['is_geometry'] and col_cfg['encoding'] == 'GEOARROW':
                # Reconstruct FixedSizeList as GeoArrow
                reconstructed_type = _map_lonboard_type_to_pyarrow_type(field_from_lonboard.type)
            elif col_cfg['is_geometry'] and col_cfg['encoding'] == 'WKB':
                reconstructed_type = pa.binary() # Ensure WKB is treated as binary
            else:
                reconstructed_type = _map_lonboard_type_to_pyarrow_type(field_from_lonboard.type) # For attributes

            data_to_convert = []
            if isinstance(column_from_lonboard, pa.ChunkedArray):
                for chunk in column_from_lonboard.chunks: data_to_convert.extend(chunk.to_pylist())
            else: data_to_convert = column_from_lonboard.to_pylist()

            reconstructed_array = pa.array(data_to_convert, type=reconstructed_type)

            # Create new field with the FINAL desired name and metadata
            new_field_metadata = field_from_lonboard.metadata # Preserve original metadata
            if col_cfg['is_geometry']: # Add/override GeoArrow/WKB specific metadata if it's a geometry column
                if col_cfg['encoding'] == 'GEOARROW':
                    new_field_metadata = {
                        **new_field_metadata,
                        b'ARROW:extension:name': b'geoarrow.point',
                        b'ARROW:extension:metadata': json.dumps({"crs": {"type": "name", "properties": {"name": f"EPSG:{crs_epsg}"}}}).encode('utf-8')
                    }
                elif col_cfg['encoding'] == 'WKB':
                    new_field_metadata = {
                        **new_field_metadata,
                        b'ARROW:extension:name': b'geoarrow.wkb', # This is not strictly needed for WKB, but for consistency.
                        b'ARROW:extension:metadata': json.dumps({"crs": {"type": "name", "properties": {"name": f"EPSG:{crs_epsg}"}}}).encode('utf-8')
                    }


            new_field = pa.field(
                col_cfg['final_name'], # Use the FINAL desired name
                reconstructed_type,
                nullable=field_from_lonboard.nullable,
                metadata=new_field_metadata
            )

            reconstructed_fields.append(new_field)
            reconstructed_column_arrays.append(reconstructed_array)

        except KeyError:
            print(f"CRITICAL ERROR: Required source column '{col_cfg['source_name']}' not found in intermediate table. Aborting generation.")
            return # Abort generation if critical source column is missing

    final_schema = pa.schema(reconstructed_fields, metadata={b"geo": geo_metadata_bytes})
    final_arrow_table = pa.Table.from_arrays(reconstructed_column_arrays, schema=final_schema)

    print(f"Final PyArrow Table reconstructed. Schema:\n{final_arrow_table.schema}")
    print(f"Number of columns: {final_arrow_table.num_columns}, Rows: {final_arrow_table.num_rows}")
    print(f"--- Output file will contain columns: {final_arrow_table.schema.names} ---")


    # 6. Write the Final PyArrow Table to GeoParquet File
    print("\n--- Writing GeoParquet File ---")
    try:
        pq.write_table(final_arrow_table, output_parquet_path, compression='snappy')
        print(f"Successfully wrote GeoParquet to: {output_parquet_path}")
        print("\n--- Script Finished ---")
    except Exception as e: print(f"Error writing Parquet file: {e}. Aborting."); return


# --- Execute the script ---
if __name__ == "__main__":
    # This will generate the GeoParquet file with dual geometry and specified attributes.
    generate_geoparquet_dual_geometry(
        input_csv_path=INPUT_CSV_PATH,
        output_parquet_path=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs_epsg=CRS_EPSG_CODE
    )
