#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Run all checks (backend pytest, frontend vitest, type-checked build) before every deploy.
#
# Output is compact on purpose: one line per suite when it passes, and only the
# failing tests / errors when it does not. Pass -v for the full output.
set -uo pipefail
cd "$(dirname "$0")/.."

verbose=0
[[ "${1:-}" == "-v" ]] && verbose=1

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
status=0

# run <name> <summary-filter> <failure-filter> <command...>
run() {
  local name=$1 summary=$2 failure=$3
  shift 3
  if "$@" >"$logs/$name" 2>&1; then
    printf '✓ %-8s %s\n' "$name" "$(eval "$summary" <"$logs/$name")"
  else
    status=1
    printf '✗ %s\n' "$name"
    eval "$failure" <"$logs/$name" | sed 's/^/    /'
  fi
  if ((verbose)); then cat "$logs/$name"; fi
}

run backend \
  'tail -n 1' \
  'grep -E "^(FAILED|ERROR)|^E |Error" | head -n 30' \
  bash -c 'cd backend && ./venv/bin/python -m pytest tests/ -q --tb=line -p no:cacheprovider'

run frontend \
  'grep -E "^ +Tests " | sed -E "s/ +/ /g; s/^ //"' \
  'grep -vE "^ *(✓|RUN|Duration|Start at|$)" | head -n 60' \
  bash -c 'cd frontend && npx vitest run --reporter=dot'

# e2e: real WebSocket clients (Node) against a real uvicorn with a temp DB.
# No mail server (SMTP_HOST empty), so login codes land in the server log, where the test reads them.
e2e() {
  local dir port=18765 pid rc
  dir=$(mktemp -d)
  (cd backend && SMTP_HOST= AUTH_RATE_LIMIT_PER_MINUTE=0 DATABASE_URL="sqlite:///$dir/e2e.db" \
    exec ./venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $port) >"$dir/server.log" 2>&1 &
  pid=$!
  for _ in $(seq 50); do
    curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
    sleep 0.1
  done
  (cd frontend && E2E_URL="http://127.0.0.1:$port" E2E_LOG="$dir/server.log" \
    npx vitest run src/core/e2e.test.ts --reporter=dot)
  rc=$?
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -rf "$dir"
  return $rc
}

run e2e \
  'grep -E "^ +Tests " | sed -E "s/ +/ /g; s/^ //"' \
  'grep -vE "^ *(✓|RUN|Duration|Start at|$)" | head -n 60' \
  e2e

# ui: Playwright (headless mobile Chromium), starts its own backend + Vite (playwright.config.ts)
run ui \
  'grep -E "[0-9]+ passed" | tail -n 1 | sed -E "s/^ +//"' \
  'grep -E "✘|Error:|Expected|Received|^ +[0-9]+\) " | grep -v WebServer | head -n 40' \
  bash -c 'cd frontend && npx playwright test'

run build \
  'echo ok' \
  'grep -E "error|Error" | head -n 30' \
  bash -c 'cd frontend && npm run build --silent'

exit $status
