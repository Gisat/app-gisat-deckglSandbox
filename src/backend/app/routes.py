
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
        geoparquet_path = request.args.get('geoparquet_path')
        db = Database(geoparquet_path)
        query = "SELECT dates FROM egms_data LIMIT 1"
        dates_list_objects = db.get_conn().execute(query).fetchone()[0]
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/data', methods=['GET'])
def get_data():
    try:
        geoparquet_path = request.args.get('geoparquet_path')
        db = Database(geoparquet_path)
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


@bp.route('/select', methods=['POST'])
def select_by_geometry():
    """
    Select points within a drawn geometry (polygon/circle/line buffer).
    Backend receives a plain GeoJSON Polygon regardless of how it was drawn.
    Returns full feature data (displacements[], dates[], metadata) for charting.
    """
    try:
        body = request.get_json()
        geometry = body.get('geometry')
        geoparquet_path = body.get('geoparquet_path')
        latitude_col = body.get('latitude_col', 'y')
        longitude_col = body.get('longitude_col', 'x')

        if not geometry:
            return jsonify({'error': 'geometry required'}), 400

        db = Database(geoparquet_path)
        geojson_str = json.dumps(geometry)

        # Query: ST_Within() on the full GeoParquet, return all columns for graphing
        query = f"""
        SELECT
            pid AS point_id,
            {longitude_col} AS longitude,
            {latitude_col} AS latitude,
            displacements,
            dates,
            mean_velocity,
            height
        FROM egms_data
        WHERE ST_Within(
            ST_Point({longitude_col}, {latitude_col}),
            ST_GeomFromGeoJSON(?)
        )
        LIMIT 500
        """

        result = db.get_conn().execute(query, [geojson_str]).fetchall()

        features = []
        for i, row in enumerate(result):
            point_id, lon, lat, displacements, dates, mean_velocity, height = row
            features.append({
                'type': 'Feature',
                'id': point_id,
                'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {
                    'point_id': point_id,
                    'displacements': list(displacements) if displacements else [],
                    'dates': [d.strftime('%Y-%m-%d') for d in dates] if dates else [],
                    'mean_velocity': float(mean_velocity) if mean_velocity else 0,
                    'height': float(height) if height else 0,
                }
            })

        return jsonify({'type': 'FeatureCollection', 'features': features})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
