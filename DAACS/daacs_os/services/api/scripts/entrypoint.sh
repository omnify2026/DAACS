#!/bin/sh
set -e
cd /app
if [ -z "$SKIP_ALEMBIC" ]; then
  echo "Running database migrations..."
  alembic upgrade head
  echo "Migrations complete."
fi
exec uvicorn daacs.server:app --host 0.0.0.0 --port 8001 --reload
