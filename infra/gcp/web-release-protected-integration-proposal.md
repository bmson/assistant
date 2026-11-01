# Protected BASIC5 integration proposal — design only, no runtime authority

Proposed decision: reject Actions artifact slot uniqueness as a global head/CAS
primitive. Review a separate same-service metadata journal model first. Do not
implement a credentialed adapter or change a workflow/callsite from this document.
The reviewed unwired clients remain at8a4ba865. Production and cleanup are unchanged.

## Existing capabilities and the concrete storage choice

Verified source: `github-actions.md:76–90` gives the deploy identity Artifact Registry
writer, Run admin and Scheduler admin; it explicitly says it has no Cloud Storage
permission. Workspace bucket roles in `deploy.sh:244–275` belong to runtime service
accounts. Do not reuse those identities, application Firestore, or workspace data.
The workflows declare only contents:read and id-token:write and already use the
pinned artifact upload action. No new IAM, credential or token permission is proposed.
GitHub repository metadata read during design confirms bmson/assistant is PUBLIC;
that is not evidence that the production job can download an artifact ZIP.

The existing supported durable evidence mechanism is GitHub Actions artifacts.
The [pinned v4 source](https://github.com/actions/upload-artifact/blob/65462800fd760344b1a7b4382951275a0abb4808/README.md)
documents immutable archives, duplicate-name failure with overwrite=false, immediate
availability after upload, and replacement receiving a new ID. This supports a
candidate create-if-absent slot within a workflow run; simultaneous-upload conflict
behavior still needs a fixture/integration qualification. It is NOT a mutable-head
CAS, cross-run fence, undeletable history, or proof that the largest ordinal is valid.
Attempt2 and another run are distinct origins, not valid substitutes for attempt1.
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
provides scheduling serialization for the fixed production-deploy group. It is not
a durable fencing token and does not prove a canceled process has ceased writing.
**Artifacts plus concurrency alone are BLOCKED for mutation authority.**

Minimal concrete alternative for review: use the EXISTING Cloud Run Service resource
as the authoritative CAS head, at the ONE proposed service-level annotation key
`assistant.release/journal-v1` on the fixed assistant-web service. The
[Service API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services)
provides annotations and etag; the [patch API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch)
provides explicit field masks. This is a new bounded use of an existing API/store,
not an existing implemented release journal. Existing run.services.update is the
same capability used for deployment; actual permission/annotation preservation and
etag conflict behavior remain runtime qualification gates. No extra grant is assumed.

Journal-only request: ONE `PATCH {name,etag,annotations}` with `updateMask=annotations`.
Copy all existing annotations in memory and change only that exact key. Preserve
traffic, tags/URIs, template, latest identities, images, service UID and every other
service setting. Require a new settled etag and exact sole-key delta. Metadata-only generation
behavior is unqualified: the later model must require a separately qualified
nondecreasing generation with observedGeneration==generation. Actual template/traffic
actions retain their strict newer-generation requirement; metadata must not fabricate
that action evidence.
No annotations under system namespaces, no template annotation, no allowMissing,
retry, wildcard mask, IAM or new service. Size cap8KiB/head; bounded64tombstones and
64transitions for this first protocol. Exhaustion stops rather than forgetting history.
The Service contract follows Kubernetes annotation rules and rejects the
run.googleapis.com, cloud.googleapis.com, serving.knative.dev and autoscaling.knative.dev
namespaces in v2. [Kubernetes annotation limits](https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/)
are256KiB aggregate key/value bytes, name<=63characters and optional DNS prefix<=253.
The proposed key is non-system and within syntax limits. A future raw reader must
validate a plain string-to-string map and total byte budget, cap the complete map
conservatively at64KiB including the8KiB head, and preserve every unowned entry byte
for byte. Unknown non-string/oversized/unsupported data holds; do not delete it.
Only this exact owned key may change; no caller-selected key or namespace wildcard.

This adds metadata mutations to the approved mutation set ONLY if separately
reviewed. The current clients/model are not silently authorized to accept them.

## Authority and durable origin

Environment strings and an unkeyed seal are consistency checks, not caller authority.
A future protected entrypoint must validate the existing WIF credential configuration
and actual cryptographically verified GitHub job identity. Use the already allowed
OIDC capability, fixed issuer/JWKS/audience, bounded expiry, exact numeric repository
and owner IDs, main ref, source SHA, workflow ref/SHA, production environment, event,
run ID, attempt1 and current job identity. The
[OIDC claim contract](https://docs.github.com/en/actions/reference/security/oidc)
is the reference; fail if required claims cannot be obtained/verified under the
existing context. Do not change IAM trust, add a PAT, persist a bearer JWT or trust
a decoded unsigned claim object. Pin the supported verification dependency/source.

Cross-check fixed GitHub run/job metadata over authenticated fixed-origin HTTPS:
repository/head repository, exact deploy.yml path, head/source, run/attempt and
release job in progress. Match actual checkout HEAD, workflow source and reviewed
manifest/image digests. No reusable/fork/PR/local/older-workflow path or caller flags.
Production environment protection/approval requirements must be verified as actual
configuration; naming an environment alone does not establish human approval.
A fresh manager-reviewed packet must name exact source, service UID, operation,
allowed logical delta, before head/etag/state hashes, time and allowed protected
run binding. Old packet, different run/attempt, wrong image/manifest or stale source
refuses before any write. No read-only plan packet is durable mutation permission.

Journal origin is the fixed IAM-protected Cloud Run resource plus the reviewed
writer protocol and verified protected caller. Record only allowlisted claim
identifiers/hashes, not tokens. This does not defend against an owner/admin who can
replace code or arbitrarily mutate the service; unexplained changes invalidate the
head/etag and stop this protocol. No stronger tamper-proof claim is made.

## Monotonic head, intent and fencing

Proposed head: version, fixed service UID, genesis ID, global sequence, predecessor
head digest, exact owner workflow/source/run/attempt/job, release manifest/image
hashes, phase, unique intent ID, logical request digest, before native snapshot
hash, status, sticky per-run admissionPossible, persistent retired tag tombstones,
and referenced immutable artifact IDs/digests. No full template/environment/URL,
workspace content, credential or free-form error text. Exact native operation name
may appear only in its allowlisted operation receipt, never as caller-selected input.

The authoritative expected head is fetched from Cloud Run; the caller cannot supply
an older state as a replacement. Check source/run/phase/sequence/parent and native
facts, then CAS with the service's fresh etag. Race losers stop. Every authorized
journal transition increments sequence; no clearing tombstones or per-run admission,
restarting at0, skipping an unresolved intent, selecting a smaller history prefix or
lease-time takeover. A new run can claim only a verified terminal predecessor and
complete origin/history, or an explicit separately reviewed recovery fence. Run order
is not inferred from numeric run IDs, timestamps, queue order or artifact names.

A journal PREPARE persists the exact logical intent BEFORE its web action. The
intent digest covers the exact non-etag request payload and fixed mask/phase; the
journal's CAS response provides the new etag for that action. These are separate
reviewed mutations: first the sole owned metadata delta, then the template-only or
traffic-only action whose config baseline now includes that prepared head. Read
back and prove the sole metadata delta, construct the sealed model baseline from
raw native facts, regenerate the action, and verify its non-etag digest against the
authoritative prepared intent. The action uses that exact prepared service etag.
A different owner/head transition changes the SAME service etag and fences an older
prepared web PATCH; it cannot be bypassed by getting a fresh etag for an old owner.
No old writer may refresh its etag unless current durable ownership/intent matches.

**Required new pure work, not an implemented capability:** model a journal-only
transition/rebase that proves the exact sole-key annotation delta and known
etag and qualified generation behavior. Define a preserved-config digest with
ONLY assistant.release/journal-v1 removed from the annotation map, plus a separate
full owned-head digest. Compare both full pre/post native envelopes and prove the
sole-key change; all unowned annotations and every other config field stay exact.
Existing stableConfig hashes must continue to freeze
all settings INCLUDING the prepared owned key within each native action. Rebase
the full hash from verified raw post-journal facts only after that sole-key proof.
Do not exclude all annotations from hashes,
relax sameTraffic, or feed a fabricated post-journal state into the existing client.
The existing fixture callback is not a production journal; production integration
will need a reviewed preparation seam before action planning. Its operation/complete
callbacks must not mutate service annotations during an action's frozen postcheck.

During an action, use immutable artifact records for returned operation binding and
postcheck completion. A prospective local JavaScript action can use the same pinned
Actions artifact backend/SDK under the existing job runtime capability to wrap the
release and upload/redownload bounded redacted records before acknowledging them.
No undocumented raw upload REST endpoint or runtime-token export to shell/logs.
Dependency/version and action lifecycle must be reviewed before implementation.
Each name binds genesis, source, run, attempt1, sequence, phase and event; overwrite
and delete are forbidden. Require exact one artifact, expected run/source metadata,
ID/digest/size, single JSON member, strict schema, payload context and parent digest.
A slot collision never selects the newest winner. A failed/unknown upload is HOLD.

The journal head pins already finalized predecessor artifact IDs/digests when the
NEXT PREPARE or terminal COMMIT occurs. Operation records created while a head is
inflight can authorize GET-only observation after crash only if their immutable
platform origin, expected namespace/phase/parent and fixed operation identity are
verified. They do not authorize another PATCH. Missing/ambiguous/expired/replaced
record leaves UNKNOWN; deterministic revision existence is never adoption proof.
Cross-run artifact access/visibility/deletion and the job-scoped runtime upload
capability must be qualified before the first action. Public metadata availability
is insufficient for ZIP access. Do not add actions:read or another credential on
failure. If complete history cannot be authenticated, this design remains blocked.

## Lock ownership, crash windows and retention

Keep workflow-level production-deploy and cancel-in-progress:false across deploy,
retirement, reconciliation and cleanup. Confirm the exact reviewed workflow uses
that group, actual job is running, and no unexpected operative path is active.
The journal owner/sequence+same-service etag supplies fencing; workflow concurrency
only reduces competing claims. Canceling, queueing or rerunning never clears a head.
A stale first-attempt run cannot reclaim after a new owner; attempt2 is rejected.

Bootstrap requires a separate exact UID/state/absent-head approval and evidence that
pre-journal operational writers are quiescent, including any old hosted process or
still-valid pre-protocol credential that could issue unjournaled writes. Workflow
status alone is insufficient. No credential is read or revoked by this proposal.
If quiescence/maximum credential lifetime cannot be bounded with existing evidence,
bootstrap stays blocked. After bootstrap, missing/malformed journal means corruption,
not a fresh installation. Pin the genesis/UID in reviewed source or an independently
reviewed durable anchor before enabling further actions; deletion cannot reset it.

| Crash/cancellation window | Required outcome |
|---|---|
| Before PREPARE persistence | No action PATCH. A failed metadata CAS has unknown metadata outcome and stops; observe only after authorization. |
| PREPARE committed, before action send | Treat action as possibly attempted after crash; never infer safe retry from missing local marker or absent revision. |
| Action sent, response lost | Head remains inflight/unknown. No operation discovery/listing/adoption; no duplicate creation/write. |
| Operation known, before binding artifact confirmed | Unknown until verified original binding exists; no invented operation. |
| Binding archived, process lost | New protected recovery may GET only the authenticated original LRO and fixed raw poststate under a separate bounded decision. No write authority from that record. |
| Native success, completion archival uncertain | HOLD; verify only original operation/poststate and exact completion slot; never send the action again. |
| Completion archived, next PREPARE not committed | Revalidate current native state and exact authenticated completion, then CAS expected head/etag once. No replay of action. |
| Lock released while intent unresolved | Next normal run refuses ownership. Explicit recovery fence uses exact observed etag once; if an old write wins the race, fencing CAS loses and stops. |
| Artifact/head absent, expired, replaced or history truncated | HOLD; no empty-history fallback or automatic checkpoint/expiry reset. |

Artifact retention is bounded90days using the existing workflow policy. Keep a
bounded head chain/checkpoint anchor; reaching retention/history limits needs a
separate reviewed compaction or recovery decision, never deletion-based progress.
The first rollout's entire chain must be retained and verified. Concurrent upload,
collision and delete/recreate behavior need bounded integration evidence. This is
not permanent storage or an append-only database guarantee.

## BASIC5-only replacements and barrier composition

Line references are release-staged-services.sh at6297a84a; other release modes keep
existing behavior and must not inherit a shared helper change.

| Existing callsite | Proposed BASIC5 path |
|---|---|
|500–502 paused web SDK update | journal PREPARE createP; template-only native create; raw receipt; PREPARE attachP; traffic-only P0; strict existing record-candidate506 and probes follow |
|575–576 paused --to-revisions | PREPARE promoteP; exact P100/captured aliases0; existing readiness/old canonical drain587 |
|589 captured retirement | PREPARE retirement with conservative tombstones BEFORE fresh normal planner; existing planner/executor/one-target client and full600s stable drain unchanged |
|604–605 agent promotion and worker job staging | Existing ordering/contracts retained; journal web metadata must not interfere with these checks |
|623 admission verifier then628 marker | Existing exact retirement/drain stability verification FIRST. PREPARE createR CAS consumes that exact barrier service etag and persists admissionPossible=true; prove metadata-only delta, then createR. A mismatch stops before unpaused creation. |
|630–632 resume SDK update | template-only createR, then PREPARE attachR and traffic-only R0; strict native resume verification/record658 and probes follow |
|685–686 resume --to-revisions | PREPARE promoteR; native R100/P0; existing source/ready/writesPaused=false checks |
|725 post-admission restore helper | reviewed PREPARE repauseP for known verified R100; no old runtime rollback; already-paused/unattached cases use read-only confirmed-state recovery |
|733 close resume helper | PREPARE closeR only after P100 and exact R proof; native closure and full required R drain |
|771 pre-admission restore helper | PREPARE restoreC; exact captured serving identity or C untagged if retired; preserve tombstones, then existing agent/jobs rollback domain only when permitted |
|789 successful candidate helper | PREPARE closeP; exact owned P0 removed, R100 kept; terminal completion head CAS only after final proof |

NO journal annotation updates between the retirement PATCH/postcheck and completion
of its full600s stable-etag/generation drain, or between that completion and the
existing admission verification. Returned-operation and completed-drain records are
artifact-only in this interval; never falsely relabel a later etag as the drained
one. The PREPARE-createR CAS occurs AFTER the successful existing verifier, using
exactly its service etag. It is the explicit new owner transition that consumes the
barrier and persists admissionPossible; it must prove unchanged traffic/native
paused identity, not grant a new600s drain receipt. If this composition cannot be
proved by the separate model/tests and reviewed, integration remains BLOCKED.

Before admission, confirmed recovery restores only captured canonical allocation,
never retired aliases. Unknown retirement cannot automatically roll back. After
possible R creation, retain marker-aware agent/jobs; known P/R may use a separately
reviewed forward repause/closure/drain, unknown identity holds. Delivery guard
restoration remains independently proved. Root alone controls cleanup=false through
first paired rollout and retained01080 capture. No new creation/removal activation.

## Initial one-time operations and first-runtime stop plan

The actual initial state remains exact known3desired/2observed, all REVISION. It is
a real mismatch; normal lifecycle capture/retirement remains blocked. The one-time
reconciliation is a distinct existing pure model and still needs its own protected
transport/authority composition. Do not add a general reconcile mode to the eight
traffic modes or claim the first paired protocol can bypass this step.

Proposed first runtime authorization, AFTER source/QA review, is at most ONE
metadata-only genesis/qualification CAS against a separately reviewed fresh known
state packet, followed by bounded native readback and STOP. An exact-known-topology
bootstrap validator may preserve that measured mismatch verbatim; it must not tell
the normal comparator that it is equal. No routing, template, alias, epoch, unpause,
cleanup or phone action is authorized by that qualification. If metadata creates a
revision, changes any other field, fails CAS, returns an uncertain operation, or
artifact readback/provenance fails: HOLD, no inverse PATCH, retry or next stage.

A new fresh reconciliation packet must then bind the actual post-journal state and
protected ownership transition. Manager must choose/review the exact same-run or
new-run handoff/packet composition before any traffic apply; an ownership metadata
change cannot be hidden from the packet's configuration/etag checks. **This handoff
is an explicit unresolved design gate, not implemented authority.** Reconciliation
success then requires a NEW normal retirement plan and full600s drain. The first
paired rollout remains its own reviewed source/run qualification with strict stop
at each unsupported provider shape. Do not infer native acceptance from fixtures.

## Next bounded implementation proposal and validation

1. Pure journal/fence/rebase model and offline tests ONLY: authenticated context
projection contracts, genesis requirement, exact annotation-only delta, sequence/
owner CAS, hash chain/history bounds, sticky flags/tombstones and barrier-consumption
transition. Explicitly model the initial known-state/handoff gate before offering
any production adapter. No credentials/workflows yet.
2. Injected tests for simultaneous duplicate artifact uploads, finalize timeout,
cancel after upload, attempt2 namespace, wrong run/source/job, expired/deleted or
recreated ID/digest, ZIP permission failure and public-metadata-only success. No
permission changes; unsupported guarantees stay blockers.
3. Two simulated runners: old PREPARE vs new head claim, old paused writer after
cancellation, fresh-etag theft with wrong owner, old-state prefix replay, action
wins recovery fence race, missing genesis and context reset. Native412 must stop
with no refresh/retry. Test that no metadata write occurs during600s drain and that
PREPARE-createR consumes the exact verified barrier etag.
4. Review exact pure model/strategy with QA and independent reviewer. Only after
all authority/handoff gates are resolved, request a separately scoped adapter/local
JavaScript action and BASIC5-only integration, with targeted shell/admission/native
fixtures, scriptsTSC/full lint/diff, exact-head CI and final review before merge.
5. Explicit manager-approved bounded runtime qualification above. No production
mutation or permission request is implied by this document. Backend serving health,
exact source and delivery guard proof still precede authorized matching phone install.

## Existing actual test evidence for the unwired8a4ba865 head

Deployer ran260offline tests in7files with deny-test-egress, scripts TypeScript,
full lint and diff check; all exited0. QA and independent reviewer gave corrected
source GO; they did not independently rerun all checks. Logs and a digest receipt
are in `/Users/baldvinsmarason/.codex/artifacts/people-memory-usability-2026-11-01/`:
`web-release-native-tests.log`, `web-release-native-typecheck.log` (empty success),
`web-release-native-lint.log`, `web-release-native-checks.json`.
These are local/source evidence, not CI/deployment/provider/serving proof.
