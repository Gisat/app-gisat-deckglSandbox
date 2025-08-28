# generate_polygons_geoparquet.py
import geopandas as gpd
import os

# --- Configuration ---
INPUT_GEOJSON_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/SO_Praha_Neratovice+h-z-geoportalu+cl_risk_4326.geojson'
OUTPUT_GEOPARQUET_PATH = '/Users/marianakecova/GST/3DFLUS_CCN/SO_Praha_Neratovice+h-z-geoportalu+cl_risk_4326.geoparquet'
# --- End Configuration ---

print(f"--- Starting Polygon GeoParquet Generation ---")

if not os.path.exists(INPUT_GEOJSON_PATH):
    print(f"FATAL: Input GeoJSON not found at '{INPUT_GEOJSON_PATH}'")
else:
    try:
        print(f"Reading GeoJSON file: {INPUT_GEOJSON_PATH}")
        gdf = gpd.read_file(INPUT_GEOJSON_PATH)
        print(f"Read {len(gdf)} polygons into GeoDataFrame.")

        # Ensure the 'h' column, used for height, is a numeric type (float)
        if 'h' in gdf.columns:
            gdf['h'] = gdf['h'].astype(float)
            print("Validated 'h' column for extrusion.")
        else:
            raise ValueError("The specified height column 'h' was not found in the GeoJSON properties.")

        # Spatially sort the data using Hilbert distance for faster queries later
        print("Spatially sorting the data...")
        gdf['hilbert'] = gdf.geometry.hilbert_distance()
        gdf_sorted = gdf.sort_values('hilbert').drop(columns=['hilbert'])
        print("Sorting complete.")

        print(f"Saving final GeoParquet file to: {OUTPUT_GEOPARQUET_PATH}")
        gdf_sorted.to_parquet(OUTPUT_GEOPARQUET_PATH, index=False, compression='snappy')
        print("Successfully wrote GeoParquet file.")

    except Exception as e:
        print(f"An error occurred: {e}")
