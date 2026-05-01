#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKEND_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -f "$BACKEND_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$BACKEND_DIR/.env"
  set +a
fi

: "${DAACS_DATABASE_URL:=sqlite:./daacs.db}"
: "${DAACS_AUTH_HOST:=127.0.0.1}"
: "${DAACS_AUTH_PORT:=8001}"

if [ "${DAACS_JWT_SECRET:-}" = "" ]; then
  printf '%s\n' "DAACS_JWT_SECRET is required. Copy backend/.env.example to backend/.env and set a 32+ character secret." >&2
  exit 1
fi

if [ "${#DAACS_JWT_SECRET}" -lt 32 ]; then
  printf '%s\n' "DAACS_JWT_SECRET must be at least 32 characters long." >&2
  exit 1
fi

cd "$BACKEND_DIR"
export DAACS_DATABASE_URL DAACS_AUTH_HOST DAACS_AUTH_PORT DAACS_JWT_SECRET
exec cargo run --manifest-path "$BACKEND_DIR/Cargo.toml" --bin daacs-auth-api
