# RGBA Setup Options

If you cannot re-encode or modify the source COG files (e.g., they are stored in read-only S3 buckets or are too massive to re-process), you must work around the issue at the **runtime or config level**.

Here are the three ways to handle RGBA COGs when modifying dataset metadata is impossible:

---

### Option 1: Map Band Numbers explicitly in `tileserver-rs`

If GDAL doesn't automatically recognize Band 4 as Alpha, you can force `tileserver-rs` to read specific bands in its dataset configuration inside `config.toml` (or via its runtime dataset flags).

In your `config.toml`, explicitly tell `tileserver-rs` how to treat the raster bands:

```toml
[data_sources.my_readonly_cog]
type = "cog"
path = "s3://my-bucket/readonly_imagery.tif"

# Explicitly map bands 1, 2, 3 as RGB and band 4 as the Alpha mask
bands = [1, 2, 3, 4]
color_interp = ["red", "green", "blue", "alpha"]

```

*Verification:* Request a tile covering a boundary area via `/data/my_readonly_cog/Z/X/Y.png` in your browser. The outside area should render transparent rather than black.

---

### Option 2: Define a NoData Value at Runtime

If Band 4 isn't being recognized as an Alpha channel, GDAL often interprets transparent pixels as a specific NoData value (usually `0`, `255`, or `nan` across all bands). You can force `tileserver-rs` to treat those pixel values as transparent during rendering:

```toml
[data_sources.my_readonly_cog]
type = "cog"
path = "./readonly_imagery.tif"
nodata = 0 # Treats RGB (0,0,0) / pure black as transparent

```

*Verification:* Load the layer into MapLibre GL. Black border regions surrounding the rotated imagery should become transparent.

---

### Option 3: Virtual GDAL Header (VRT Sidecar)

If `tileserver-rs` fails to parse the bands even with `config.toml` options, you can create a tiny XML wrapper called a **GDAL Virtual Format (VRT)** file locally. This acts as a lightweight metadata patch without modifying or copying the original multi-gigabyte COG file.

1. **Generate a local VRT XML file:** Creates a ~2KB metadata wrapper.
Run `gdal_translate` using the `-of VRT` flag to reference your remote or read-only COG:

```bash
gdal_translate -of VRT input_readonly.tif patch.vrt

```

*Verification:* Check that `patch.vrt` was generated and is less than 10 KB in size.


2. **Set Alpha Color Interpretation inside the VRT:** Text editor edit.
Open `patch.vrt` in any text editor. Locate `<VRTRasterBand band="4">` and change or add the `ColorInterp` tag:

```xml
<VRTRasterBand dataType="Byte" band="4">
  <ColorInterp>Alpha</ColorInterp>
</VRTRasterBand>

```

*Verification:* Save the file and run `gdalinfo patch.vrt`. Band 4 should now display `ColorInterp=Alpha`.


3. **Point tileserver-rs to the VRT file:**
In your `config.toml`, point the data source path to `patch.vrt` instead of the original `.tif` file:

```toml
[data_sources.my_readonly_cog]
type = "cog"
path = "./patch.vrt"

```

`tileserver-rs` will read metadata from `patch.vrt` while fetching the actual binary pixel streams directly from the underlying read-only COG.


---
