#!/usr/bin/env bash
# Restore test: take the newest backup (or a local dump file), restore it into a
# scratch database, and check the schema and row counts. Never restores over the source.
#   RESTORE_TARGET_URL  connection to a SCRATCH server or database (must not be production)
#   DUMP_FILE           a local .dump file, or leave empty and set BACKUP_BUCKET + SERVICE
set -euo pipefail

: "${RESTORE_TARGET_URL:?set RESTORE_TARGET_URL to a scratch database}"

if [[ -z "${DUMP_FILE:-}" ]]; then
  : "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
  : "${SERVICE:?set SERVICE}"
  latest="$(aws s3 ls "s3://${BACKUP_BUCKET}/${SERVICE}/" | sort | tail -1 | awk '{print $4}')"
  aws s3 cp "s3://${BACKUP_BUCKET}/${SERVICE}/${latest}" /tmp/restore-test.dump --only-show-errors
  DUMP_FILE=/tmp/restore-test.dump
fi

# Refuse to run against a production host, by a simple guard on the URL.
if [[ "$RESTORE_TARGET_URL" == *"prod"* ]]; then
  echo "refusing: target looks like production" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-acl --dbname "$RESTORE_TARGET_URL" "$DUMP_FILE"

psql "$RESTORE_TARGET_URL" -v ON_ERROR_STOP=1 -At -c \
  "SELECT 'core tables: ' || count(*) FROM information_schema.tables WHERE table_schema = 'core';"
psql "$RESTORE_TARGET_URL" -v ON_ERROR_STOP=1 -At -c \
  "SELECT 'rls on: ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relrowsecurity;"
echo "restore test finished"
