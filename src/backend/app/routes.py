from flask import Blueprint, request, jsonify, send_file
from .db import db
import io
import pyarrow as pa
import traceback

bp = Blueprint('api', __name__)

@bp.route('/api/dates', methods=['GET'])
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
        tier_id = request.args.get('tier_id', type=int)
        timeIndex = request.args.get('timeIndex', type=int, default=0)
        if tile_x is None or tile_y is None or tier_id is None:
            return jsonify({'error': 'tile_x, tile_y, and tier_id are required parameters'}), 400
        sql_index = timeIndex + 1  # DuckDB 1-based indexing
        query = """
            SELECT x, y, displacements[?] AS val
            FROM egms_data
            WHERE tile_x = ? AND tile_y = ? AND tier_id = ?
        """
        final_params = [sql_index, tile_x, tile_y, tier_id]
        arrow_table = db.get_conn().execute(query, final_params).fetch_arrow_table()
        output_buffer = io.BytesIO()
        with pa.ipc.RecordBatchStreamWriter(output_buffer, arrow_table.schema) as writer:
            writer.write_table(arrow_table)
        output_buffer.seek(0)
        return send_file(output_buffer, mimetype='application/vnd.apache.arrow.stream')
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
