#!/usr/bin/env bash
# Creates a local Homebrew Postgres database Rusty Pythia can query against.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

DB_NAME="${RUSTY_PYTHIA_PG_DATABASE:-rusty_pythia_test}"
DB_USER="${RUSTY_PYTHIA_PG_USER:-rustypythia}"
DB_PASSWORD="${RUSTY_PYTHIA_PG_PASSWORD:-pythia_local}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Install it from https://brew.sh then re-run this script." >&2
  exit 1
fi

if ! brew list postgresql@16 >/dev/null 2>&1 && ! brew list postgresql@17 >/dev/null 2>&1 && ! brew list postgresql >/dev/null 2>&1; then
  brew install postgresql@16
  brew link --force postgresql@16
fi

if brew services list | grep -Eq 'postgresql(@[0-9]+)?[[:space:]].*started'; then
  echo "Postgres service is already running."
else
  if brew list postgresql@16 >/dev/null 2>&1; then
    brew services start postgresql@16
  elif brew list postgresql@17 >/dev/null 2>&1; then
    brew services start postgresql@17
  else
    brew services start postgresql
  fi
fi

until pg_isready >/dev/null 2>&1; do
  sleep 1
done

# Local socket connections as the Mac user are typically trusted, which is
# enough to create a dedicated role the app can log in with over TCP.
psql -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  createdb -O "${DB_USER}" "${DB_NAME}"
fi

psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${SCRIPT_DIR}/seed-postgres.sql"
psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA xo TO ${DB_USER};"
psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA xo TO ${DB_USER};"

echo
echo "Postgres test database is ready."
echo "  Host:     localhost"
echo "  Port:     5432"
echo "  Database: ${DB_NAME}"
echo "  Username: ${DB_USER}"
echo "  Password: ${DB_PASSWORD}"
echo "Add that as a Postgres connection in Rusty Pythia, then run:"
echo "  SELECT * FROM xo.task_definition;"
