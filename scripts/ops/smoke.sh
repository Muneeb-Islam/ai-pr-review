#!/usr/bin/env bash
# Smoke test of the production stack (docker-compose.prod.yml): builds the images, starts everything with generated
# secrets and made-up GitHub values, and checks what a deployment must get right. Used by CI, and by an operator who
# wants to see the stack work on a scratch host before real secrets are involved. Removes everything it created.
#
#   bash scripts/ops/smoke.sh
#
# It uses the project directory's ./secrets and ./.env.production only if they do not exist yet, and deletes them
# afterwards in that case; it never touches files that were already there.
set -euo pipefail
cd "$(dirname "$0")/../.."

port="${SMOKE_PORT:-18080}"
base="http://127.0.0.1:$port"
export COMPOSE_FILE=docker-compose.prod.yml COMPOSE_ENV_FILE=.env.production
compose=(docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE")

made_secrets=0
made_env=0
cleanup() {
  status=$?
  "${compose[@]}" logs --no-color --tail 40 api worker migrate 2>/dev/null | sed 's/^/    /' || true
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  [ "$made_secrets" = 1 ] && rm -rf secrets
  [ "$made_env" = 1 ] && rm -f .env.production
  exit $status
}
trap cleanup EXIT

if [ ! -e secrets ]; then
  made_secrets=1
  bash scripts/ops/init-secrets.sh >/dev/null || true # exits 2 until the GitHub files exist
  openssl genrsa -out secrets/github_app_private_key 2048 2>/dev/null
  printf 'smoke-client-secret-0123456789' >secrets/github_client_secret
  chmod 644 secrets/*
fi
if [ ! -e .env.production ]; then
  made_env=1
  cat >.env.production <<ENV
PUBLIC_URL=http://localhost:$port
GITHUB_APP_ID=12345
GITHUB_CLIENT_ID=Iv1.smoke
WEB_PORT=$port
VERSION=smoke
ENV
fi

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; exit 1; }
expect_status() { # description url expected-status [curl args...]
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' "${@:4}" "$2")"
  [ "$got" = "$3" ] && pass "$1" || fail "$1: expected $3, got $got"
}

echo "Building the images and starting the stack..."
"${compose[@]}" up -d --build --wait --wait-timeout 300

expect_status "the web server answers" "$base/nginx-health" 200
expect_status "readiness through the proxy (PostgreSQL and Redis)" "$base/readyz" 200
expect_status "the single-page app is served for a route" "$base/runs/anything" 200
expect_status "metrics are not reachable from outside" "$base/metrics" 404
expect_status "a webhook with a bad signature is refused" "$base/webhooks/github" 401 \
  -X POST -H 'content-type: application/json' -H 'x-github-event: ping' -H 'x-github-delivery: smoke' -d '{}'
expect_status "the API refuses an anonymous caller" "$base/api/me" 401

headers="$(curl -sI "$base/")"
for h in "content-security-policy: default-src 'self'; script-src 'self'" "strict-transport-security" "x-frame-options: DENY" "x-content-type-options: nosniff" "referrer-policy"; do
  echo "$headers" | grep -qi "$h" && pass "header: $h" || fail "missing header: $h"
done
echo "$headers" | grep -qi "unsafe-inline" && fail "the CSP allows inline code" || pass "the CSP has no unsafe-inline"

# The services run as unprivileged users, with the application database role under row-level security.
for service in api worker; do
  user="$("${compose[@]}" exec -T "$service" id -u)"
  [ "$user" != "0" ] && pass "$service runs as uid $user" || fail "$service runs as root"
done
"${compose[@]}" logs api 2>&1 | grep -q "Row-level security is enforced" && pass "row-level security is enforced for the api's role" \
  || fail "row-level security is not enforced"

# Metrics, from inside the network, with the token.
token="$(cat secrets/metrics_token)"
metrics="$("${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/metrics',{headers:{authorization:'Bearer $token'}}).then(r=>r.text()).then(t=>console.log(t))")"
echo "$metrics" | grep -q '^aipr_row_level_security_enforced 1$' && pass "metrics: isolation enforced" || fail "metrics: isolation flag"
echo "$metrics" | grep -q '^aipr_dependency_up{dependency="redis"} 1$' && pass "metrics: Redis reachable" || fail "metrics: Redis"

# Data written as the owner is served by the dashboard through the real stack (grants, policies, proxy, api).
"${compose[@]}" exec -T postgres psql -U aipr -d aipr -v ON_ERROR_STOP=1 -q -c \
  "insert into installations (github_installation_id, account_login, account_type) values (1, 'smoke', 'organization');
   insert into repositories (installation_id, github_repo_id, full_name, default_branch, is_private)
     select id, 1, 'smoke/api', 'main', true from installations;"
node scripts/ops/dashboard-check.mjs --url "$base" && pass "the dashboard serves what the database holds"

# Backup and restore, end to end.
dump_dir="$(mktemp -d)"
bash scripts/ops/backup.sh "$dump_dir" && pass "backup written"
bash scripts/ops/restore.sh verify "$dump_dir"/*.dump >/dev/null && pass "the backup restores into a scratch database"
rm -rf "$dump_dir"

echo "The production stack works."
