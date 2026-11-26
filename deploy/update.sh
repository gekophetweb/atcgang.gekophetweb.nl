#!/usr/bin/env bash
# deploy/update.sh – check for a new release and deploy it safely. Meant for crontab:
#
#   */5 * * * *  /opt/atcgang/deploy/update.sh >> /var/log/atcgang/update.log 2>&1
#
# Silent when there is nothing to do; one timestamped line per step when it deploys or fails.
# Design: docs/plans/2026-11-23-concert-site-plan.md, section 2b. Usage: update.sh --help
#
# Exit codes: 0 nothing to do / deployed · 1 deploy failed, rolled back · 2 deploy and rollback failed
#             3 another run is busy · 4 config or precondition error
set -Eeuo pipefail

# Cron has a minimal PATH. Append (not prepend) so a caller's PATH still wins.
export PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_PATH=$(readlink -f "${BASH_SOURCE[0]}")
ROOT=${ATCGANG_ROOT:-$(dirname "$(dirname "$SCRIPT_PATH")")}
ORIG_ARGS=("$@")

# ---------- settings (override in $ROOT/update.conf) ----------
WEB_IMAGE_REPO=ghcr.io/gekophetweb/atcgang.gekophetweb.nl
CHANNEL=main
HEALTH_URL=https://atcgang.gekophetweb.nl/healthz
HEALTH_TIMEOUT=120
KEEP_DUMPS=5
MIN_FREE_MB=1024
NOTIFY_URL=
ERROR_NOTIFY_AFTER=2
ERROR_REPEAT_HOURS=24
STATE_DIR=$ROOT/state
LOCK_FILE=/var/lock/atcgang-update.lock
POLL_INTERVAL=2

usage() {
  cat <<'EOF'
Usage: update.sh [options]

  (none)               check for a new web image and deploy it
  --force              redeploy even if the image did not change
  --dry-run            show what would happen, change nothing
  --all                also update db (same Postgres major), cloudflared and backup
  --tag <sha>          deploy that build instead of the channel tag
  --rollback           go back to the last good image (state/last-good)
  --restore-db <file>  stop web, restore a pg_dump file, start web
  --yes                do not ask for confirmation (--restore-db)
  -h, --help           this text

Exit codes: 0 ok · 1 failed, rolled back · 2 failed and rollback failed · 3 busy · 4 config error
EOF
}

FORCE=false DRY_RUN=false ALL=false ROLLBACK=false YES=false TAG='' RESTORE_FILE=''
while (($#)); do
  case $1 in
    --force) FORCE=true ;;
    --dry-run) DRY_RUN=true ;;
    --all) ALL=true ;;
    --rollback) ROLLBACK=true ;;
    --yes | -y) YES=true ;;
    --tag) TAG=${2:?--tag needs a value}; shift ;;
    --restore-db) RESTORE_FILE=${2:?--restore-db needs a file}; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 4 ;;
  esac
  shift
done

# ---------- helpers ----------
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() {
  log "ERROR: $2" >&2
  [[ $1 != 4 ]] || report_error "$2"
  exit "$1"
}

# Exit-4 problems (git, registry, disk, dump) only reach the log, so tell someone – but only when the
# same error comes back ERROR_NOTIFY_AFTER runs in a row, and then at most every ERROR_REPEAT_HOURS.
# state/last-error: count, time of the last notification (0 = none), message.
report_error() {
  [[ ! -t 1 ]] && ! $DRY_RUN || return 0 # someone runs it by hand and sees the error
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  local f=$STATE_DIR/last-error count=0 notified=0 prev='' now
  now=$(date +%s)
  if [[ -f $f ]]; then
    { read -r count; read -r notified; read -r prev; } <"$f" || true
  fi
  if [[ $prev == "$1" ]]; then count=$((count + 1)); else count=1 notified=0; fi
  if ((count >= ERROR_NOTIFY_AFTER)) && ((notified == 0 || now - notified >= ERROR_REPEAT_HOURS * 3600)); then
    notified=$now
    notify "update failed" "$1 (failed $count runs in a row; nothing was deployed)" || true
  fi
  printf '%s\n%s\n%s\n' "$count" "$notified" "$1" >"$f"
}

# Called on success: forget the last error, and say so if we had notified about it.
clear_error() {
  local f=$STATE_DIR/last-error count notified=0
  [[ -f $f ]] && ! $DRY_RUN || return 0
  { read -r count; read -r notified; } <"$f" || true
  rm -f "$f"
  if ((notified != 0)); then
    log "update.sh works again after $count failed run(s)"
    notify "recovered" "update.sh runs normally again"
  fi
}

# Run a changing command, or only print it with --dry-run.
run() {
  if $DRY_RUN; then log "dry-run: would run: $*"; else "$@"; fi
}

dc() { docker compose --env-file "$ROOT/.env" -f "$ROOT/deploy/docker-compose.yml" "$@"; }

json_escape() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//$'\n'/\\n}"; }

# notify <title> <message> [urgent]
notify() {
  [[ -n $NOTIFY_URL ]] && ! $DRY_RUN || return 0
  local title=$1 msg=$2 prio=default text
  [[ -z ${3:-} ]] || prio=urgent
  text="atcgang: $title – $msg"
  case $NOTIFY_URL in
    https://discord.com/api/webhooks/* | https://discordapp.com/api/webhooks/*)
      curl -fsS --max-time 10 -H 'Content-Type: application/json' \
        -d "{\"content\":\"$(json_escape "$text")\"}" "$NOTIFY_URL" >/dev/null ;;
    https://hooks.slack.com/*)
      curl -fsS --max-time 10 -H 'Content-Type: application/json' \
        -d "{\"text\":\"$(json_escape "$text")\"}" "$NOTIFY_URL" >/dev/null ;;
    *) # ntfy or anything that takes a plain-text POST
      curl -fsS --max-time 10 -H "Title: atcgang: $title" -H "Priority: $prio" \
        -H 'Content-Type: text/plain' -d "$msg" "$NOTIFY_URL" >/dev/null ;;
  esac || log "warning: notification to NOTIFY_URL failed"
}

web_cid() { dc ps -q web 2>/dev/null | head -n1; }
db_running() { [[ -n $(dc ps -q --status running db 2>/dev/null) ]]; }

running_image_id() {
  local cid; cid=$(web_cid)
  [[ -n $cid ]] && docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true
}

local_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

short() { local s=${1#sha256:}; printf '%s' "${s:0:12}"; }

# Waits for the web container healthcheck, then checks HEALTH_URL through the tunnel.
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) cid status
  while :; do
    cid=$(web_cid)
    status=missing
    if [[ -n $cid ]]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing)
    fi
    case $status in
      healthy) break ;;
      unhealthy | exited | dead) log "web container is $status"; return 1 ;;
    esac
    if ((SECONDS >= deadline)); then log "web not healthy after ${HEALTH_TIMEOUT}s (status: $status)"; return 1; fi
    sleep "$POLL_INTERVAL"
  done
  if [[ -n $HEALTH_URL ]] && ! curl -fsS --max-time 10 --retry 3 --retry-delay 2 --retry-all-errors -o /dev/null "$HEALTH_URL"; then
    log "container is healthy but $HEALTH_URL is not"
    return 1
  fi
}

# up_web <image ref> [extra compose up flags]
up_web() {
  local ref=$1; shift
  $DRY_RUN && log "dry-run: web would run $ref"
  WEB_IMAGE=$ref run dc up -d --no-deps --no-build "$@" web
}

# Prints a reason and fails when STATE_DIR lacks room for a dump (database size + MIN_FREE_MB to spare).
check_disk() {
  local size_b=0 free_kb need_kb
  if db_running; then
    # shellcheck disable=SC2016 # expanded inside the db container
    size_b=$(dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_database_size(current_database())"' 2>/dev/null | tr -dc 0-9 || true)
  fi
  free_kb=$(df -Pk "$STATE_DIR" | awk 'NR == 2 { print $4 }')
  need_kb=$((${size_b:-0} / 1024 + MIN_FREE_MB * 1024))
  if ((free_kb < need_kb)); then
    echo "not enough disk space: $((free_kb / 1024)) MB free in $STATE_DIR, need $((need_kb / 1024)) MB (database $((${size_b:-0} / 1048576)) MB + MIN_FREE_MB $MIN_FREE_MB)"
    return 1
  fi
}

snapshot_db() {
  if ! db_running; then log "db is not running, skipping the database snapshot"; return 0; fi
  local dump
  dump="$STATE_DIR/pre-update-$(date +%Y%m%d-%H%M%S).dump"
  if $DRY_RUN; then log "dry-run: would dump the database to $dump"; return 0; fi
  # shellcheck disable=SC2016 # expanded inside the db container
  if ! dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dump.tmp"; then
    rm -f "$dump.tmp"
    return 1
  fi
  mv "$dump.tmp" "$dump"
  log "database snapshot: $dump ($(du -h "$dump" | cut -f1))"
  local dumps=("$STATE_DIR"/pre-update-*.dump) # sorted by name = by time
  local n=$((${#dumps[@]} - KEEP_DUMPS)) i
  for ((i = 0; i < n; i++)); do rm -f "${dumps[i]}"; done
}

# Ref to roll back to: the local :last-good tag, else the digest saved in state/last-good.
last_good_ref() {
  if [[ -n $(local_image_id "$WEB_IMAGE_REPO:last-good") ]]; then
    printf '%s' "$WEB_IMAGE_REPO:last-good"
  elif [[ -s $STATE_DIR/last-good ]]; then
    head -n1 "$STATE_DIR/last-good"
  fi
}

remember_last_good() {
  local id=$1 digest
  [[ -n $id ]] || return 0
  digest=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$id" 2>/dev/null | grep -m1 "^$WEB_IMAGE_REPO@" || true)
  run docker tag "$id" "$WEB_IMAGE_REPO:last-good"
  if ! $DRY_RUN; then printf '%s\n' "${digest:-$id}" >"$STATE_DIR/last-good"; fi
  log "last good image: ${digest:-$(short "$id")}"
}

mark_bad() { [[ -z $1 ]] || $DRY_RUN || printf '%s\n' "$1" >"$STATE_DIR/bad-image"; }

# rollback_after_failure <failed image id> – exits 1 or 2
rollback_after_failure() {
  local bad=$1 ref
  mark_bad "$bad"
  ref=$(last_good_ref)
  if [[ -z $ref ]]; then
    log "no previous image to roll back to"
    notify "SITE DOWN" "deploy of $(short "$bad") failed and there is no previous image to roll back to" urgent
    exit 2
  fi
  log "rolling back to $ref"
  if up_web "$ref" && wait_healthy; then
    log "rollback OK; $(short "$bad") is skipped until a newer image appears (or --force)"
    notify "deploy failed, rolled back" "$(short "$bad") failed its health check; back on $ref"
    exit 1
  fi
  log "ROLLBACK FAILED – the site is probably down"
  notify "SITE DOWN" "deploy of $(short "$bad") and the rollback to $ref both failed" urgent
  exit 2
}

# ---------- preconditions ----------
[[ -f $ROOT/update.conf ]] && {
  # shellcheck source=/dev/null
  . "$ROOT/update.conf"
}
for cmd in docker curl flock; do
  command -v "$cmd" >/dev/null || fail 4 "$cmd is not installed"
done
[[ -f $ROOT/.env ]] || fail 4 "$ROOT/.env is missing"
[[ -f $ROOT/deploy/docker-compose.yml ]] || fail 4 "$ROOT/deploy/docker-compose.yml is missing"
docker compose version >/dev/null 2>&1 || fail 4 "docker compose is not available"
cd "$ROOT"

# ---------- 1. lock ----------
if [[ ${ATCGANG_LOCKED:-} != 1 ]]; then
  exec 9>"$LOCK_FILE" || fail 4 "cannot open lock file $LOCK_FILE"
  flock -n 9 || exit 3
fi
mkdir -p "$STATE_DIR"

# ---------- --restore-db ----------
if [[ -n $RESTORE_FILE ]]; then
  [[ -f $RESTORE_FILE ]] || fail 4 "$RESTORE_FILE does not exist"
  db_running || fail 4 "db is not running"
  if ! $YES && ! $DRY_RUN; then
    [[ -t 0 ]] || fail 4 "--restore-db replaces the database; add --yes when not running interactively"
    read -r -p "Replace the database with $RESTORE_FILE? Type yes: " answer
    [[ $answer == yes ]] || fail 4 "cancelled"
  fi
  log "restoring the database from $RESTORE_FILE"
  disk_msg=$(check_disk) || fail 4 "$disk_msg; nothing changed"
  snapshot_db || fail 4 "could not snapshot the current database first; nothing changed"
  run dc stop web
  # pg_restore exits non-zero on harmless warnings (e.g. missing roles), so carry on and let the health check decide.
  # shellcheck disable=SC2016
  if $DRY_RUN; then log "dry-run: would pg_restore $RESTORE_FILE"
  elif ! dc exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' <"$RESTORE_FILE"; then
    log "pg_restore reported warnings or errors (see above)"
  fi
  run dc start web
  $DRY_RUN && exit 0
  wait_healthy || { notify "SITE DOWN" "web is not healthy after a database restore" urgent; fail 2 "web is not healthy after the restore"; }
  log "restore done"
  notify "database restored" "from $(basename "$RESTORE_FILE")"
  exit 0
fi

# ---------- --rollback ----------
if $ROLLBACK; then
  ref=$(last_good_ref)
  [[ -n $ref ]] || fail 4 "no last good image recorded in $STATE_DIR/last-good"
  current=$(running_image_id)
  log "manual rollback to $ref"
  mark_bad "$current"
  up_web "$ref"
  $DRY_RUN && exit 0
  if wait_healthy; then
    log "rollback OK"
    notify "rolled back" "manual rollback to $ref"
    exit 0
  fi
  notify "SITE DOWN" "manual rollback to $ref is not healthy" urgent
  fail 2 "web is not healthy after the rollback"
fi

# ---------- 2. update the deploy files ----------
STACK_CHANGED=false
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  before=$(git -C "$ROOT" rev-parse HEAD)
  if $DRY_RUN; then
    git -C "$ROOT" fetch -q || fail 4 "git fetch failed"
    behind=$(git -C "$ROOT" rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
    ((behind == 0)) || log "dry-run: would git pull $behind commit(s)"
    after=$(git -C "$ROOT" rev-parse '@{u}' 2>/dev/null || echo "$before")
  else
    git -C "$ROOT" pull --ff-only -q || fail 4 "git pull --ff-only failed in $ROOT (local changes or diverged history?)"
    after=$(git -C "$ROOT" rev-parse HEAD)
  fi
  if [[ $before != "$after" ]]; then
    if ! git -C "$ROOT" diff --quiet "$before" "$after" -- deploy/docker-compose.yml backup; then
      STACK_CHANGED=true
    fi
    # A newer update.sh came in: run that one instead (we keep the lock).
    if ! $DRY_RUN && [[ ${ATCGANG_REEXEC:-} != 1 ]] && ! git -C "$ROOT" diff --quiet "$before" "$after" -- deploy/update.sh; then
      log "update.sh changed, restarting with the new version"
      ATCGANG_REEXEC=1 ATCGANG_LOCKED=1 exec "$SCRIPT_PATH" "${ORIG_ARGS[@]}"
    fi
  fi
fi

# ---------- 3. check for a new image ----------
TARGET=$WEB_IMAGE_REPO:${TAG:-$CHANNEL}
current_id=$(running_image_id)
bad_id=$(head -n1 "$STATE_DIR/bad-image" 2>/dev/null || true)

if $DRY_RUN; then
  remote=$(docker buildx imagetools inspect "$TARGET" --format '{{.Manifest.Digest}}' 2>/dev/null || true)
  current_digests=$( [[ -n $current_id ]] && docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$current_id" 2>/dev/null || true)
  if [[ -z $remote ]]; then
    log "dry-run: cannot read $TARGET from the registry without pulling"
    new_id=unknown
  elif grep -qx "$WEB_IMAGE_REPO@$remote" <<<"$current_digests"; then
    new_id=$current_id
  else
    new_id=$remote
  fi
else
  dc_pull_out=$(WEB_IMAGE=$TARGET dc pull -q web 2>&1) || fail 4 "could not pull $TARGET: $dc_pull_out"
  new_id=$(local_image_id "$TARGET")
  [[ -n $new_id ]] || fail 4 "pulled $TARGET but cannot find it locally"
fi

WEB_CHANGED=false
if [[ $new_id != "$current_id" ]] || $FORCE; then WEB_CHANGED=true; fi
if $WEB_CHANGED && ! $FORCE && [[ -n $bad_id && $new_id == "$bad_id" ]]; then
  WEB_CHANGED=false # this image already failed once; wait for a newer one
fi

if ! $WEB_CHANGED && ! $STACK_CHANGED && ! $ALL; then
  $DRY_RUN && log "dry-run: nothing to do (web is up to date)"
  clear_error
  exit 0
fi

log "update: web $(short "${current_id:-none}") -> $(short "$new_id")$($WEB_CHANGED || echo ' (unchanged)')$($STACK_CHANGED && echo ', deploy files changed')$($ALL && echo ', --all')"

# ---------- 4. remember the current version ----------
remember_last_good "$current_id"
# Keep web on its current image when only other services change.
if $WEB_CHANGED; then WEB_REF=$TARGET; else WEB_REF=$WEB_IMAGE_REPO:last-good; fi
[[ -n $current_id ]] || WEB_REF=$TARGET

# ---------- 5. snapshot the database ----------
disk_msg=$(check_disk) || fail 4 "$disk_msg; not updating"
snapshot_db || fail 4 "database snapshot failed; not updating"

# ---------- 6. deploy ----------
if $ALL || $STACK_CHANGED; then
  if $ALL; then
    run dc pull -q db cloudflared
  fi
  run dc build -q --pull backup
  WEB_IMAGE=$WEB_REF run dc up -d --no-build
  if $WEB_CHANGED && $FORCE; then up_web "$WEB_REF" --force-recreate; fi
else
  if $FORCE; then up_web "$WEB_REF" --force-recreate; else up_web "$WEB_REF"; fi
fi

if $DRY_RUN; then
  log "dry-run: would wait for web to be healthy, check $HEALTH_URL and roll back on failure"
  exit 0
fi

# ---------- 7. health check / 8. roll back ----------
if ! wait_healthy; then
  if $WEB_CHANGED && [[ -n $current_id ]]; then
    rollback_after_failure "$new_id"
  elif $WEB_CHANGED; then
    rollback_after_failure "$new_id" # first deploy: nothing to go back to → exit 2
  fi
  notify "SITE DOWN" "web is unhealthy after updating the other services (web image unchanged)" urgent
  fail 2 "web is unhealthy after updating the other services"
fi
if $WEB_CHANGED; then rm -f "$STATE_DIR/bad-image"; fi

# ---------- 9. clean up ----------
docker image prune -f --filter until=168h >/dev/null 2>&1 || log "warning: image prune failed"

# ---------- 10. report ----------
log "deploy OK: web $(short "$new_id")"
clear_error
notify "deployed" "web $(short "$new_id") is live$($ALL && echo ' (with --all)')"
exit 0
