# BASIC5 pre-admission web alias barrier

BASIC5 paired Firestore releases capture ownership before the first candidate
update. Every prior reachable alias must be either an exact reviewed historical
pin or match a protected deployment's creation receipt, manifest and fresh
immutable native revision. A naming pattern selects a run to inspect; it never
establishes ownership. Unknown operator aliases are preserved and block release.

The normal dispatcher, fast command, direct Firestore/PostgreSQL wrappers and
staging helper all enforce the intrinsic scope/context gates. Fast BASIC5 web
release stops before project discovery. The dispatcher performs the pure
identity/scope/fixed-target check before driver reads, then validates the actual
resolved driver before entering a mutating child. The production release job
performs the same pure check before cloud authentication. No assumed driver is
authority. Genuine legacy source without the capability and runtime retains its
existing paths; image building and separate customer/bootstrap policies retain
their distinct scope.

The required order is paused web promotion, old canonical request drain, native
etag traffic-only retirement of captured proven aliases, fresh postcheck and a
full 600 second post-retirement drain. A final fresh check then precedes the first
unpaused resume-tag creation, which itself can admit requests before canonical
promotion. Barrier failure uses existing pre-admission rollback of canonical
traffic and never recreates aliases. Existing post-admission forward recovery
continues to keep the compatible paused web/agent/jobs pair.

The settled post-retirement etag and generation are recorded in the completed
barrier. Both must remain unchanged at the end of the full drain and at the
immediate pre-admission check. A change fails closed even if the final traffic
and configuration look identical after a transient alias restoration/removal.
Missing version evidence cannot authorize admission.

Even already-absent aliases require native immutable timeout proof and the full
600 second drain. Before the first marker-aware cutover, both historical pinned
revisions must still have fresh known timeouts no greater than600 seconds. A
previous interrupted retirement cannot turn absence into completed drain proof.

Creation receipts contain only public run/source/revision/image identities,
pause state, URI hashes and the completed-barrier flag. The artifact contains
exactly the receipt and matching release manifest. Future ownership resolution
checks authenticated fixed-repository run/artifact metadata, raw archive digest
and size, bounded ZIP membership, embedded manifest/receipt source binding and
fresh immutable revision/image/pause plus a current URI hash when present. A
completed failed deployment may prove that it created an alias; this does not
prove deployment success or activation. An absent alias never receives a claim
of current URI observation.

The command uses only the existing protected WIF identity and existing GitHub
read token. It adds no IAM, OAuth scope or workflow permission. Missing artifact
access, expiration, incomplete evidence, an unsupported archive or any mismatch
fails closed; source tests do not establish availability of that read surface.
No current private configuration, credentials or raw provider error is written
into public receipts. The CLI does not probe historical tag URLs.

This BASIC5 path deliberately accepts only the exact current-main deployment
source when it matches the protected workflow SHA. Historical manual SHA inputs
and stale queued workflow-run sources fail closed; they need a separately
reviewed source/recovery procedure. Legacy paths are unchanged. Actual cloud
execution remains a separate manager-reviewed operation after ordinary exact
source CI; fake protocol tests are not a native CAS or live drain receipt.

The paired release inherits the normal GitHub 360 minute job ceiling. The delivery
guard's 600 second quiescence deadline applies before its child starts; it is not
a deadline on the child release. The two web drains may consume 1200 seconds,
plus the 180 second native operation budget, bounded metadata/immutable reads
and ordinary staging/probes. The separate manual retirement workflow has a
45 minute job ceiling for its single drain; its bounded command portion is at
most about 935 seconds before ordinary process scheduling, leaving setup margin.
A timeout or interrupted drain still produces no completed barrier receipt.

Before the delivery guard acquires any holds, an operator disables the deploy,
cleanup, and workspace-import workflows. Before disabling them, the operator
must separately and freshly read the repository-level `CURRENT_ONLY_CLEANUP`
variable and the production-environment override. The repository-level value
must exist and equal exactly `false`. The production override must be freshly
proven absent (the exact variable endpoint returns 404) or exist and equal
exactly `false`; do not create an override to make the check pass. Preserve the
actual distinction between absent and present-false in the operator's record,
bound to the exact trusted source, run, attempt, and release job. A 403, unknown
response, or drift is a HOLD. This operator record is separate from the job
receipt. The protected release job also snapshots the effective production
`CURRENT_ONLY_CLEANUP` value and requires exact `false`; its private run receipt
binds that effective snapshot to the same source, run, attempt, and job. The
operator records the original workspace-import workflow state; it is restored
manually only after a confirmed safe terminal result and only if it was active
before the hold. A previously disabled workflow stays disabled, and an unknown
result keeps it disabled. Each native phase rechecks all three disabled
workflow states, the job snapshot, and the fresh run census. The effective job
snapshot is not a fresh Variables API read and does not independently prove
either repository-level or production-environment variable values.

The active-run census checks every active status, with bounded complete
pagination, for `deploy.yml`, `cleanup.yml`, `owner-web-tag-retirement.yml`,
`owner-web-traffic-reconciliation.yml`, `prepare-owner-editor-index.yml`,
`owner-editor-v1-maintenance.yml`, and `workspace-import.yml`. Any active run
in a manual writer workflow blocks admission, including a queued traffic
correction, index preparation, metadata apply, or workspace import. The list
is intentionally conservative when an API run listing does not expose the
selected mode. `owner-editor-release-inventory.yml --collect` is a read-only
observation workflow; `workspace-export.yml` reads Firestore and writes an
export snapshot, not Firestore data. They are not treated as competing
Firestore writers. Missing, oversized, stalled, malformed, or incomplete API
responses keep the release held.
