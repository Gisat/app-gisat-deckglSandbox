import os

class Config:
    GEOPARQUET_PATH = os.environ.get('GEOPARQUET_PATH', '/app/data/egms_optimized_be.geoparquet')

