#!/usr/bin/env bash
set -euo pipefail

revision=${1:?Verified commit SHA is required}
previous=${2:?Previous commit SHA is required}
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$previous" =~ ^[a-f0-9]{40}$ ]]
git cat-file -e "$revision^{commit}"
mkdir -p .deploy
exec 9>.deploy/lock
flock 9

project=$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
docker compose config > .deploy/rollback-compose.yml
for service in frontend backend; do
  container=$(docker compose ps -q "$service")
  if [[ -z "$container" ]]; then
    printf '%s\n' "Cannot prepare rollback: $service is not running" >&2
    exit 1
  fi
  if [[ -n "$container" ]]; then
    image=$(docker inspect --format '{{.Image}}' "$container")
    docker tag "$image" "gridlock-$service:rollback"
  fi
done
cat > .deploy/rollback-images.yml <<'YAML'
services:
  frontend:
    image: gridlock-frontend:rollback
  backend:
    image: gridlock-backend:rollback
YAML

rollback() {
  trap - ERR
  git reset --hard "$previous"
  docker compose --project-directory "$PWD" -p "$project" -f .deploy/rollback-compose.yml -f .deploy/rollback-images.yml up -d --no-build --wait --wait-timeout 120
  printf '%s\n' "Deployment failed; restored $previous" >&2
  exit 1
}
trap rollback ERR
git reset --hard "$revision"
export GRIDLOCK_TAG="$revision"
docker compose build
docker compose up -d --no-build --wait --wait-timeout 120
site=$(docker compose exec -T caddy printenv SITE_ADDRESS)
if [[ "$site" == ':80' ]]; then
  base=http://127.0.0.1
else
  base="https://${site#https://}"
fi
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors "$base/healthz" > /dev/null
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors "$base/" > /dev/null
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors -c "$jar" -X POST "$base/api/session" > /dev/null
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors -b "$jar" "$base/api/playback" > /dev/null
printf '%s\n' "$revision" > .deploy/current
printf '%s\n' "$previous" > .deploy/previous
trap - ERR
