import pandas as pd
import numpy as np
import os
import sys

# --- Configuration ---
INPUT_WIDE_CSV_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.csv'

# Target tile size for efficient web transfer (5 MB = 5,000,000 Bytes)
TARGET_TILE_SIZE_BYTES = 5 * 1024 * 1024

# Columns needed for calculation (must match your CSV)
LAT_COL = 'latitude'
LON_COL = 'longitude'
# --- End Configuration ---

def estimate_optimal_grid_size(csv_path, target_size_bytes):
    """
    Analyzes the CSV file's size and point distribution to recommend an optimal
    spatial grid size for tiling.
    """
    print(f"--- 📊 Grid Size Estimation Tool ---")

    # Check if file exists
    if not os.path.exists(csv_path):
        print(f"❌ Error: File not found at '{csv_path}'")
        sys.exit(1)

    # 1. Load Data for Analysis (Only load necessary columns)
    print(f"1. Reading metadata and coordinates from CSV...")

    try:
        # We only need the coordinates for min/max calculation
        df = pd.read_csv(csv_path, usecols=[LAT_COL, LON_COL])
    except Exception as e:
        print(f"❌ Error reading CSV. Check file path and column names ('{LAT_COL}', '{LON_COL}').")
        print(f"Details: {e}")
        sys.exit(1)

    total_points = len(df)

    if total_points == 0:
        print("❌ Error: CSV contains no data points.")
        sys.exit(1)

    # 2. Determine Geographic Extent and Area
    min_lat, max_lat = df[LAT_COL].min(), df[LAT_COL].max()
    min_lon, max_lon = df[LON_COL].min(), df[LON_COL].max()

    lat_range = max_lat - min_lat
    lon_range = max_lon - min_lon

    # We use a simple bounding box area approximation in degrees squared.
    total_area_deg2 = lat_range * lon_range

    # 3. Estimate Average Bytes Per Point (Crucial Step)
    file_size_bytes = os.path.getsize(csv_path)

    # IMPORTANT ASSUMPTION: Parquet is much more compressed than the CSV.
    # We will assume a 10:1 compression ratio (a common conservative guess).
    # If the real compression ratio is 20:1, the estimated grid size will be too high.
    COMPRESSION_RATIO_ESTIMATE = 10

    # Estimated compressed data size (GeoParquet)
    estimated_parquet_size_bytes = file_size_bytes / COMPRESSION_RATIO_ESTIMATE

    # Estimated compressed bytes per point
    avg_bytes_per_point = estimated_parquet_size_bytes / total_points

    # 4. Calculation

    # A. Calculate the ideal number of points per tile
    points_per_tile = target_size_bytes / avg_bytes_per_point

    # B. Calculate the average point density
    avg_density = total_points / total_area_deg2

    # C. Calculate the grid size (the side length of the square tile)
    if avg_density == 0:
         print("❌ Error: Total area is zero (all points at same location). Cannot calculate grid.")
         sys.exit(1)

    grid_size_squared = points_per_tile / avg_density
    recommended_grid_size = np.sqrt(grid_size_squared)


    # --- Results Summary ---
    print("\n--- ✅ Analysis Results ---")
    print(f"Total Points (N):          {total_points:,.0f}")
    print(f"Source CSV Size:           {file_size_bytes / (1024**2):.2f} MB")
    print(f"Geographic Extent (Lat):   {min_lat:.4f} to {max_lat:.4f} ({lat_range:.4f}°)")
    print(f"Geographic Extent (Lon):   {min_lon:.4f} to {max_lon:.4f} ({lon_range:.4f}°)")
    print("---------------------------------")
    print(f"Target Tile Size:          {target_size_bytes / (1024**2):.0f} MB")
    print(f"Est. Avg Bytes/Point (Compressed): {avg_bytes_per_point:.2f} bytes")
    print(f"Ideal Points per Tile:     {points_per_tile:,.0f} points")
    print("---------------------------------")
    print(f"**Recommended GRID_SIZE:** **{recommended_grid_size:.3f} degrees**")
    print(f"**Corresponding Tile Count (Approx):** {(total_area_deg2 / (recommended_grid_size**2)):,.0f} tiles")
    print("---------------------------------")
    print("ℹ️ Use the nearest sensible value (e.g., 0.1, 0.05) in your Python script.")

    return recommended_grid_size

if __name__ == '__main__':
    estimate_optimal_grid_size(INPUT_WIDE_CSV_PATH, TARGET_TILE_SIZE_BYTES)
