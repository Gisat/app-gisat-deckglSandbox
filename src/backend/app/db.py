import duckdb
from .config import Config

class SingletonDB:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._init_db()
        return cls._instance

    def _init_db(self):
        self.conn = duckdb.connect()
        self.conn.execute("INSTALL spatial; LOAD spatial;")
        # Use the path from config and create the view as 'egms_data' for compatibility
        self.conn.execute(f"CREATE OR REPLACE VIEW egms_data AS SELECT * FROM read_parquet('{Config.GEOPARQUET_PATH}')")

    def get_conn(self):
        return self.conn

db = SingletonDB()

