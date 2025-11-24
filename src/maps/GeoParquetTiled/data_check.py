# data_check_final_pyarrow.py (FINAL CORRECTION)
import pyarrow.parquet as pq
import pyarrow
import os
import pandas as pd
import sys

# --- Configuration ---
# 🛑 CRITICAL: Path to one of the newly generated files 🛑
TEST_TILE_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_tiled_detail_v2/part_x=X139.0/part_y=Y499.0/data_0.parquet'
# --- End Configuration ---

print(f"--- Checking GeoParquet Schema via PyArrow ---")

if not os.path.exists(TEST_TILE_PATH):
    print(f"❌ ERROR: Test file not found at: \n{TEST_TILE_PATH}")
    sys.exit(1)

try:
    parquet_file = pq.ParquetFile(TEST_TILE_PATH)
    schema = parquet_file.schema.to_arrow_schema()

    column_data = []

    # Define the IDs we are looking for using the correct PyArrow constants
    BINARY_TYPE = pyarrow.types.is_binary # Check for binary data
    STRING_TYPE = pyarrow.types.is_string # Check for string data (WKT)

    for field in schema:
        # Check if the column type suggests WKB data (the geometry data)
        # We check for the column name AND a type that can hold WKB (Binary/String)
        is_geom = field.name == 'geom_wkb' and (BINARY_TYPE(field.type) or STRING_TYPE(field.type))

        column_data.append({
            'Name': field.name,
            'Type': str(field.type),
            'Is_Geom': '✅' if is_geom else ''
        })

    schema_df = pd.DataFrame(column_data)

    print("\n✅ AVAILABLE COLUMNS (PyArrow):")
    print(schema_df.to_string(index=False))

    # 4. Final verification check
    if 'geom_wkb' in schema_df['Name'].values:
        print("\n🎉 SUCCESS: 'geom_wkb' column is confirmed present. Proceeding to frontend update!")
    else:
        print("\n⚠️ WARNING: 'geom_wkb' is missing from the Parquet file schema.")

except Exception as e:
    print(f"❌ CRITICAL ERROR: Could not read Parquet schema. Details: {e}")
