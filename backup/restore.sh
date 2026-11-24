#!/usr/bin/env bash
# Restore the latest snapshot (or $1) into the running db and photo volume.
#   docker compose run --rm -v photos:/data/photos backup restore.sh [snapshot-id]
# The photos volume is mounted read-only in the normal service, so pass it writable here.
set -euo pipefail
SNAP=${1:-latest}
TARGET=/tmp/restore
restic restore "$SNAP" --target "$TARGET"
DUMP=$(find "$TARGET" -name db.dump | head -n1)
pg_restore --clean --if-exists --no-owner --dbname "$PGDATABASE" "$DUMP"
if [ -d "$TARGET/data/photos" ]; then cp -a "$TARGET/data/photos/." /data/photos/; fi
echo "restored $SNAP"
