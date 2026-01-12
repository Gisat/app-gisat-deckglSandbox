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

    # Initialize Database Singleton within app context
    # This ensures the database connection is created when the app starts.
    with app.app_context():
        from . import db
        db.Database()

    return app

