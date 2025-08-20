# create_sample.py
import pandas as pd

# --- Configuration ---
# The full path to your original, wide-format CSV
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'

# The name for the new sample file
OUTPUT_SAMPLE_PATH = 'sample_100k_wide.csv'

# The number of data rows you want in the sample
NUM_ROWS = 100000
# --- End Configuration ---

try:
    print(f"Reading the first {NUM_ROWS} rows from {INPUT_CSV_PATH}...")

    # nrows reads only the specified number of data rows (plus the header)
    df_sample = pd.read_csv(INPUT_CSV_PATH, nrows=NUM_ROWS)

    print(f"Saving sample file with {len(df_sample)} rows to {OUTPUT_SAMPLE_PATH}...")
    df_sample.to_csv(OUTPUT_SAMPLE_PATH, index=False)

    print("Sample file created successfully. ✅")

except FileNotFoundError:
    print(f"Error: The input file was not found at {INPUT_CSV_PATH}")
except Exception as e:
    print(f"An error occurred: {e}")
