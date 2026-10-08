#!/usr/bin/env bash
# Creates the secret files of the production stack (docs/operations.md) in ./secrets (or the directory given).
# Random secrets are generated here and never printed; secrets that GitHub issues you must put there yourself.
# Existing files are never overwritten, so running it again only fills in what is missing.
#
#   scripts/ops/init-secrets.sh [secrets-dir]
set -euo pipefail

dir="${1:-secrets}"
# The directory is private to you. The files are readable inside it: Docker bind-mounts each one into the containers,
# where the services run as an unprivileged user that is not you, and a 0600 file owned by you would be unreadable there.
mkdir -p "$dir"
chmod 700 "$dir"

created=()
write_if_missing() { # name, value
  local file="$dir/$1"
  if [ -e "$file" ]; then return; fi
  (umask 022 && printf '%s' "$2" >"$file")
  created+=("$1")
}
read_secret() { cat "$dir/$1"; }

hex() { openssl rand -hex "$1"; }

write_if_missing postgres_owner_password "$(hex 24)"
write_if_missing postgres_app_password "$(hex 24)"
write_if_missing redis_password "$(hex 24)"
write_if_missing session_secret "$(openssl rand -base64 48 | tr -d '\n')"
write_if_missing encryption_key "$(openssl rand -base64 32 | tr -d '\n')"
write_if_missing metrics_token "$(hex 24)"
write_if_missing github_webhook_secret "$(hex 32)"

# Connection strings: the passwords are hex, so they need no URL escaping. The api and the worker connect as the plain
# role `aipr_app`; only the migration connects as the owner.
write_if_missing database_url "postgres://aipr_app:$(read_secret postgres_app_password)@postgres:5432/aipr"
write_if_missing migration_database_url "postgres://aipr:$(read_secret postgres_owner_password)@postgres:5432/aipr"
write_if_missing redis_url "redis://:$(read_secret redis_password)@redis:6379"
write_if_missing redis_conf "requirepass $(read_secret redis_password)"

if [ "${#created[@]}" -gt 0 ]; then
  echo "Created in $dir/: ${created[*]}"
else
  echo "Nothing to create: every generated secret already exists in $dir/."
fi

missing=()
for name in github_app_private_key github_client_secret; do
  [ -e "$dir/$name" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo
  echo "Still to do: GitHub issues these, so put them there yourself (docs/operations.md, \"GitHub App\"):"
  for name in "${missing[@]}"; do echo "  $dir/$name"; done
  echo "  github_app_private_key  the .pem file of the App, as it was downloaded"
  echo "  github_client_secret    the App's client secret"
  echo "Set the App's webhook secret to the content of $dir/github_webhook_secret."
  exit 2
fi
echo "All secret files are in place. Back them up with the database dumps: losing encryption_key makes every stored provider key unreadable."
