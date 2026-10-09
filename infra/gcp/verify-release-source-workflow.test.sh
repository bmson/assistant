#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workflow="${1:-$ROOT/../../.github/workflows/deploy.yml}"
[[ -f "$ROOT/verify-release-source.sh" ]] || {
  echo 'FAIL: trusted checkout must contain the manual verifier script' >&2
  exit 1
}
trusted_line="$(grep -n 'Checkout trusted workflow source for manual verifier' "$workflow" | cut -d: -f1)"
verify_line="$(grep -n 'Verify exact source passed main CI' "$workflow" | cut -d: -f1)"
target_line="$(grep -n 'Checkout exact release source' "$workflow" | cut -d: -f1)"
[[ -n "$trusted_line" && -n "$verify_line" && -n "$target_line" && "$trusted_line" -lt "$verify_line" && "$verify_line" -lt "$target_line" ]] || {
  echo 'FAIL: manual verifier must run between trusted workflow checkout and requested release checkout' >&2
  exit 1
}
trusted_block="$(sed -n "${trusted_line},$((trusted_line + 7))p" "$workflow")"
verify_block="$(sed -n "${verify_line},$((verify_line + 9))p" "$workflow")"
target_block="$(sed -n "${target_line},$((target_line + 4))p" "$workflow")"
grep -Fq "if: github.event_name == 'workflow_dispatch'" <<<"$trusted_block" || {
  echo 'FAIL: trusted verifier checkout must be limited to manual dispatch' >&2
  exit 1
}
grep -Fq 'repository: ${{ github.repository }}' <<<"$trusted_block" || {
  echo 'FAIL: trusted verifier checkout must use the current repository explicitly' >&2
  exit 1
}
grep -Fq 'ref: ${{ github.workflow_sha }}' <<<"$trusted_block" || {
  echo 'FAIL: verifier source must come from the commit that contains this workflow' >&2
  exit 1
}
grep -Fq 'persist-credentials: false' <<<"$trusted_block" || {
  echo 'FAIL: trusted verifier checkout must not persist repository credentials' >&2
  exit 1
}
grep -Fq 'GITHUB_REPOSITORY: ${{ github.repository }}' <<<"$verify_block" || {
  echo 'FAIL: the manual verifier must receive the repository explicitly' >&2
  exit 1
}
grep -Fq 'run: bash infra/gcp/verify-release-source.sh' <<<"$verify_block" || {
  echo 'FAIL: the verifier must run from the trusted checkout' >&2
  exit 1
}
grep -Fq 'ref: ${{ steps.release.outputs.sha }}' <<<"$target_block" || {
  echo 'FAIL: the release source checkout must remain pinned to the approved SHA' >&2
  exit 1
}
echo 'manual verifier checkout order tests passed'
