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
INPUT_CSV_PATH = '/Users/marianakecova/Library/CloudStorage/GoogleDrive-mariana.kecova@gisat.cz/Sdílené disky/Projects/Metro D1 GST-30/DATA/results_e5/sipky/compo_area_vellast_sipky.csv'
OUTPUT_GEOPARQUET_PATH = '/Users/marianakecova/Library/CloudStorage/GoogleDrive-mariana.kecova@gisat.cz/Sdílené disky/Projects/Metro D1 GST-30/DATA/results_e5/sipky/compo_area_vellast_sipky_MK_colors.parquet' # Changed output name for clarity

LON_COLUMN_NAME = 'LON_CENTER'
LAT_COLUMN_NAME = 'LAT_CENTER'
CRS_EPSG_CODE = 4326

# --- Color Precomputation Settings ---
COLOR_SOURCE_COLUMN = 'VEL_LA_EW' # Example: using VEL_LA_EW for color
CHROMA_COLORS_HEX = [
    '#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000',
    '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'
]
CHROMA_DOMAIN = [-2, 2]
# --- End Configuration Variables ---


# --- Helper Function for Robust PyArrow Type Reconstruction ---
def _map_lonboard_type_to_pyarrow_type(input_type_obj: object) -> pa.DataType:
    """
    Maps an arro3.core._core.DataType object from lonboard or a standard pyarrow.lib.DataType
    to a compatible pyarrow.lib.DataType object.
    Handles compatibility issues by parsing string representations if necessary.
    """
    # If the object is already a pyarrow.lib.DataType, return it directly.
    # This covers types for columns we added (like 'colors') or correctly converted earlier.
    if isinstance(input_type_obj, pa.DataType):
        return input_type_obj

    # Otherwise, assume it's an arro3.core._core.DataType and parse its string representation
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
            if child_type_part == 'Float64':
                child_pa_type = pa.float64()
            elif child_type_part == 'Int64':
                child_pa_type = pa.int64()
            elif child_type_part == 'UInt8': # Add explicit handling for UInt8 as child of FixedSizeList (for colors)
                child_pa_type = pa.uint8()
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
def generate_geoparquet(input_csv_path: str, output_parquet_path: str,
                        lon_col: str, lat_col: str, crs_epsg: int,
                        color_source_col: str = None,
                        chroma_colors_hex: list = None, chroma_domain: list = None):

    print("--- Starting Data Processing ---")

    # 1. Load DataFrame from CSV
    try:
        df = pd.read_csv(input_csv_path)
        print(f"Successfully loaded CSV with {len(df)} rows.")
        print("DataFrame columns:", df.columns.tolist())
        print("DataFrame head:\n", df.head())
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
        print("GeoDataFrame geometry column type:", gdf.geometry.geom_type.unique())

    except KeyError:
        print(f"Error: Columns '{lon_col}' or '{lat_col}' not found in CSV. Aborting.")
        return
    except Exception as e:
        print(f"Error preparing GeoDataFrame: {e}. Aborting.")
        return

    # 3. Pre-calculate Colors and create PyArrow Array
    precomputed_color_array = None
    if color_source_col and chroma_colors_hex and chroma_domain:
        print(f"\n--- Pre-calculating colors based on '{color_source_col}' using Chroma.js-like scale ---")
        if color_source_col not in gdf.columns:
            print(f"Error: Color source column '{color_source_col}' not found. Skipping color calculation.")
        else:
            cmap = colors.LinearSegmentedColormap.from_list("my_chroma_cmap", chroma_colors_hex)
            norm = colors.Normalize(vmin=chroma_domain[0], vmax=chroma_domain[1])
            scalar_mappable = cm.ScalarMappable(norm=norm, cmap=cmap)
            rgba_float_colors = scalar_mappable.to_rgba(gdf[color_source_col].values)
            colors_np_array = (rgba_float_colors * 255).astype(np.uint8).flatten('C')

            precomputed_color_array = pa.FixedSizeListArray.from_arrays(
                values=pa.array(colors_np_array, type=pa.uint8()),
                type=pa.list_(pa.field('rgba', pa.uint8()), 4),
            )
            print(f"Pre-calculated colors created as PyArrow FixedSizeListArray.")
    else:
        print("\n--- Skipping pre-calculation of colors. ---")


    # 4. Convert GeoDataFrame to PyArrow Table via lonboard and prepare for final reconstruction
    print("\n--- Converting GeoDataFrame to PyArrow Table via lonboard ---")
    try:
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

    # 5. Prepare all columns and fields for the final PyArrow Table construction
    all_columns_for_final_table = [intermediate_arrow_table.column(i) for i in range(intermediate_arrow_table.num_columns)]
    all_fields_for_final_schema = [intermediate_arrow_table.schema.field(i) for i in range(intermediate_arrow_table.num_columns)]

    if precomputed_color_array is not None:
        all_columns_for_final_table.append(precomputed_color_array)
        color_field_metadata = {b"color_encoding": b"RGBA_UINT8"}
        color_field = pa.field('colors', pa.list_(pa.field('rgba', pa.uint8()), 4), metadata=color_field_metadata)
        all_fields_for_final_schema.append(color_field)
        print("Pre-calculated 'colors' column appended to final table source.")


    # 6. Prepare GeoParquet File-Level Metadata
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
    if precomputed_color_array is not None:
        geoparquet_file_metadata["columns"]["colors"] = {
            "encoding": "FIXED_SIZE_LIST",
            "description": f"RGBA color derived from {color_source_col}",
            "parts": 4,
            "type": "UINT8"
        }

    geo_metadata_bytes = json.dumps(geoparquet_file_metadata).encode('utf-8')

    # 7. Create the FINAL PyArrow Table with fully reconstructed schema and metadata
    print("\n--- Reconstructing Final PyArrow Table for Compatibility ---")
    reconstructed_column_arrays = []
    reconstructed_fields = []

    for i in range(len(all_fields_for_final_schema)):
        field_from_source = all_fields_for_final_schema[i]
        column_from_source = all_columns_for_final_table[i]

        # Reconstruct Data Type using the helper function
        reconstructed_type = _map_lonboard_type_to_pyarrow_type(field_from_source.type)

        # Extract raw Python data from column for safe conversion to pyarrow.lib.Array
        data_to_convert = []
        if isinstance(column_from_source, pa.ChunkedArray):
            for chunk in column_from_source.chunks:
                data_to_convert.extend(chunk.to_pylist())
        else: # It's a simple Array (not ChunkedArray)
            data_to_convert = column_from_source.to_pylist()

        # Create the new pyarrow.lib.Array from Python list and reconstructed type
        reconstructed_array = pa.array(data_to_convert, type=reconstructed_type)

        # Create the new pyarrow.lib.Field
        new_field = pa.field(
            field_from_source.name,
            reconstructed_type,
            nullable=field_from_source.nullable,
            metadata=field_from_source.metadata
        )

        reconstructed_fields.append(new_field)
        reconstructed_column_arrays.append(reconstructed_array)


    # Create the final pyarrow.Schema object with reconstructed fields and file-level metadata
    final_schema = pa.schema(reconstructed_fields, metadata={b"geo": geo_metadata_bytes})

    # Create the final PyArrow Table by passing the reconstructed column arrays and the new, compatible schema
    final_arrow_table = pa.Table.from_arrays(reconstructed_column_arrays, schema=final_schema)
    print(f"Final PyArrow Table successfully reconstructed. Schema:\n{final_arrow_table.schema}")
    print(f"Number of columns: {final_arrow_table.num_columns}, Rows: {final_arrow_table.num_rows}")

    # 8. Write the Final PyArrow Table to GeoParquet File
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
    generate_geoparquet(
        input_csv_path=INPUT_CSV_PATH,
        output_parquet_path=OUTPUT_GEOPARQUET_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs_epsg=CRS_EPSG_CODE,
        color_source_col=COLOR_SOURCE_COLUMN, # Pass the color source column name
        chroma_colors_hex=CHROMA_COLORS_HEX, # Pass the hex colors
        chroma_domain=CHROMA_DOMAIN # Pass the domain
    )
