# get_unique_dates.py
import pandas as pd
import json

# --- Configuration ---
# Point this to your NEW, reshaped, long-format CSV
INPUT_CSV_PATH = './sample_reshaped_long.csv'
# --- End Configuration ---

try:
    print(f"Reading dates from: {INPUT_CSV_PATH}")
    df = pd.read_csv(INPUT_CSV_PATH)

    # Find unique dates, sort them, and convert to a list
    unique_dates = sorted(df['date'].unique())

    print("\n--- COPY AND PASTE THE FOLLOWING ARRAY INTO TimeMap.jsx ---")
    # Print as a JSON array, which is easy to copy
    print(json.dumps(unique_dates))

except Exception as e:
    print(f"An error occurred: {e}")
