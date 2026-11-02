# Exact historical web alias retirement

This protected workflow addresses only the historical zero-effective allocation
`resume-40350727924-1` on `assistant-web-01080-hel`. It preserves the exact
current 100% revision `assistant-web-01087-dup`, its `resume-40403696377-1` tag,
its URI, and the service template/configuration. It never deletes revisions or
images, changes IAM or epochs, or changes the normal allocation percentage.

The historical pins in `scripts/owner-web-tag-retirement.ts` come from reviewed
release jobs 121678248366 and 121858593564, immutable release manifests
12663499841 and 12690736934, and protected native traffic observation 41076419580.
The provenance packet hash is
`0fb66fad1b8e299b5cc6f942ddba9b4f1fa10c200ac21a79f53be267cc46d42d`.
A tag naming pattern alone never establishes ownership.

The workflow has manual `plan` and `apply` modes. Both require exact reviewed
main source, first attempt, the production environment, existing WIF identity,
pinned SDK 576, and the normal production-deploy concurrency group. No new
permissions or local credentials are used. `plan` performs only fixed-service
and fixed-revision GETs and retains a sanitized packet. The release manager
reviews that concrete packet and source before any `apply` dispatch. Apply
requires its exact packet SHA256 and observation time, expires after 30 minutes,
and recomputes it from fresh native reads. A changed source, etag, UID,
configuration, traffic mapping, revision image or timeout stops before PATCH.

Apply submits one native traffic-only PATCH with the fresh service etag and
`updateMask=traffic`. It follows only the returned operation in the fixed
project/region, bounded to 180 seconds, then verifies settled desired/status
traffic, exact current identity, UID and unchanged configuration. It always
waits 600 seconds in 30 second chunks, including when the alias is already absent,
and verifies the service again before a completed result receipt is written.
Both old and current native request timeouts must be known integer durations
from 1 to 600 seconds before any PATCH. This is a conservative timeout barrier,
not a live request census or cancellation receipt.

An uncertain PATCH, failed operation, mismatched postcheck or interrupted drain
is fatal. Do not retry an uncertain mutation blindly or infer completion from
tag absence. A fresh reviewed plan may recover the already-absent state while
still verifying the old immutable revision and completing the full drain.
Provider responses, runtime environment variables and credentials are never
retained in the plan or result. An incomplete operation produces no success
receipt.

Failures retain only allowlisted stage/reason codes, reviewed-source/run metadata,
and whether a native write may have been attempted. The helper distinguishes WIF,
runner/binary checks, SDK version and token minting before fixed native reads and
planner validation. Raw exceptions, child output, credentials and resource payloads
are never included. The failure receipt does not qualify readiness or authorize
retry. After entering a PATCH attempt, an error remains possibly mutating even if
no success receipt exists; investigate before deciding any next operation.

Only a plan-mode canonical traffic disagreement may additionally retain bounded
discrepancy hints from the service snapshot that was already fetched. This adds no
provider call and does not change equality or planning. At most32rows per side and
16KiB of output contain counts, duplicate identities, tag/revision hashes, known
historical/current membership labels, and native effective percentages. Membership
is not ownership. Arbitrary tags, revisions, URIs, environment and payload are not
retained. Invalid, missing or over-bound coverage is explicitly uncomparable or
unavailable; it does not imply equality or absence. Row order, status URI and omitted
zero percentages already normalize in the planner and do not explain a canonical
multiset mismatch. These hints propose no repair and never authorize a retry/apply.

Source/CI approval for this workflow is separate from operational permission.
Actual execution remains held for the manager's concrete plan review and the
paired rollout lifecycle fix: retire every captured proven old web alias after
paused-web promotion and old canonical drain, then complete the post-retirement
600 second barrier BEFORE creating any unpaused resume tag. Creating that tag
already admits requests. Unknown operator aliases must block admission while
being preserved. Canonical rollback must never recreate retired aliases. This
one-time workflow alone does not supply the future creation receipts or that
paired release barrier and does not authorize editor activation.

The native contract is documented by Google at
https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch
and https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
(`etag` conflict detection). Fake transport tests verify request construction,
no retry, fixed operation scope and bounded drains; they do not prove an actual
provider CAS rejection or completed cloud operation.
