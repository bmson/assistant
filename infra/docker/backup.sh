#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
: "${BACKUP_WORKSPACE_ID:?BACKUP_WORKSPACE_ID is required}"
: "${BACKUP_RELEASE:?BACKUP_RELEASE is required}"

# shellcheck source=infra/docker/database-admin.sh
source "$(dirname "${BASH_SOURCE[0]}")/database-admin.sh"

umask 077
backup_directory="$(mktemp -d)"
trap 'rm -rf "$backup_directory"' EXIT
backup_file="${backup_directory}/assistant.dump"
object_name="workspace/${BACKUP_WORKSPACE_ID}/backups/pre-migration/${BACKUP_RELEASE}.dump"
encoded_object="${object_name//\//%2F}"

echo "Creating a consistent pre-migration PostgreSQL backup"
direct_database_url="$(database_admin_direct_url "$DATABASE_URL")"
database_admin_run_url "$direct_database_url" pg_dump --dbname="$direct_database_url" \
  --format=custom --no-owner --no-acl --file="$backup_file"

token="$(
  curl --fail --silent --show-error \
    -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' |
    sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
)"
[ -n "$token" ] || { echo "Could not obtain a Google access token" >&2; exit 1; }

# A repeated release must not replace its original pre-migration recovery point
# with a dump taken after that release's migrations. The storage precondition is
# atomic, so concurrent jobs cannot both create this release's object either.
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@${backup_file}" \
  "https://storage.googleapis.com/upload/storage/v1/b/${BACKUP_BUCKET}/o?uploadType=media&name=${encoded_object}&ifGenerationMatch=0" \
  >/dev/null

sha256sum "$backup_file"
echo "Backup stored at gs://${BACKUP_BUCKET}/${object_name}"
