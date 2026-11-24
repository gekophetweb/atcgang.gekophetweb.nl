#!/usr/bin/env bash
# Restore the latest snapshot (or $1) into the running db and the photo volume:
#   docker compose run --rm restore            # latest from the off-site repo
#   docker compose run --rm restore restore.sh <snapshot-id>
#   RESTIC_REPOSITORY=/backups/local/restic docker compose run --rm restore   # from the local copy
set -euo pipefail
SNAP=${1:-latest}
TARGET=$(mktemp -d)
restic restore "$SNAP" --target "$TARGET"

if [ -d "$TARGET/data/photos" ]; then
  cp -a "$TARGET/data/photos/." /data/photos/
  echo "photos restored"
fi

DUMP=$(find "$TARGET" -name db.dump | head -n1)
# pg_restore exits non-zero on harmless warnings (e.g. pg-boss partition constraints); report them but carry on.
if pg_restore --clean --if-exists --no-owner --dbname "$PGDATABASE" "$DUMP"; then
  echo "database restored"
else
  echo "database restored with warnings (see above)"
fi
echo "restored $SNAP"
