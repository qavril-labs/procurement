#!/usr/bin/env bash
# Nightly logical backup of a product database to S3 (production only).
# Needs: pg_dump (PostgreSQL 18 client), aws CLI, and these env vars:
#   BACKUP_URL   connection string for a read-only backup role (see docs)
#   BACKUP_BUCKET e.g. qavril-backups-prod-qv7k2
#   SERVICE      e.g. platform
set -euo pipefail

: "${BACKUP_URL:?set BACKUP_URL}"
: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
: "${SERVICE:?set SERVICE}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="/tmp/${SERVICE}-${stamp}.dump"

# Custom format: compressed and restorable with pg_restore, selectively if needed.
# Only the product schema: the backup role has no rights on public.
pg_dump --format=custom --no-owner --no-acl --schema=core --file "$file" "$BACKUP_URL"

aws s3 cp "$file" "s3://${BACKUP_BUCKET}/${SERVICE}/${stamp}.dump" \
  --sse AES256 --only-show-errors
rm -f "$file"
echo "backed up ${SERVICE} to s3://${BACKUP_BUCKET}/${SERVICE}/${stamp}.dump"
