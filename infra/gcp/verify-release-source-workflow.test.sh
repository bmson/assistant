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

# Evaluate the actual automatic-deploy admission expression against first and
# later attempts, including a rerun of another job that leaves BASIC5 skipped.
python3 - "$workflow" "$ROOT/../../.github/workflows/ci.yml" <<'PY'
import re
import sys
from pathlib import Path

deploy = Path(sys.argv[1]).read_text()
ci = Path(sys.argv[2]).read_text()
plan = deploy.split('  plan:\n', 1)[1].split('    runs-on:', 1)[0]
match = re.search(r'    if: >-\n((?:      .*\n)+)', plan)
assert match, 'automatic deployment admission expression missing'
expression = ' '.join(line.strip() for line in match.group(1).splitlines())

def admitted(attempt, *, event='workflow_run', conclusion='success', source_event='push', branch='main', same_repo=True):
    values = {
        'github.event_name': event,
        'github.ref': 'refs/heads/main',
        'inputs.native_web_qualification': '',
        'github.event.workflow_run.conclusion': conclusion,
        'github.event.workflow_run.run_attempt': attempt,
        'github.event.workflow_run.event': source_event,
        'github.event.workflow_run.head_repository.full_name': 'owner/repo' if same_repo else 'fork/repo',
        'github.repository': 'owner/repo',
        'github.event.workflow_run.head_branch': branch,
    }
    parsed = re.sub(r'\b(?:github|inputs)\.[a-zA-Z0-9_.]+', lambda m: repr(values[m.group()]), expression)
    parsed = parsed.replace('&&', ' and ').replace('||', ' or ')
    assert re.fullmatch(r"[a-zA-Z0-9_ ./=()'\-]+", parsed), 'unexpected admission syntax'
    return bool(eval(parsed, {'__builtins__': {}}, {}))

assert admitted(1), 'successful first main push must be admitted'
assert not admitted(2), 'selective rerun with skipped BASIC5 must not deploy'
assert not admitted(2, conclusion='failure'), 'failed rerun must not deploy'
assert not admitted(1, branch='feature')
assert not admitted(1, same_repo=False)
assert not admitted(1, source_event='pull_request')

job = re.split(r'\n  [a-zA-Z][a-zA-Z0-9_-]*:', ci.split('  build-smoke:\n', 1)[1], maxsplit=1)[0]
assert "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_attempt != 1" in job
assert job.index('Reject main push reruns without BASIC5 acceptance') < job.index('actions/checkout@')
assert re.search(r'Reject main push reruns without BASIC5 acceptance.*?exit 1', job, re.S)
assert re.search(r"Verify four BASIC5 saves.*?if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_attempt == 1.*?run: pnpm exec tsx scripts/basic5-ci-acceptance.ts", job, re.S)
print('automatic release and BASIC5 rerun admission checks passed')

archive_name = '      - name: Archive reviewed restore decision journal\n'
assert deploy.count(archive_name) == 1
before, following = deploy.split(archive_name)
assert before.rfind('      - name:') == before.index('      - name: Archive bounded disabled-bootstrap agent successor evidence\n')
archive = following.split('      - name:', 1)[0]
assert "if: always() && steps.release_path.outputs.firestore_pair == 'true'" in archive
path = archive.split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
directory = '${{ runner.temp }}/owner-release-recovery-${{ github.run_id }}-${{ github.run_attempt }}/'
assert [line.strip() for line in path.splitlines()] == [directory + suffix for suffix in ('start.json', 'admission.json', 'outcome.json')]
assert 'name: owner-release-recovery-${{ needs.plan.outputs.sha }}-${{ github.run_id }}-${{ github.run_attempt }}' in archive
assert 'if-no-files-found: ignore' in archive
print('reviewed restore journal archive scope passed')
PY
