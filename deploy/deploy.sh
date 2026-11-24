#!/usr/bin/env bash
# Pull-based deploy for the home server. Run by atcgang-deploy.timer every 5 minutes, or by hand.
# Pulls web:main; if the image changed, restarts web, checks /healthz, and rolls back on failure.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=${WEB_IMAGE:-ghcr.io/gekophetweb/atcgang.gekophetweb.nl:main}
REPO=${IMAGE%:*}

current=$(docker compose images web --format json 2>/dev/null | grep -o '"ID":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)
docker pull -q "$IMAGE" >/dev/null
latest=$(docker image inspect "$IMAGE" --format '{{.Id}}')

if [ "$current" = "$latest" ]; then exit 0; fi
echo "deploying $latest (was ${current:-none})"
if [ -n "$current" ]; then docker tag "$current" "$REPO:previous"; fi

check() {
  for _ in $(seq 1 30); do
    if docker compose exec -T web curl -fsS http://localhost:3000/healthz >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

WEB_IMAGE=$IMAGE docker compose up -d web
if check; then
  echo "deploy ok"
  docker image prune -f >/dev/null
else
  echo "healthcheck failed, rolling back" >&2
  if [ -n "$current" ]; then WEB_IMAGE="$REPO:previous" docker compose up -d web; fi
  exit 1
fi
