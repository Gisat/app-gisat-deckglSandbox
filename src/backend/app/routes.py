
from flask import Blueprint, request, jsonify, send_file
from .db import Database
import io
import json
import pyarrow as pa
import traceback

bp = Blueprint('api', __name__, url_prefix='/api')

@bp.route('/dates', methods=['GET'])
def get_dates():
    try:
        db = Database()  # Uses GEOPARQUET_PATH from environment only
        query = "SELECT dates FROM egms_data LIMIT 1"
        dates_list_objects = db.get_conn().execute(query).fetchone()[0]
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/data', methods=['GET'])
def get_data():
    try:
        db = Database()  # Uses GEOPARQUET_PATH from environment only
        tile_x = request.args.get('tile_x', type=int)
        tile_y = request.args.get('tile_y', type=int)
        date_index = request.args.get('date_index', type=int, default=0)
        mode = request.args.get('mode', type=str, default='static')
        target_tier = request.args.get('tier', type=int, default=0)
        is_3d = request.args.get('is3D') == 'true'
        latitude_col = request.args.get('latitude_col', 'y')
        longitude_col = request.args.get('longitude_col', 'x')
        height_col = request.args.get('height_col', 'height')
        size_col = request.args.get('size_col', 'mean_velocity')
        color_col = request.args.get('color_col', 'color')
        dates_col = request.args.get('dates_col', 'dates')
        displacements_col = request.args.get('displacements_col', 'displacements')

        db_index = date_index + 1

        base_cols = f"{longitude_col} AS longitude, {latitude_col} AS latitude"
        if is_3d:
            base_cols += f", {height_col} AS height, {size_col} AS mean_velocity"

        # add point_id for selection tracking
        base_cols += ", pid AS point_id"

        if mode == 'animation':
            selection_col = f"{displacements_col} AS displacements"
        else:
            selection_col = f"{displacements_col}[{db_index}] AS displacement"
        is_global = request.args.get('global') == 'true'
        if is_global:
            query = f"""
            SELECT {base_cols}, {selection_col}
            FROM egms_data WHERE tier_id = 0
            """
            final_params = []
        else:
            if tile_x is None or tile_y is None:
                return jsonify({'error': 'tile_x and tile_y are required for tiled requests'}), 400
            query = f"""
            SELECT {base_cols}, {selection_col}
            FROM egms_data
            WHERE tile_x = ? AND tile_y = ? AND tier_id = ?
            """
            final_params = [tile_x, tile_y, target_tier]

        arrow_table = db.get_conn().execute(query, final_params).fetch_arrow_table()

        output_buffer = io.BytesIO()
        with pa.ipc.RecordBatchStreamWriter(output_buffer, arrow_table.schema) as writer:
            writer.write_table(arrow_table)
        output_buffer.seek(0)
        return send_file(output_buffer, mimetype='application/vnd.apache.arrow.stream')
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500



def _get_target_tier(zoom):
    """Map zoom level to data tier (LOD)"""
    if zoom <= 13:
        return 0  # 5% data
    elif zoom <= 15:
        return 1  # 35% data
    else:
        return 2  # 100% data

def _bbox_to_tiles(min_lon, max_lon, min_lat, max_lat, zoom):
    """
    Calculate which grid tiles intersect the bbox at given zoom level.
    Grid size: 0.06 degrees (matches generate_virtual_tiles.py)
    """
    grid_size = 0.06
    
    # Convert lon/lat to tile indices
    tile_x_min = int(min_lon / grid_size)
    tile_x_max = int(max_lon / grid_size)
    tile_y_min = int(min_lat / grid_size)
    tile_y_max = int(max_lat / grid_size)
    
    # Generate all tile coordinates
    tiles = []
    for tx in range(tile_x_min, tile_x_max + 1):
        for ty in range(tile_y_min, tile_y_max + 1):
            tiles.append((tx, ty))
    
    return tiles

@bp.route('/select', methods=['POST'])
def select_by_geometry():
    """
    Select points by point ID (fast, local filtering approach) or by geometry (legacy).
    
    Expected JSON:
    - point_ids: Array of point IDs (PREFERRED - fastest, no spatial query on backend)
    - metrics: Array of metric column names to include (e.g., ["mean_velocity", "height"])
    - geometry: GeoJSON Polygon (legacy, for backward compatibility)
    
    Returns FeatureCollection with full feature data (displacements[], dates[], metadata).
    """
    try:
        body = request.get_json()
        point_ids = body.get('point_ids')
        geometry = body.get('geometry')
        metrics = body.get('metrics', [])
        zoom = body.get('zoom', 12)
        latitude_col = body.get('latitude_col', 'y')
        longitude_col = body.get('longitude_col', 'x')

        db = Database()

        # Validate requested metrics against a safelist of allowed columns
        allowed_metrics = [
            'mean_velocity', 'height', 'mean_velocity_std', 
            'los_up', 'los_east', 'los_north', 'rmse', 
            'acceleration', 'seasonality'
        ]
        sanitized_metrics = [m for m in metrics if m in allowed_metrics]

        # Define base columns that are always required
        base_cols = [
            'pid AS point_id',
            f'{longitude_col} AS longitude',
            f'{latitude_col} AS latitude',
            'displacements',
            'dates'
        ]

        # Add the sanitized metrics to the select columns
        select_cols_list = base_cols + sanitized_metrics
        select_cols = ', '.join(select_cols_list)
        
        # **NEW APPROACH**: Query by point IDs
        if point_ids and len(point_ids) > 0:
            placeholders = ','.join(['?' for _ in point_ids])
            query = f"SELECT {select_cols} FROM egms_data WHERE pid IN ({placeholders})"
            result = db.get_conn().execute(query, point_ids).fetchall()

        # **LEGACY**: Query by geometry
        elif geometry:
            # (Omitting legacy geometry query implementation for brevity as it's not used by current frontend)
            return jsonify({'error': 'geometry-based selection is deprecated'}), 400

        else:
            return jsonify({'error': 'either point_ids or geometry required'}), 400

        # Build response dynamically
        features = []
        # The order of columns in the result will match select_cols_list
        column_names = [col.split(' AS ')[-1] for col in select_cols_list]

        for row in result:
            row_dict = dict(zip(column_names, row))
            
            # Basic properties
            props = {
                'point_id': row_dict.get('point_id'),
                'displacements': list(row_dict.get('displacements', [])) if row_dict.get('displacements') else [],
                'dates': [d.strftime('%Y-%m-%d') for d in row_dict.get('dates', [])] if row_dict.get('dates') else [],
            }
            
            # Add requested metrics
            for metric in sanitized_metrics:
                value = row_dict.get(metric)
                props[metric] = float(value) if value is not None else 0

            features.append({
                'type': 'Feature',
                'id': row_dict.get('point_id'),
                'geometry': {'type': 'Point', 'coordinates': [row_dict.get('longitude'), row_dict.get('latitude')]},
                'properties': props
            })

        return jsonify({'type': 'FeatureCollection', 'features': features})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
