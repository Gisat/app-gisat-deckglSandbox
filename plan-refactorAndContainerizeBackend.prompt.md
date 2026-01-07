## Plan: Refactor & Containerize Backend for 3DFLUS

This plan outlines the steps to refactor the current monolithic backend (`app_2d.py`) into a modular, production-ready structure under a new `backend/` directory. It introduces clear separation of concerns, dependency management, and containerization for deployment.

### Steps
1. Create `backend/` directory as the root for backend code and assets.
2. Add `backend/requirements.txt` listing flask, flask-cors, duckdb, pyarrow, gunicorn.
3. Create `backend/app/` package for application code.
4. Implement `backend/app/db.py` for Singleton DuckDB connection and spatial extension loading.
5. Implement `backend/app/__init__.py` as Flask app factory, initializing Flask and CORS.
6. Move route logic from `app_2d.py` to `backend/app/routes.py` using Flask Blueprint.
7. Add `backend/wsgi.py` as Gunicorn entry point, importing the app factory.
8. Add `backend/Dockerfile` to build a Python 3.10-slim container with all dependencies.

### Further Considerations
1. Should environment variables/config be handled via `.env` or Flask config class?
2. Confirm if static files or additional assets are needed in backend.
3. Consider adding tests and CI/CD setup in future phases.

