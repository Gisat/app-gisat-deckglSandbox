# analyze_displacement.py
import pandas as pd

# --- Configuration ---
# IMPORTANT: Point this to your NEW, reshaped, long-format CSV
INPUT_CSV_PATH = './sample_reshaped_long.csv'
COLUMN_TO_ANALYZE = 'displacement'
# --- End Configuration ---

try:
    print(f"Reading data from: {INPUT_CSV_PATH}")
    df = pd.read_csv(INPUT_CSV_PATH)

    print(f"\nStatistical summary for the '{COLUMN_TO_ANALYZE}' column:")
    summary = df[COLUMN_TO_ANALYZE].describe()
    print(summary)

except Exception as e:
    print(f"An error occurred: {e}")
