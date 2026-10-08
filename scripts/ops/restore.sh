#!/usr/bin/env bash
# Restores a dump made by backup.sh (docs/operations.md, "Restore").
#
#   scripts/ops/restore.sh verify  <dump>            restore into a scratch database, check it, drop it (safe: changes nothing)
#   scripts/ops/restore.sh replace <dump> --yes      REPLACE the live database with the dump (stops api, worker and web)
#
# `verify` is what a restore drill runs: it proves the dump restores and holds what a dashboard needs. `replace` is the
# real thing, after a loss.
set -euo pipefail

compose=(docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}" ${COMPOSE_ENV_FILE:+--env-file "$COMPOSE_ENV_FILE"})
mode="${1:-}"
dump="${2:-}"

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }
[ -n "$mode" ] && [ -f "$dump" ] || usage

psql_owner() { "${compose[@]}" exec -T postgres psql -U aipr -v ON_ERROR_STOP=1 "$@"; }

restore_into() { # database name: create it empty, load the dump
  psql_owner -d postgres -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" >/dev/null
  psql_owner -d postgres -c "CREATE DATABASE \"$1\"" >/dev/null
  "${compose[@]}" exec -T postgres pg_restore -U aipr -d "$1" --no-owner --no-privileges --exit-on-error <"$dump"
}

case "$mode" in
  verify)
    scratch="aipr_restore_check"
    trap 'psql_owner -d postgres -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
    restore_into "$scratch"
    echo "Restored into a scratch database. Checking what a dashboard needs..."
    # The schema is at the latest migration, and the tables the dashboard reads are there and readable.
    psql_owner -d "$scratch" -At <<'SQL'
select 'migrations applied: ' || count(*) from drizzle.__drizzle_migrations;
select 'installations: ' || count(*) from installations;
select 'repositories: ' || count(*) from repositories;
select 'review runs: ' || count(*) from review_runs;
select 'findings: ' || count(*) from findings;
select 'stored provider keys: ' || count(*) from provider_credentials;
select 'row-level security policies: ' || count(*) from pg_policies where policyname = 'tenant_scope';
SQL
    echo "Restore verified. The scratch database was dropped."
    ;;

  replace)
    [ "${3:-}" = "--yes" ] || { echo "This replaces the live database with the dump. Add --yes to go ahead." >&2; exit 64; }
    echo "Stopping web, api and worker..."
    "${compose[@]}" stop web api worker
    restore_into aipr
    # A re-created database has none of the grants the api and the worker role needs (and the dump carries none).
    echo "Granting the application role its privileges..."
    psql_owner -d aipr <"$(dirname "$0")/../../docker/postgres/grants.sql" >/dev/null
    echo "Applying any migrations newer than the dump..."
    "${compose[@]}" run --rm migrate
    echo "Starting the stack..."
    "${compose[@]}" up -d
    echo "Restored. Runs that were queued or running at backup time are picked up again by the worker's sweeper."
    ;;

  *) usage ;;
esac
