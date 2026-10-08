#!/usr/bin/env bash
# Dumps the PostgreSQL database of the production stack to a file (docs/operations.md, "Backups").
#
#   scripts/ops/backup.sh [output-directory]        default: ./backups
#
# The dump is PostgreSQL's custom format (compressed, restorable selectively). It holds the run history, settings,
# audit log and the provider keys as ENCRYPTED blobs: it is useless without secrets/encryption_key, which is not in it
# and must be backed up separately and stored apart from the dumps. Redis is not backed up: it only carries jobs, and
# the queue is rebuilt from the database.
set -euo pipefail

compose=(docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}" ${COMPOSE_ENV_FILE:+--env-file "$COMPOSE_ENV_FILE"})
out="${1:-backups}"
umask 077
mkdir -p "$out"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out/aipr-$stamp.dump"

# Dump to a temporary name first: a half-written file must never look like a backup.
"${compose[@]}" exec -T postgres pg_dump -U aipr -d aipr --format=custom --no-owner --no-privileges >"$file.partial"
mv "$file.partial" "$file"

# A dump that cannot be listed is not a backup.
"${compose[@]}" exec -T postgres pg_restore --list <"$file" >/dev/null

echo "Backup written: $file ($(wc -c <"$file") bytes)"
