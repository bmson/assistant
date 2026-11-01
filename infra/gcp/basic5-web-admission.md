# BASIC5 pre-admission web alias barrier

BASIC5 paired Firestore releases capture ownership before the first candidate
update. Every prior reachable alias must be either an exact reviewed historical
pin or match a protected deployment's creation receipt, manifest and fresh
immutable native revision. A naming pattern selects a run to inspect; it never
establishes ownership. Unknown operator aliases are preserved and block release.

Both direct release wrappers check the intrinsic capability, paired Firestore
scope and protected GitHub main/source identity before their first provider
read, build, migration or scheduler action. Staging repeats the check. Genuine
legacy source without the capability and runtime retains its existing paths.

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
