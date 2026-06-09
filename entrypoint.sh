#!/bin/bash
set -e

MODE="${MODE:-web}"
PORT="${PORT:-5000}"

if [ "$MODE" = "backend" ]; then
  echo "Starting backend on port ${PORT}..."
  exec gunicorn --bind "0.0.0.0:${PORT}" wsgi:application
elif [ "$MODE" = "web" ]; then
  echo "Serving web application on port ${PORT}..."
  exec python3 /app/serve_web.py "${PORT}"
else
  echo "Unknown mode: ${MODE}. Use 'web' or 'backend'."
  exit 1
fi
