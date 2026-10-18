#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin" "$fixture/tmp"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cat > "$fixture/bin/pg_dump" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "${FAIL_DUMP:-false}" != true ]] || exit 17
for argument in "$@"; do
  if [[ "$argument" == --file=* ]]; then
    backup_file="${argument#--file=}"
    printf '%s' "$DUMP_CONTENT" > "$backup_file"
    # Verify both the directory and data remain private even under a caller's
    # permissive umask, without relying on platform-specific stat flags.
    [[ -z "$(find "$(dirname "$backup_file")" \( -perm -0040 -o -perm -0004 \) -print)" ]]
  fi
done
MOCK

cat > "$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
data=""
url=""
while (($#)); do
  case "$1" in
    --data-binary) data="${2#@}"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
if [[ "$url" == http://metadata.google.internal/* ]]; then
  printf '%s' '{"access_token":"fixture-token"}'
  exit 0
fi
printf '%s\n' "$url" >> "$BACKUP_FIXTURE/uploads"
# Emulate the documented Cloud Storage generation precondition. Without it,
# the old script overwrites the original object and the repeated-run test fails.
if [[ "$url" == *'&ifGenerationMatch=0' && -e "$BACKUP_FIXTURE/object" ]]; then
  echo 'curl: (22) The requested URL returned error: 412' >&2
  exit 22
fi
[[ "${FAIL_UPLOAD:-false}" != true ]] || exit 22
cp "$data" "$BACKUP_FIXTURE/object"
MOCK
chmod +x "$fixture/bin/pg_dump" "$fixture/bin/curl"

export PATH="$fixture/bin:$PATH" TMPDIR="$fixture/tmp"
export BACKUP_FIXTURE="$fixture" DUMP_CONTENT='before migration'
export DATABASE_URL='postgres://fixture:fixture@db.example.test/fixture'
export BACKUP_BUCKET=fixture-bucket BACKUP_WORKSPACE_ID=fixture-workspace BACKUP_RELEASE=fixture-release

assert_cleaned() {
  [[ -z "$(find "$fixture/tmp" -mindepth 1 -print)" ]] || fail "temporary dump was retained"
}

# Exercise the actual executable, including its exit behavior and output.
(umask 000; bash "$ROOT/backup.sh") > "$fixture/success.log" 2>&1
[[ "$(cat "$fixture/object")" == 'before migration' ]] || fail "initial backup was not uploaded"
assert_cleaned

export DUMP_CONTENT='after migration'
if bash "$ROOT/backup.sh" > "$fixture/retry.log" 2>&1; then
  fail "repeated release overwrote its pre-migration backup"
fi
[[ "$(cat "$fixture/object")" == 'before migration' ]] || fail "original backup changed"
[[ "$(head -n 1 "$fixture/uploads")" == 'https://storage.googleapis.com/upload/storage/v1/b/fixture-bucket/o?uploadType=media&name=workspace%2Ffixture-workspace%2Fbackups%2Fpre-migration%2Ffixture-release.dump&ifGenerationMatch=0' ]] || fail "unexpected upload destination"
if rg -q 'Backup stored at' "$fixture/retry.log"; then
  fail "failed upload reported success"
fi
assert_cleaned

export FAIL_DUMP=true
if bash "$ROOT/backup.sh" > "$fixture/dump-failure.log" 2>&1; then
  fail "dump failure was swallowed"
fi
[[ "$(wc -l < "$fixture/uploads" | tr -d ' ')" == 2 ]] || fail "failed dump attempted an upload"
assert_cleaned
unset FAIL_DUMP

# A transport error must also fail the gate and clean its sensitive local file.
rm "$fixture/object"
export FAIL_UPLOAD=true
if bash "$ROOT/backup.sh" > "$fixture/upload-failure.log" 2>&1; then
  fail "upload failure was swallowed"
fi
[[ ! -e "$fixture/object" ]] || fail "failed upload created an object"
assert_cleaned

echo 'backup shell tests passed'
