# analyze_data.py
import pandas as pd

# --- Configuration ---
# Make sure this points to your original source CSV
INPUT_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'
COLUMN_TO_ANALYZE = 'mean_velocity'
# --- End Configuration ---

try:
    print(f"Reading data from: {INPUT_CSV_PATH}")
    df = pd.read_csv(INPUT_CSV_PATH)

    print(f"\nStatistical summary for the '{COLUMN_TO_ANALYZE}' column:")

    # The .describe() function gives a quick summary including min and max
    summary = df[COLUMN_TO_ANALYZE].describe()
    print(summary)

except FileNotFoundError:
    print(f"Error: The file at {INPUT_CSV_PATH} was not found.")
except KeyError:
    print(f"Error: Column '{COLUMN_TO_ANALYZE}' not found in the CSV.")
except Exception as e:
    print(f"An error occurred: {e}")
