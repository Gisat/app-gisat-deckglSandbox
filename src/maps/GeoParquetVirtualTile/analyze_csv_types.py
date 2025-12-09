import pandas as pd
import numpy as np
import os

# --- CONFIGURATION ---
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
CHUNK_SIZE = 100000  # Process 100k rows at a time

# Columns to IGNORE (since you are removing them)
IGNORE_COLS = ['easting', 'northing']

# Columns that we know are Metadata/Strings (to skip numeric analysis)
STRING_COLS = ['pid']

def suggest_type(col_name, min_val, max_val, dtype):
    """
    Returns a recommended DuckDB type based on value range.
    """
    # 1. Handle Floats
    if np.issubdtype(dtype, np.floating):
        # In 99% of GIS/Physics cases, FLOAT (Float32) is sufficient.
        # We only keep DOUBLE if values are huge (like coordinates in millions).
        if abs(min_val) > 1e6 or abs(max_val) > 1e6:
            if "latitude" in col_name or "longitude" in col_name:
                return "FLOAT (or DOUBLE for <10cm accuracy)"
            return "DOUBLE (Values are large)"
        return "FLOAT (4 bytes)"

    # 2. Handle Integers
    if np.issubdtype(dtype, np.integer):
        # check for Unsigned candidates
        if min_val >= 0:
            if max_val <= 255: return "UTINYINT (1 byte)"
            if max_val <= 65535: return "USMALLINT (2 bytes)"
            if max_val <= 4294967295: return "UINTEGER (4 bytes)"

        # Signed checks
        if min_val >= -128 and max_val <= 127: return "TINYINT (1 byte)"
        if min_val >= -32768 and max_val <= 32767: return "SMALLINT (2 bytes)"
        if min_val >= -2147483648 and max_val <= 2147483647: return "INTEGER (4 bytes)"

        return "BIGINT (8 bytes)"

    return "VARCHAR"

def analyze_csv():
    print(f"--- Analyzing {os.path.basename(INPUT_CSV_PATH)} ---")

    # Store global min/max here
    stats = {}
    displacement_stats = {"min": float('inf'), "max": float('-inf')}

    # Read in chunks to handle large files
    chunk_iter = pd.read_csv(INPUT_CSV_PATH, chunksize=CHUNK_SIZE)

    first_chunk = True
    processed_rows = 0

    for chunk in chunk_iter:
        # Drop ignored columns immediately
        chunk = chunk.drop(columns=[c for c in IGNORE_COLS if c in chunk.columns], errors='ignore')

        # Identify date columns (dynamic columns that are not in your known static list)
        # Assuming date columns look like numbers '20190101' but are strictly displacement values
        # For simplicity, let's treat any column NOT in specific metadata lists as a displacement column
        # OR: Just analyze everything.
        # A better approach: Analyze all columns individually.

        for col in chunk.columns:
            if col in STRING_COLS:
                continue

            # Skip if purely object/string that isn't numeric
            if not pd.api.types.is_numeric_dtype(chunk[col]):
                continue

            current_min = chunk[col].min()
            current_max = chunk[col].max()

            if col not in stats:
                stats[col] = {"min": current_min, "max": current_max, "dtype": chunk[col].dtype}
            else:
                if current_min < stats[col]["min"]: stats[col]["min"] = current_min
                if current_max > stats[col]["max"]: stats[col]["max"] = current_max

        processed_rows += len(chunk)
        print(f"\rProcessed {processed_rows:,} rows...", end="")

    print("\n\n--- Analysis Complete. Recommended Types: ---\n")
    print(f"{'Column Name':<25} | {'Min':<15} | {'Max':<15} | {'Recommended Type'}")
    print("-" * 85)

    # Sort: Static cols first, then a summary for dates if too many
    sorted_cols = sorted(stats.keys())

    for col in sorted_cols:
        s = stats[col]
        rec_type = suggest_type(col, s['min'], s['max'], s['dtype'])

        # Format numbers prettily
        min_str = f"{s['min']:.4f}" if isinstance(s['min'], float) else str(s['min'])
        max_str = f"{s['max']:.4f}" if isinstance(s['max'], float) else str(s['max'])

        print(f"{col:<25} | {min_str:<15} | {max_str:<15} | {rec_type}")

if __name__ == "__main__":
    analyze_csv()
