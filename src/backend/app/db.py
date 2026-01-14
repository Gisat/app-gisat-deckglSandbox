import duckdb
from .config import Config

class Database:
    def __init__(self, geoparquet_path=None):
        self._init_db(geoparquet_path)

    def _init_db(self, geoparquet_path):
        self.conn = duckdb.connect(database=':memory:', read_only=False)
        self.conn.execute("INSTALL spatial; LOAD spatial;")
        path = geoparquet_path if geoparquet_path else Config.GEOPARQUET_PATH
        self.conn.execute(f"CREATE OR REPLACE VIEW egms_data AS SELECT * FROM read_parquet('{path}')")

    def get_conn(self):
        return self.conn

db = Database()

