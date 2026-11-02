#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Test the self-hosting image: build it once, start it twice with different settings (name,
# theme, colour, icon, BASE_PATH, DB_NAME) behind Caddy and check that each start wrote its
# settings into the app and that the app loads under its path. Then run the headless e2e tests
# (real WebSocket clients) against the container and validate docker-compose.yaml.
# Needs Docker. Compact output like scripts/test.sh.
set -uo pipefail
cd "$(dirname "$0")/.."

image=bardesk-selfhost-test
name=bardesk-selfhost-test
port=18780 # the app
web=18781  # Caddy in front of it
logs=$(mktemp -d)
cleanup() {
  docker rm -f "$name" "$name-caddy" >/dev/null 2>&1
  docker network rm "$name" >/dev/null 2>&1
  rm -rf "$logs"
}
trap cleanup EXIT
fail() { echo "✗ $1"; [[ -f "$logs/$2" ]] && sed 's/^/    /' "$logs/$2" | tail -n 30; exit 1; }

docker build -q -t "$image" . >"$logs/build" 2>&1 || fail "build" build
echo "✓ build"

# the Caddyfile from docker-compose.yaml (BASE_PATH filled in), for a local Caddy on plain HTTP
caddyfile() {
  printf 'DOMAIN=:80\nBASE_PATH=%s\n' "$1" >"$logs/.env"
  docker run --rm -v "$PWD/docker-compose.yaml:/w/docker-compose.yaml:ro" -v "$logs/.env:/w/.env:ro" -w /w \
    docker:cli docker compose config --format json >"$logs/compose" 2>&1 &&
    python3 -c 'import json,sys; print(json.load(sys.stdin)["configs"]["caddyfile"]["content"])' \
      <"$logs/compose" >"$logs/Caddyfile"
}

# start <BASE_PATH> <settings...>: the app (as "app", like in docker-compose.yaml) and Caddy
start() {
  local path=$1
  shift
  docker rm -f "$name" "$name-caddy" >/dev/null 2>&1
  # no mail server: codes go to the log; version check off (the Node test clients are 'dev')
  docker run -d --name "$name" --network "$name" --network-alias app -p "127.0.0.1:$port:8000" \
    -v "$logs/branding:/app/branding:ro" -e FRONTEND_VERSION_FILE=/nonexistent -e BASE_PATH="$path" "$@" "$image" \
    >/dev/null || fail "run" none
  caddyfile "$path" || fail "Caddyfile from docker-compose.yaml" compose
  docker run -d --name "$name-caddy" --network "$name" -p "127.0.0.1:$web:80" \
    -v "$logs/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 >/dev/null || fail "caddy" none
  for _ in $(seq 50); do curl -sf "http://127.0.0.1:$web${path}api/health" >/dev/null && break; sleep 0.2; done
  docker logs "$name" >"$logs/server" 2>&1
}

# the page under its path and every file it links to (relative to <base href>), plus the
# service worker, the version and the icons; a client route gets the page
serving() {
  local url=$1 page ref
  page=$(curl -sf "$url") || { echo "no page at $url"; return 1; }
  for ref in $(grep -oE '(src|href)="[^"/][^"]*"' <<<"$page" | sed -E 's/^(src|href)="//; s/"$//') \
    sw.js version.json icons/icon-192.png icons/icon-512.png; do
    curl -sf -o /dev/null "$url$ref" || { echo "missing: $url$ref"; return 1; }
  done
  curl -sf "${url}group" | grep -q '<div id="app">' || { echo "no page for a client route"; return 1; }
}

# settings: one image, two starts
docker network create "$name" >/dev/null || fail "network" none
mkdir -p "$logs/branding" "$logs/a" "$logs/b"
for run in a b; do
  if [[ $run == a ]]; then
    path=/ base="http://127.0.0.1:$web/"
    start / -e APP_NAME='Docker Test Tab' -e THEME=dark -e COLOR_PRIMARY='#123456' -e DB_NAME=first
  else
    # an own icon, made with the image's Pillow
    docker run --rm --user "$(id -u):$(id -g)" --entrypoint python -v "$logs/branding:/b" "$image" \
      -c "from PIL import Image; Image.new('RGB', (600, 600), '#00ff00').save('/b/icon.png')" ||
      fail "icon" none
    path=/pub/ base="http://127.0.0.1:$web/pub/"
    start /pub/ -e APP_NAME='Second Tab' -e DB_NAME=second
  fi
  serving "$base" >"$logs/serving" 2>&1 || fail "serving under $path" serving
  for file in index.html manifest.webmanifest config.js version.json icons/icon-192.png; do
    curl -sf "$base$file" >"$logs/$run/$(basename "$file")"
  done
done
echo "✓ serving  one image, started under / and /pub/: the page and all its files load"

a=$logs/a b=$logs/b
build_a=$(grep -o '"version": "[^"]*' "$a/version.json" | cut -d'"' -f4)
build_b=$(grep -o '"version": "[^"]*' "$b/version.json" | cut -d'"' -f4)
checks=(
  "page A:$(grep -c '<title>Docker Test Tab</title>' "$a/index.html")"
  "theme A:$(grep -c 'data-theme="dark" style="--color-primary: #123456' "$a/index.html")"
  "base A:$(grep -c '<base href="/" />' "$a/index.html")"
  "page B:$(grep -c '<title>Second Tab</title>' "$b/index.html")"
  "theme B:$(grep -c 'data-theme="light" style="--color-primary: #d5121e' "$b/index.html")"
  "base B:$(grep -c '<base href="/pub/" />' "$b/index.html")"
  "manifest A:$(grep -c '"name": "Docker Test Tab".*"scope": "/"' "$a/manifest.webmanifest")"
  "manifest B:$(grep -c '"name": "Second Tab".*"scope": "/pub/"' "$b/manifest.webmanifest")"
  "config A:$(grep -c '"dbName": "first", "version": "'"$build_a"'"' "$a/config.js")"
  "config B:$(grep -c '"dbName": "second", "version": "'"$build_b"'"' "$b/config.js")"
  "icons differ:$(cmp -s "$a/icon-192.png" "$b/icon-192.png" || echo 1)"
  "version: same build, other settings:$([[ ${build_a%.*} == "${build_b%.*}" && $build_a != "$build_b" ]] && echo 1)"
)
for check in "${checks[@]}"; do [[ "${check##*:}" -ge 1 ]] 2>/dev/null || fail "settings (${check%%:*})" server; done

# a restart renders the same settings again: same files, same version
docker restart "$name" >/dev/null
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break; sleep 0.2; done
[[ "$(curl -s "http://127.0.0.1:$port/version.json")" == "$(cat "$b/version.json")" ]] || fail "restart" none
echo "✓ settings page, manifest, config, icons and version follow the settings; a restart keeps them"

base="http://127.0.0.1:$port"
checks=(
  "asset cached:$(curl -sI "$base/$(grep -o 'assets/index-[^"]*\.js' "$b/index.html" | head -1)" | grep -ci 'immutable')"
  "page revalidated:$(curl -sI "$base/" | grep -ci 'cache-control: no-cache')"
  "config revalidated:$(curl -sI "$base/config.js" | grep -ci 'cache-control: no-cache')"
)
for check in "${checks[@]}"; do [[ "${check##*:}" -ge 1 ]] || fail "cache headers (${check%%:*})" none; done
echo "✓ cache    hashed assets immutable, page and config revalidated"

docker logs -f "$name" >"$logs/server" 2>&1 &
(cd frontend && E2E_URL="$base" E2E_LOG="$logs/server" npx vitest run src/core/e2e.test.ts --reporter=dot) \
  >"$logs/e2e" 2>&1 || fail "e2e" e2e
echo "✓ e2e      $(grep -E '^ +Tests ' "$logs/e2e" | sed -E 's/ +/ /g; s/^ //')"

for path in / /tab/; do
  caddyfile "$path" || fail "Caddyfile from docker-compose.yaml" compose
  docker run --rm -v "$logs/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$logs/caddy" 2>&1 || fail "Caddyfile ($path)" caddy
done
echo "✓ caddy    Caddyfile in docker-compose.yaml valid for / and /tab/"

cp .env.example "$logs/.env"
docker run --rm -v "$PWD/docker-compose.yaml:/w/docker-compose.yaml:ro" -v "$logs/.env:/w/.env:ro" -w /w \
  docker:cli docker compose config >"$logs/compose" 2>&1 || fail "docker-compose.yaml" compose
docker run --rm -v "$PWD/docker-compose.yaml:/w/docker-compose.yaml:ro" -v "$logs/.env:/w/.env:ro" \
  -v "$PWD/compose.override.example.yaml:/w/compose.override.yaml:ro" -w /w \
  docker:cli docker compose config >"$logs/compose" 2>&1 || fail "compose.override.example.yaml" compose
grep -q 'context: /w' "$logs/compose" || fail "compose.override.example.yaml (build)" compose
echo "✓ compose  docker-compose.yaml valid with .env.example, also with compose.override.example.yaml"
