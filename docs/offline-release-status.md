# Offline release status

`scripts/release_status.py` reads only explicit local JSON receipts and snapshots and prints a source-bound JSON summary. It invokes no subprocess, GitHub API, credential discovery or cloud request, writes no files and supplies no release approval. It does not replace the manager's merge or deployment decision.

Supply the selected exact main SHA and an explicit timezone-aware reporting time. Optional inputs are existing root `ROOT-PR*-MERGE-RECEIPT.json` files, retained `gh run view` JSON (including `headSha,event,headBranch,status,conclusion,jobs`), the existing native `EXECUTED-TEST-RECEIPT.json` shape, a root product/release handoff and a retained authority/conditional-binding packet. There is no recursive discovery or metadata refresh. Each input is limited to1MiB, all inputs to8MiB and merge receipts to128. Input hashes identify exactly which retained evidence was summarized; filenames and unrelated JSON fields are not emitted.

Example using retained artifacts, without fetching anything:

```sh
python3 scripts/release_status.py \
  --main EXACT_40_CHARACTER_MAIN_SHA \
  --as-of 2026-11-04T07:00:00Z \
  --main-ci /private/retained-main-ci.json \
  --merge-receipt /private/ROOT-PR837-MERGE-RECEIPT.json \
  --handoff /private/ROOT-PRODUCT-HANDOFF-v1.json \
  --authority /private/retained-binding.json
```

The report keeps these distinctions:

- A recorded merge remains merged even when an old handoff listed it as pending. Inclusion in selected main is established only by the supplied receipt parent graph; a missing graph link is unknown, not “unmerged.”
- A green PR run, an old main run or a snapshot missing required jobs cannot qualify selected-main CI. A completed native detector/build skip cannot establish test execution. Prior-source execution evidence remains attached to that source; no tree-equality shortcut is invented.
- Deployment and installation remain current-state unknown. Existing handoff booleans, source associations and last-qualified installed source are historical claims shown separately. A green source/CI result is never converted into serving or installed behavior.
- Expired, unbound and open time windows are distinct from source binding, IAM application and owner approval. An open window is not permission to act; no policy/application state is inferred. Invalid or absent times remain unknown.

Inventory proposals using `window.dispatchNotBeforeUtc` and
`window.dispatchNotAfterUtc` require two timezone-aware times with start before
end. The report includes `opensAt` and `expiresAt`: before start is
`not_yet_open`, start is included in `window_open`, and end is already `expired`.
Offsets are compared as instants. A malformed interval or conflict with a supplied
legacy expiry is `unknown_or_unbound`; it does not fall back to a different open
window. Source binding stays independent, owner approval remains `not_evaluated`,
and grant application stays unknown. These are dispatch-timing claims only; they
do not establish current source/configuration, job scheduling or launch authority.

The native execution adapter recognizes the existing `actualEvidence` XCTest-summary receipt with a log hash. It reports what the receipt records; it does not reread/reverify the original log, authenticate receipts or establish device acceptance. The tool does not consume free-form “passed” prose or a build-only line as executed tests. Provider/production freshness remains outside its scope.

Both retained root merge formats are supported: older `merged: true`/`mergedAt` records, and current `ROOT-MERGE-*.json` claims with a positive PR/CI run and complete `head,priorMain,merge,tree` hashes. The latter is reported as a historical `root_merge_claim` with an unknown timestamp. `priorMain` is never used as a verified Git parent; ancestry remains unknown without supplied `parents` links (apart from literal equality with the selected commit). Incomplete, malformed, explicit non-merged or proposal metadata is not asserted to be merged. A recognized receipt shape does not authenticate its author or independently verify GitHub state.

Run its offline fixtures with `python3 -m unittest discover -s scripts -p test_release_status.py`. No production workflow or dashboard is added.
