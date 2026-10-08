#!/bin/sh
# Runs once, when the database volume is created (docker-entrypoint-initdb.d, before 20-grants.sql). Creates the role the
# api and the worker connect as: a plain role, neither superuser nor owner of any table, so the tenant row-level-security
# policies of migration 0006 apply to it. The bootstrap role (POSTGRES_USER) owns the tables and is only used to migrate.
set -eu

APP_PASSWORD="$(cat /run/secrets/postgres_app_password)"

psql -v ON_ERROR_STOP=1 -v app_password="$APP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE aipr_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
