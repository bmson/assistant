#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/release-staged-services.sh"
# All candidate reads are synthetic. No gcloud transport is available in this test.
release_revision_json() {
  printf '{"spec":{"containers":[{"env":[{"name":"GOOGLE_CALENDAR_OAUTH_CALLBACK_URL","value":"%s"}]}]}}' "$observed_callback"
}
unset GOOGLE_CALENDAR_OAUTH_CALLBACK_URL
release_verify_google_calendar_candidate 'not parsed when unset' assistant-agent candidate-test
export GOOGLE_CALENDAR_OAUTH_CALLBACK_URL='https://bot.bmson.com/api/oauth/google-calendar/callback'
service='{"status":{"traffic":[{"tag":"candidate-test","revisionName":"agent-candidate"}]}}'
observed_callback="$GOOGLE_CALENDAR_OAUTH_CALLBACK_URL"
release_verify_google_calendar_candidate "$service" assistant-agent candidate-test
observed_callback='https://other.example.com/api/oauth/google-calendar/callback'
if release_verify_google_calendar_candidate "$service" assistant-agent candidate-test; then
  echo 'Mismatched candidate callback was accepted' >&2; exit 1
fi
observed_callback=''
if release_verify_google_calendar_candidate "$service" assistant-agent candidate-test; then
  echo 'Missing candidate callback was accepted' >&2; exit 1
fi
if release_verify_google_calendar_candidate "$service" assistant-agent missing-tag; then
  echo 'Missing candidate tag was accepted' >&2; exit 1
fi
node --test "$ROOT/google-calendar-release-config.test.mjs"
echo 'optional Calendar release configuration checks passed'
