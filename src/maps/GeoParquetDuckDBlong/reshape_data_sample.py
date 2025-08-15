# reshape_data_chunked.py
import pandas as pd
import os

# --- Configuration ---
INPUT_CSV_PATH = './sample_wide.csv'
OUTPUT_RESHAPED_CSV_PATH = './sample_reshaped_long.csv' # Use the new reshaped file
CHUNK_SIZE = 100000  # Process 100,000 rows at a time

# List of columns that identify a point (everything that IS NOT a date)
ID_COLUMNS = [
    'pid', 'mp_type', 'latitude', 'longitude', 'easting', 'northing', 'height',
    'height_wgs84', 'line', 'pixel', 'rmse', 'temporal_coherence',
    'amplitude_dispersion', 'incidence_angle', 'track_angle', 'los_east',
    'los_north', 'los_up', 'mean_velocity', 'mean_velocity_std',
    'acceleration', 'acceleration_std', 'seasonality', 'seasonality_std'
]
# --- End Configuration ---

# Delete the output file if it exists to start fresh
if os.path.exists(OUTPUT_RESHAPED_CSV_PATH):
    os.remove(OUTPUT_RESHAPED_CSV_PATH)

print(f"Reading wide-format CSV in chunks: {INPUT_CSV_PATH}")

# Create an iterator that reads the CSV in chunks
chunk_iterator = pd.read_csv(INPUT_CSV_PATH, chunksize=CHUNK_SIZE)

is_first_chunk = True

for i, df_chunk in enumerate(chunk_iterator):
    print(f"Processing chunk #{i+1}...")

    # 'Melt' the chunk, turning date columns into rows
    df_long_chunk = pd.melt(
        df_chunk,
        id_vars=ID_COLUMNS,
        var_name='date',
        value_name='displacement'
    )

    # Convert the date column to a proper YYYY-MM-DD format
    df_long_chunk['date'] = pd.to_datetime(df_long_chunk['date'], format='%Y%m%d').dt.strftime('%Y-%m-%d')

    # For the first chunk, write to a new file with the header
    if is_first_chunk:
        df_long_chunk.to_csv(OUTPUT_RESHAPED_CSV_PATH, index=False, mode='w', header=True)
        is_first_chunk = False
    # For all subsequent chunks, append to the existing file without the header
    else:
        df_long_chunk.to_csv(OUTPUT_RESHAPED_CSV_PATH, index=False, mode='a', header=False)

print(f"\nReshaping complete. Saved long-format data to: {OUTPUT_RESHAPED_CSV_PATH}")
