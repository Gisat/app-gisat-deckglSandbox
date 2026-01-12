from flask import Blueprint, request, jsonify, send_file
from .db import db
import io
import pyarrow as pa
import traceback

from flask import Blueprint, request, jsonify, send_file
from .db import db
import io
import pyarrow as pa
import traceback

bp = Blueprint('api', __name__, url_prefix='/api')

@bp.route('/dates', methods=['GET'])
def get_dates():
    try:
        query = "SELECT dates FROM egms_data LIMIT 1"
        dates_list_objects = db.get_conn().execute(query).fetchone()[0]
        dates_list_strings = [d.strftime('%Y-%m-%d') for d in dates_list_objects]
        return jsonify(dates_list_strings)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/data', methods=['GET'])
def get_data():
    try:
        tile_x = request.args.get('tile_x', type=int)
        tile_y = request.args.get('tile_y', type=int)
        date_index = request.args.get('date_index', type=int, default=0)
        mode = request.args.get('mode', type=str, default='static')
        target_tier = request.args.get('tier', type=int, default=0)
        db_index = date_index + 1
        if mode == 'animation':
            selection_col = "displacements"
        else:
            selection_col = "displacements[?] AS displacement"
        is_global = request.args.get('global') == 'true'
        if is_global:
            query = f"""
            SELECT x AS longitude, y AS latitude, {selection_col}
            FROM egms_data WHERE tier_id = ?
            """
            final_params = [target_tier] if mode == 'animation' else [db_index, target_tier]
        else:
            if tile_x is None or tile_y is None:
                return jsonify({'error': 'tile_x and tile_y are required for tiled requests'}), 400
            query = f"""
            SELECT x AS longitude, y AS latitude, {selection_col}
            FROM egms_data
            WHERE tile_x = ? AND tile_y = ? AND tier_id = ?
            """
            final_params = [tile_x, tile_y, target_tier] if mode == 'animation' else [db_index, tile_x, tile_y, target_tier]

        arrow_table = db.get_conn().execute(query, final_params).fetch_arrow_table()

        output_buffer = io.BytesIO()
        with pa.ipc.RecordBatchStreamWriter(output_buffer, arrow_table.schema) as writer:
            writer.write_table(arrow_table)
        output_buffer.seek(0)
        return send_file(output_buffer, mimetype='application/vnd.apache.arrow.stream')
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
