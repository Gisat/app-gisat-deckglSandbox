# 2D Line Profile Visualization - Phase 3c Planning

**Date:** 2026-05-21  
**Status:** 📋 PLANNING ONLY (Not implemented yet)  
**Depends on:** Phase 3a (Scatter Plot) + Phase 3b (3D Visualization)

## Overview
When a user draws a **line** across a water dam with a buffer, create a 2D line profile showing vertical displacement measurements projected onto the line axis. Display multiple displacement metrics (VEL_REL, VEL_LAST, LAST_TREND) with uncertainty bands.

## Visual Concept
Line profiles showing displacement vs distance along dam, with separate longitudinal and lateral projections. Points within buffer are projected perpendicular to the line, binned by distance along line, and displayed with uncertainty bands (mean ± std).

## Requirements

### Input
- Line drawn with selection tool (already have)
- Buffer distance (reuse existing slider, default 100m)
- Selected points within buffer around line

### Output
- **Longitudinal profile:** Points projected along line axis
- **Lateral profile:** Points projected perpendicular to line
- **Multiple metrics:** VEL_REL, VEL_LAST, LAST_TREND on same chart
- **Uncertainty bands:** Mean ± std deviation for each bin

### Data Flow
```
User draws line with buffer
  ↓
Select all points within line buffer (existing selection logic)
  ↓
Project each point onto line
  - Get distance along line
  - Get offset from line (perpendicular)
  ↓
Bin points by distance along line (e.g., 50m bins)
  ↓
Calculate statistics for each bin
  - Mean displacement
  - Std deviation
  - Count of points
  ↓
Chart with bands
```

## Implementation Strategy

### Phase 3a: Simple Scatter Plot ✅ (DO FIRST)
**Goal:** Test selection → chart pipeline with simplest possible chart
- X-axis: dates or index
- Y-axis: single displacement value
- Single metric (e.g., mean_velocity)
- No projection, no binning, no line logic
- Validates: data flow, backend→frontend→chart connection

### Phase 3b: 3D Visualization (DO SECOND)
**Goal:** 3D representation of selected points
- Maybe 3D scatter in Deck.GL
- Or 3D time-series animation
- TBD based on requirements

### Phase 3c: 2D Line Profile ✅ (DO THIRD)
**Goal:** Full line profile with projections and uncertainty bands

**Key Algorithms:**

1. **Line Representation:**
   ```
   line = { start: [lon, lat], end: [lon, lat] }
   line_vector = [end.lon - start.lon, end.lat - start.lat]
   line_length = sqrt(line_vector[0]² + line_vector[1]²)
   line_unit = line_vector / line_length
   ```

2. **Point to Line Projection:**
   ```
   For each point [px, py]:
     - Vector from line start to point: v = [px - start.lon, py - start.lat]
     - Distance along line: d = v · line_unit (dot product)
     - Offset from line: offset = distance from point to projected point
     - Check if offset <= buffer_distance (if not, exclude)
   ```

3. **Binning:**
   ```
   BIN_SIZE = 50m (configurable)
   For each bin [0m, 50m), [50m, 100m), ...
     - Collect all points where distance falls in bin
     - Calculate mean displacement
     - Calculate std deviation
     - Count points
   ```

4. **Uncertainty Bands:**
   ```
   For each bin:
     - mean = avg(displacements)
     - std = std_dev(displacements)
     - upper = mean + std
     - lower = mean - std
   ```

## Technical Decisions

### Charting Library
- Use Nivo (already in colleague's code)
- `ResponsiveLineChart` or custom rendering with uncertainty bands
- Multiple series: one per metric (VEL_REL, VEL_LAST, LAST_TREND)

### Projection Direction
- **Longitudinal:** Project along line direction (main displacement)
- **Lateral:** Project perpendicular to line (cross-dam movement)
- Create separate chart for each? Or toggle?

### Binning Strategy
- Fixed bin size (e.g., 50m)?
- Or adaptive (based on point density)?
- Allow user to adjust bin size in UI?

### Coordinate Systems
- Need to convert lat/lon distances to meters
- Use haversine formula or Web Mercator?
- At dam scale (few km), Mercator should be fine

## Files to Create/Modify

### New Files
- `src/maps/GeoParquetDuckDB_2D/frontend/components/LineProfileChart.jsx`
  - Component to display line profile
  - Accepts: selectedFeatures, lineGeometry
- `src/maps/GeoParquetDuckDB_2D/frontend/utils/lineProjection.js`
  - Point-to-line projection logic
  - Binning and statistics
- `src/maps/GeoParquetDuckDB_2D/frontend/utils/coordinateUtils.js`
  - Distance calculations (haversine, etc)

### Modified Files
- `src/maps/GeoParquetDuckDB_2D/frontend/Map2D.jsx`
  - Add line profile component
  - Pass lineGeometry and selectedFeatures

## Data Validation
- Ensure line geometry is valid (start != end)
- Ensure buffer distance > 0
- Ensure selected points exist
- Handle edge case: no points in buffer

## Performance Considerations
- Projection O(n) where n = number of selected points
- Binning O(n)
- For 1000 points: instant
- For 10K+ points: might need optimization

## Testing Strategy
1. Draw line across test data (dam area)
2. Verify points within buffer are selected
3. Verify projection calculations (spot-check)
4. Verify binning groups points correctly
5. Verify chart renders with correct means/stds

## Nice-to-Have (Future)
- [ ] Export profile to CSV
- [ ] Compare multiple selections (overlay profiles)
- [ ] Smoothing/filtering for noisy data
- [ ] 3D surface visualization (interpolate between profiles)
- [ ] Customizable colors per metric
- [ ] Animation over time (show profile evolution)

## Blockers / Unknowns
- What displacement metrics are available in data?
  - Currently: `displacements[]` (time-series), `mean_velocity`
  - Need: VEL_REL, VEL_LAST, LAST_TREND — are these computed or stored?
- Coordinate system precision: Mercator vs actual metric distances?
- Chart styling: Use Mantine components or raw Nivo?

## References
- Colleague's scatter chart: `@nivo/scatterplot` pattern
- Line profile image: shows uncertainty bands as shaded regions
- Similar: seismic section profiles, terrain cross-sections
