#!/usr/bin/env bash
set -euo pipefail
compose=(docker compose -p gridlock-smoke -f docker-compose.yml -f docker-compose.smoke.yml)
jar=$(mktemp)
stream=$(mktemp)
mode=${1:-http}
base=http://127.0.0.1:8088
request=(curl -fsS --retry 5 --retry-delay 1 --retry-all-errors)
if [[ "$mode" == https ]]; then
  export SMOKE_SITE_ADDRESS=localhost
  base=https://localhost:8448
  request+=(--insecure)
fi
cleanup() {
  "${compose[@]}" down
  rm -f "$jar" "$stream"
}
trap cleanup EXIT
"${compose[@]}" up -d --wait --wait-timeout 120
"${request[@]}" "$base/healthz"
"${request[@]}" "$base/" > /dev/null
"${request[@]}" -c "$jar" -X POST "$base/api/session"
"${request[@]}" -b "$jar" "$base/api/playback"
"${request[@]}" -b "$jar" -H 'Content-Type: application/json' -H "Origin: $base" -d '{"scenario_id":"line-1-2"}' "$base/api/scenario" > /dev/null
"${request[@]}" -b "$jar" -H 'Content-Type: application/json' -d '{"is_playing":false}' "$base/api/playback" > /dev/null
status=0
curl -ksS --max-time 2 -b "$jar" "$base/api/heatmap/stream" > "$stream" || status=$?
[[ "$status" == 28 || "$status" == 0 ]]
grep -q 'event: config' "$stream"
grep -q 'event: frame' "$stream"
grep -q ': heartbeat' "$stream"
if [[ "$mode" == https ]]; then
  grep -q $'\tTRUE\t' "$jar"
fi
tile=$(python3 -c 'import json; from pathlib import Path; root=Path("public/seattle/buildings"); manifest=json.loads((root/"tilejson.json").read_text()); revision=manifest["tiles"][0].split("/")[3]; print("/" + str(next((root/revision).rglob("*.pbf"))).removeprefix("public/"))')
headers=$("${request[@]}" -I "$base$tile")
grep -qi "content-encoding: gzip" <<< "$headers"
grep -qi "application/vnd.mapbox-vector-tile" <<< "$headers"
"${request[@]}" --compressed "$base$tile" > /dev/null
"${compose[@]}" exec -T frontend nginx -t
printf '\nProduction proxy, session, SSE, and vector tile checks passed.\n'
