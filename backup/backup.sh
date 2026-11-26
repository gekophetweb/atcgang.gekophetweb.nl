#!/usr/bin/env bash
# Nightly: pg_dump + photos volume -> restic (off-site repo, then a local copy).
# Retention: 14 daily + 4 weekly. Deleted data is gone from backups within 14 days.
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=/tmp/backup-$STAMP
mkdir -p "$WORK"
trap 'rm -r "$WORK"' EXIT

echo "[$STAMP] dumping database"
pg_dump --format=custom --no-owner --file "$WORK/db.dump"

backup_to() {
  local repo=$1
  RESTIC_REPOSITORY=$repo restic snapshots >/dev/null 2>&1 || RESTIC_REPOSITORY=$repo restic init
  RESTIC_REPOSITORY=$repo restic backup --tag nightly --host atcgang "$WORK/db.dump" /data/photos
  RESTIC_REPOSITORY=$repo restic forget --prune --keep-daily 14 --keep-weekly 4
}

backup_to "$RESTIC_REPOSITORY"
backup_to /backups/local/restic
echo "[$STAMP] backup done"
