import geopandas as gpd
import pandas as pd
import numpy as np
import json
import matplotlib.cm as cm # Import colormap module
import matplotlib.colors as colors # Import colors module

# --- Configuration Variables (Easily changeable) ---
INPUT_CSV_PATH = '/Users/marianakecova/Library/CloudStorage/GoogleDrive-mariana.kecova@gisat.cz/Sdílené disky/Projects/Metro D1 GST-30/DATA/results_e5/sipky/compo_area_vellast_sipky.csv'
OUTPUT_GEOJSON_PATH = '/Users/marianakecova/Library/CloudStorage/GoogleDrive-mariana.kecova@gisat.cz/Sdílené disky/Projects/Metro D1 GST-30/DATA/results_e5/sipky/compo_area_vellast_sipky_colors.geojson'
LON_COLUMN_NAME = 'LON_CENTER'
LAT_COLUMN_NAME = 'LAT_CENTER'
CRS_EPSG_CODE = 4326

# Column to use for color calculation
COLOR_SOURCE_COLUMN = 'VEL_LA_EW' # Set to None, or to a column name like 'VEL_LA_UP'

# --- Chroma.js-like Color Scale Definition ---
# These are the hex codes from your app.js
CHROMA_COLORS_HEX = [
    '#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000',
    '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'
]
# This is the domain from your app.js
CHROMA_DOMAIN = [-2, 2]
# --- End Color Scale Definition ---


# --- Main GeoJSON Generation Logic ---
def generate_geojson(input_csv_path: str, output_geojson_path: str,
                     lon_col: str, lat_col: str, crs_epsg: int,
                     color_source_col: str = None,
                     chroma_colors: list = None, chroma_domain: list = None): # New color parameters
    """
    Generates a GeoJSON file from a CSV, with optional pre-calculated colors
    using a chroma.js-like color scale via matplotlib.
    """
    print("--- Starting GeoJSON Generation Script ---")
    print(f"Input CSV: {input_csv_path}")
    print(f"Output GeoJSON: {output_geojson_path}\n")

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

    # 3. Optional: Precompute Colors and add to GeoDataFrame properties
    if color_source_col and chroma_colors and chroma_domain:
        print(f"\n--- Pre-calculating colors based on '{color_source_col}' using Chroma.js-like scale ---")
        if color_source_col not in gdf.columns:
            print(f"Error: Color source column '{color_source_col}' not found. Cannot pre-calculate colors.")
        else:
            # Create a custom colormap from your chroma.js hex colors
            cmap = colors.LinearSegmentedColormap.from_list("my_chroma_cmap", chroma_colors)

            # Normalize the data values from the specified domain to 0-1 for the colormap
            norm = colors.Normalize(vmin=chroma_domain[0], vmax=chroma_domain[1])

            # Create a ScalarMappable to apply the colormap and normalization
            scalar_mappable = cm.ScalarMappable(norm=norm, cmap=cmap)

            # Get RGBA colors (0-1 range) for each data point
            rgba_float_colors = scalar_mappable.to_rgba(gdf[color_source_col].values)

            # Convert RGBA (0-1 float) to RGBA (0-255 int) for Deck.gl
            geojson_colors = (rgba_float_colors * 255).astype(int).tolist()

            # Assign this list of RGBA lists to a new column in gdf
            gdf['geojson_color'] = geojson_colors
            print(f"Pre-calculated colors added as 'geojson_color' property to GeoDataFrame.")
    else:
        print("\n--- Skipping pre-calculation of colors for GeoJSON. ---")
        if not color_source_col:
            print("No 'color_source_col' provided.")
        if not chroma_colors:
            print("No 'chroma_colors' provided.")
        if not chroma_domain:
            print("No 'chroma_domain' provided.")


    # 4. Save the GeoDataFrame to GeoJSON
    print("\n--- Saving GeoDataFrame to GeoJSON ---")
    try:
        gdf.to_file(output_geojson_path, driver="GeoJSON")
        print(f"GeoJSON file saved to: {output_geojson_path}")
        print("\n--- Script Finished ---")
    except Exception as e:
        print(f"Error saving GeoJSON file: {e}. Aborting.")
        return


# --- Execute the script ---
if __name__ == "__main__":
    generate_geojson(
        input_csv_path=INPUT_CSV_PATH,
        output_geojson_path=OUTPUT_GEOJSON_PATH,
        lon_col=LON_COLUMN_NAME,
        lat_col=LAT_COLUMN_NAME,
        crs_epsg=CRS_EPSG_CODE,
        color_source_col=COLOR_SOURCE_COLUMN, # Pass the column name
        chroma_colors=CHROMA_COLORS_HEX, # Pass the hex colors
        chroma_domain=CHROMA_DOMAIN # Pass the domain
    )
