# inspect_parquet_final.py
import pyarrow.parquet as pq
import sys
import json

def inspect_file(file_path):
    try:
        print(f"--- Inspecting Metadata for: {file_path} ---\n")
        parquet_file = pq.ParquetFile(file_path)
        schema = parquet_file.schema

        print("## 1. Top-Level GeoParquet Metadata ('geo') ##")
        file_metadata = parquet_file.metadata.metadata
        if b'geo' in file_metadata:
            geo_meta = json.loads(file_metadata[b'geo'])
            print(json.dumps(geo_meta, indent=2))
        else:
            print("  --> No 'geo' metadata found in file header.")

        print("\n--------------------------------------------\n")

        print("## 2. Column-Level Arrow Schema Metadata ##")
        # --- FIX FOR VERY OLD PYARROW ---
        # Iterate by index instead of name for maximum compatibility
        for i in range(len(schema)):
            field = schema[i] # Access field by its numeric index
            print(f"\n- Column '{field.name}' (Type: {field.type})")
            if field.metadata:
                for key, value in field.metadata.items():
                    key_str = key.decode('utf-8', 'ignore')
                    value_str = value.decode('utf-8', 'ignore')
                    print(f"    - {key_str}: {value_str}")
            else:
                print("    - No column metadata.")

    except Exception as e:
        print(f"\nAn error occurred: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python inspect_parquet_final.py <path_to_your_file.parquet>")
    else:
        inspect_file(sys.argv[1])
