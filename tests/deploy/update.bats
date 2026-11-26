#!/usr/bin/env bats
# Tests for deploy/update.sh with stubbed docker, git and curl (tests/deploy/stubs). Run: bats tests/deploy

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../deploy/update.sh"
  ROOT="$BATS_TEST_TMPDIR/root"
  export FAKE="$BATS_TEST_TMPDIR/fake"
  export REPO=ghcr.io/test/web
  export ATCGANG_ROOT="$ROOT"
  LOCK="$BATS_TEST_TMPDIR/lock"
  STATE="$ROOT/state"
  mkdir -p "$ROOT/deploy" "$FAKE"
  touch "$ROOT/.env" "$ROOT/deploy/docker-compose.yml"
  cat >"$ROOT/update.conf" <<EOF
WEB_IMAGE_REPO=$REPO
HEALTH_URL=http://health.test/healthz
HEALTH_TIMEOUT=1
POLL_INTERVAL=0
NOTIFY_URL=http://notify.test/atcgang
LOCK_FILE=$LOCK
EOF
  PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  # Running img-old, which is also what the registry serves.
  echo img-old >"$FAKE/registry"
  echo img-old >"$FAKE/running"
  echo "$REPO:main img-old" >"$FAKE/locals"
}

new_release() { echo img-new >"$FAKE/registry"; }
# `! cmd` does not fail a bats test, so negative checks go through refute.
refute() { if "$@"; then echo "expected this to fail: $*" >&2; return 1; fi; }

@test "no update: exits 0, prints nothing, deploys nothing" {
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  refute grep -q "compose.* up " "$FAKE/calls"
  [ ! -e "$FAKE/notify" ]
}

@test "new image: snapshots the db, deploys, remembers the last good image, notifies" {
  new_release
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ $output == *"deploy OK: web img-new"* ]]
  [ "$(cat "$FAKE/running")" = img-new ]
  [ "$(cat "$STATE/last-good")" = "$REPO@sha256:img-old" ]
  ls "$STATE"/pre-update-*.dump
  grep -q DUMPDATA "$STATE"/pre-update-*.dump
  grep -q "compose.* up -d --no-deps --no-build web" "$FAKE/calls"
  grep -q "image prune" "$FAKE/calls"
  grep -q "deployed" "$FAKE/notify"
}

@test "first deploy with no running web container" {
  : >"$FAKE/running"
  new_release
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$FAKE/running")" = img-new ]
  [ ! -e "$STATE/last-good" ]
}

@test "failed health check: rolls back, exits 1, and skips that image afterwards" {
  new_release
  echo img-new >"$FAKE/bad"
  run "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ $output == *"rolling back to $REPO:last-good"* ]]
  [ "$(cat "$FAKE/running")" = img-old ]
  [ "$(cat "$STATE/bad-image")" = img-new ]
  grep -q "rolled back" "$FAKE/notify"

  : >"$FAKE/calls"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  refute grep -q "compose.* up " "$FAKE/calls"
}

@test "a newer image after a bad one is deployed again" {
  mkdir -p "$STATE"
  echo img-bad >"$STATE/bad-image"
  new_release
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$FAKE/running")" = img-new ]
  [ ! -e "$STATE/bad-image" ]
}

@test "failed rollback: exits 2 and sends an urgent notification" {
  new_release
  printf 'img-new\nimg-old\n' >"$FAKE/bad"
  run "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ $output == *"ROLLBACK FAILED"* ]]
  grep -q "Priority: urgent" "$FAKE/notify"
}

@test "container healthy but the public URL fails: rolls back" {
  new_release
  touch "$FAKE/curl_fail"
  run "$SCRIPT"
  # Rollback health also goes through the URL, which still fails.
  [ "$status" -eq 2 ]
  [[ $output == *"is not"* ]]
}

@test "lock held by another run: exits 3 quietly" {
  new_release
  run flock "$LOCK" "$SCRIPT"
  [ "$status" -eq 3 ]
  [ -z "$output" ]
  [ "$(cat "$FAKE/running")" = img-old ]
}

@test "--dry-run changes nothing" {
  new_release
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ $output == *"dry-run: web would run $REPO:main"* ]]
  [ "$(cat "$FAKE/running")" = img-old ]
  refute ls "$STATE"/pre-update-*.dump 2>/dev/null
  [ ! -e "$STATE/last-good" ]
  refute grep -Eq "compose.* (up|pull|build) |docker tag" "$FAKE/calls"
  [ ! -e "$FAKE/notify" ]
}

@test "--dry-run with nothing new says so" {
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ $output == *"nothing to do"* ]]
}

@test "--force redeploys the same image" {
  run "$SCRIPT" --force
  [ "$status" -eq 0 ]
  grep -q "up -d --no-deps --no-build --force-recreate web" "$FAKE/calls"
}

@test "--tag deploys a specific build" {
  echo img-sha >"$FAKE/registry-abc123"
  run "$SCRIPT" --tag abc123
  [ "$status" -eq 0 ]
  [ "$(cat "$FAKE/running")" = img-sha ]
  grep -qx "$REPO:abc123" "$FAKE/deployed"
}

@test "--all updates the other services but keeps web on its image" {
  run "$SCRIPT" --all
  [ "$status" -eq 0 ]
  grep -q "compose.* pull -q db cloudflared" "$FAKE/calls"
  grep -q "compose.* build -q --pull backup" "$FAKE/calls"
  grep -q "compose.* up -d --no-build$" "$FAKE/calls"
  grep -qx "$REPO:last-good" "$FAKE/deployed"
  [ "$(cat "$FAKE/running")" = img-old ]
}

@test "database snapshot fails: aborts with 4 before deploying" {
  new_release
  touch "$FAKE/dump_fail"
  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [ "$(cat "$FAKE/running")" = img-old ]
  refute ls "$STATE"/pre-update-*.dump* 2>/dev/null
}

@test "keeps only the newest KEEP_DUMPS snapshots" {
  mkdir -p "$STATE"
  for i in 1 2 3 4 5 6; do touch "$STATE/pre-update-20200101-00000$i.dump"; done
  new_release
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(ls "$STATE"/pre-update-*.dump | wc -l)" -eq 5 ]
  [ ! -e "$STATE/pre-update-20200101-000001.dump" ]
}

@test "not enough disk space for a dump: exits 4 before deploying" {
  echo MIN_FREE_MB=999999999 >>"$ROOT/update.conf"
  new_release
  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [[ $output == *"not enough disk space"* ]]
  [ "$(cat "$FAKE/running")" = img-old ]
  refute ls "$STATE"/pre-update-*.dump 2>/dev/null
}

@test "disk check counts the database size" {
  echo MIN_FREE_MB=0 >>"$ROOT/update.conf"
  echo $((1024 * 1024 * 1024 * 1024 * 1024)) >"$FAKE/db_size" # 1 PiB
  new_release
  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [[ $output == *"database 1073741824 MB"* ]]
}

@test "setup errors: notify on the 2nd run in a row, not again, then say recovered" {
  touch "$FAKE/pull_fail"
  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [ ! -e "$FAKE/notify" ]

  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [ "$(grep -c "update failed" "$FAKE/notify")" -eq 1 ]
  grep -q "failed 2 runs in a row" "$FAKE/notify"

  run "$SCRIPT"
  [ "$(grep -c "update failed" "$FAKE/notify")" -eq 1 ]

  rm "$FAKE/pull_fail"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ $output == *"works again after 3 failed run(s)"* ]]
  grep -q "recovered" "$FAKE/notify"
  [ ! -e "$STATE/last-error" ]
}

@test "setup errors: a one-off failure is forgotten without any message" {
  touch "$FAKE/pull_fail"
  run "$SCRIPT"
  rm "$FAKE/pull_fail"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -e "$FAKE/notify" ]
  [ ! -e "$STATE/last-error" ]
}

@test "setup errors: a repeated notification after ERROR_REPEAT_HOURS" {
  touch "$FAKE/pull_fail"
  run "$SCRIPT"
  run "$SCRIPT"
  # Pretend the last notification was 25 hours ago.
  sed -i "2s/.*/$(($(date +%s) - 25 * 3600))/" "$STATE/last-error"
  run "$SCRIPT"
  [ "$(grep -c "update failed" "$FAKE/notify")" -eq 2 ]
}

@test "db not running: deploys without a snapshot" {
  touch "$FAKE/db_down"
  new_release
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ $output == *"skipping the database snapshot"* ]]
}

@test "missing .env: exits 4" {
  rm "$ROOT/.env"
  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [[ $output == *".env is missing"* ]]
}

@test "image pull fails: exits 4" {
  touch "$FAKE/pull_fail"
  run "$SCRIPT"
  [ "$status" -eq 4 ]
}

@test "git pull not fast-forward: exits 4" {
  touch "$FAKE/git_repo" "$FAKE/git_pull_fail"
  echo c1 >"$FAKE/git_head"
  run "$SCRIPT"
  [ "$status" -eq 4 ]
  [[ $output == *"git pull --ff-only failed"* ]]
}

@test "compose file changed: re-applies all services" {
  touch "$FAKE/git_repo"
  echo c1 >"$FAKE/git_head"
  echo c2 >"$FAKE/git_next"
  echo deploy/docker-compose.yml >"$FAKE/git_changed"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ $output == *"deploy files changed"* ]]
  grep -q "compose.* up -d --no-build$" "$FAKE/calls"
}

@test "update.sh changed: restarts itself once with the new version" {
  touch "$FAKE/git_repo"
  echo c1 >"$FAKE/git_head"
  echo c2 >"$FAKE/git_next"
  echo deploy/update.sh >"$FAKE/git_changed"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(grep -c "restarting with the new version" <<<"$output")" -eq 1 ]
}

@test "--rollback returns to the last good image and skips the current one" {
  new_release
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  run "$SCRIPT" --rollback
  [ "$status" -eq 0 ]
  [ "$(cat "$FAKE/running")" = img-old ]
  [ "$(cat "$STATE/bad-image")" = img-new ]
}

@test "--rollback without a recorded image: exits 4" {
  run "$SCRIPT" --rollback
  [ "$status" -eq 4 ]
}

@test "--restore-db needs --yes when not interactive" {
  echo DUMP >"$BATS_TEST_TMPDIR/x.dump"
  run "$SCRIPT" --restore-db "$BATS_TEST_TMPDIR/x.dump" </dev/null
  [ "$status" -eq 4 ]
  [ ! -e "$FAKE/restored" ]
}

@test "--restore-db --yes snapshots first, stops web, restores, starts web" {
  echo MYDUMP >"$BATS_TEST_TMPDIR/x.dump"
  run "$SCRIPT" --restore-db "$BATS_TEST_TMPDIR/x.dump" --yes
  [ "$status" -eq 0 ]
  [ "$(cat "$FAKE/restored")" = MYDUMP ]
  ls "$STATE"/pre-update-*.dump
  grep -q "compose.* stop web" "$FAKE/calls"
  grep -q "compose.* start web" "$FAKE/calls"
}

@test "unknown option: exits 4" {
  run "$SCRIPT" --nope
  [ "$status" -eq 4 ]
}
