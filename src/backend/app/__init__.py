from flask import Flask
from flask_cors import CORS
from .config import Config

def create_app():
    """Create and configure an instance of the Flask application."""
    app = Flask(__name__)
    app.config.from_object(Config)

    # Initialize CORS
    CORS(app)

    # Import and register blueprints
    from . import routes
    app.register_blueprint(routes.bp)

    # Importing the db module eagerly opens the shared DuckDB connection
    # (db.py builds the module-level singleton Database() at import time, which
    # reads the geoparquet once and reuses it for every request — no per-request
    # reloads). This explicit import also surfaces a bad GEOPARQUET_PATH early.
    from . import db  # noqa: F401

    return app

