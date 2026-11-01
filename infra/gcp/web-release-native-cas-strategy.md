# Selected source-only web release strategy: separate creation and traffic CAS

Decision proposed for review: keep the strict comparator and existing retirement
planner. Replace BASIC5 web SDK mutations with two separately bounded native
operations: (1) template-only creation with traffic pinned, then (2) traffic-only
attachment/promotion/removal/recovery. Do not change flags or normalize unequal
views inside the strict reader. This document authorizes no provider call, runtime
wiring, deployment, new credential, or cleanup change.

## Evidence and API boundary

The manager reports that the official VERSION576 archive passed its Google metadata
MD5 check and the independent source audit found `--to-tags` and `--to-revisions`
produce the same untagged percentage plus zero-percent tag rows. This is attributed
source evidence, not a provider experiment. Neither SDK command is the selected
web writer. The earlier installed586 finding is not production576 evidence.

The official [Service patch API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch)
supports explicit field masks and returns an operation. The official
[Service/RevisionTemplate contract](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services)
defines the revision template, optional explicit revision name,
explicit revision traffic targets, etag, generation and reconciliation fields.
Selecting `updateMask=template` to leave explicit traffic unchanged is a design
inference from these field-mask semantics; this has not been exercised against
production. Strict postchecks must confirm it before another phase is permitted.
No assumption about coalescing unequal traffic representations is required.

## Two distinct operation families

A. **Create a revision without attaching an alias.** Fresh settled strict-equal
before traffic must be explicit REVISION-only, a single unambiguous100 allocation,
with exact retained tag proofs and tombstones checked. One CAS PATCH body is exactly
`{name,etag,template}`, query `updateMask=template`. Copy the complete native template
in memory; change only the manifest-bound image, the enumerated existing release
environment keys, and set a deterministic new template revision name derived from role, protected
run/attempt and source prefix. Refuse an existing identity; never reuse it for a
second create. Preserve every other template/service setting, environment/secret entry,
service account, resource/scaling/network/timeout field. Reject duplicate release
environment keys, unsupported templates or unexpected diffs instead of reconstructing
an incomplete template. No allowMissing or forceNewRevision, no traffic field, tag,
IAM or service-level field in this request. Source/run/attempt environment changes
must make the new intended template distinct; an identical template is not retried
or forced into a new revision.

Bounded polling and a fresh settled read must show NEW etag/newer generation,
latestReady==latestCreated identifying exactly one new revision, expected image,
source/run/attempt/manifest/pause values and immutable native UID. Traffic desired
AND observed must remain exactly equal to the prior views; canonical allocation,
retained tag bindings/URIs and root/URL set unchanged. All service settings outside
the permitted template delta remain equal. Record a native creation receipt before
any alias or HTTP probe. Do not log raw template/environment/config values. A
failed or uncertain create holds; never repeat it or discover revisions by listing.
Require the new settled latest identity to equal that deterministic name and use
only its fixed revision GET for proof. A bound operation may be recovered only by
GET of that same operation and exact identity; a lost operation response stays
unknown and cannot be adopted merely because a revision now exists.

B. **Change traffic only.** Use one independently planned CAS PATCH body exactly
`{name,etag,traffic}`, query `updateMask=traffic`. Allowed enum modes are attachP,
promoteP, attachR, promoteR, closeP, restoreC, repauseP and closeR. Each mode has an
exact stage-specific retained map; callers cannot supply arbitrary rows/targets.
This separate client must not broaden the existing single-target retirement client.
Postcheck freezes template/config/latest identities, immutable revision UIDs/images,
service UID/rootURI and all retained tagURIs. Require NEW etag, newer settled
generation==observedGeneration, exact desired/status equality and tombstone absence.
Attachment may add exactly one expected tag URL; closure may remove exactly its
one URL; all other URLs remain exact. A newly attached URI is first native-verified,
then bound in the attachment receipt before any HTTP probe. Existing retained URIs
must already match their previous proofs. No caller-selected URI is trusted.

For both families use the fixed service/project/region and protected main-source,
manifest, production lock/environment and WIF context. Rebuild the exact plan from
fresh reads and check TTL immediately before sending once. Set sticky attempted
before PATCH; safe bounded failure reasons only. Validate the returned fixed-region
operation and poll only that same operation with GET, capped180s/60polls;15s per
request,2MiB per response,100calls maximum per operation. Abort and deadline checks
cover streamed bodies and stalled callbacks. No write retries or automatic inverse
PATCH. Uncertain outcomes stay HOLD; separately authorized observation is necessary
to choose any subsequent recovery. Future adapters need independent review and
transport fixtures before wiring; the injected pure model is not that adapter.

## Exact first paired lifecycle

Let C be the captured canonical revision, P the new paused revision and R its
unpaused successor. Candidate/resume aliases bind the exact protected run/attempt.
Assume the reviewed initial known reconciliation has succeeded, followed by a NEW
normal retirement plan and its full600s drain. Historical01080 stays retained.

| Stage | Required result before continuing |
|---|---|
| Capture | Strict-equal C100; exact retained owned alias proofs; tombstones include already retired aliases. No writer has run. |
| Create P (A) | New P native receipt, paused=true, traffic unchanged C100; no P alias yet. |
| Attach P (B) | C100 retained as captured; P tagged0. Verify strict snapshot and native attachment, then existing `--record-candidate`, then tagged health/readiness probes. |
| Promote P (B) | P tagged100, captured retained aliases0; no new revision/template change. Verify HTTP paused readiness; drain old canonical requests. |
| Retire captured aliases | Existing strict normal planner/executor only: preserve P tagged100, remove exact proven captured aliases, NEW settled state and full600s stable-etag/generation barrier. Persist monotonic tombstones for removals, including any uncertain attempt that could have removed them. |
| Agent/jobs | Keep existing paired ordering and contracts. Promote marker-aware agent; verify web-to-agent readiness. Web remains P100. |
| Admission barrier | Fresh existing strict retirement/drain stability check immediately before unpaused create. Set admissionPossible durably BEFORE invoking createR, even though creation initially attaches no alias. |
| Create R (A) | Native new R receipt with identical manifest image and allowed pause=true→false delta; P100 and its URI unchanged, retired aliases absent. R has no alias yet. |
| Attach R (B) | P tagged100, R tagged0; exact retained P URI, verified new R URI, no retired aliases. Existing `--record-resume` and probes follow this strict-equal snapshot. |
| Promote R (B) | R tagged100, P tagged0; no retired aliases. Health/source/readiness/writesPaused=false checks required. |
| Close P (B) | R tagged100 only, owned P alias absent; record closure and tombstone. Preserve root cleanup hold until first successful paired capture and reviewed cleanup decision. |

Creation receipts precede attachment; existing admission creation records remain
AFTER attachment because they require a verified tag URI. They are distinct records,
never a fabricated URI or an instruction to skip the strict snapshot.

## Failure and recovery policy

Before admissionPossible, a confirmed failure with a fully verified settled state
may select a NEW restoreC plan. Preserve all tags still present and allowed; restore
only captured canonical revision allocation. If C's captured alias has been retired,
use C UNTAGGED100 and retained P tagged0. Never recreate any retired alias, and never
restore a historical full traffic/tag snapshot. If C's existing alias remains, it
may carry100 only when uniquely identified. This first contract refuses split
canonical allocations, duplicate serving identities and unknown tags. Current
agent/jobs rollback ordering stays unchanged only in this pre-admission domain.

After admissionPossible, retain the marker-aware agent/jobs and require forward
recovery: a newly reviewed repauseP operation selects P tagged100, preserves an
exactly verified R alias0 if attached, and keeps tombstones absent. Then close only
the verified R alias with a separate CAS operation and drain R before declaring
closure. If R was created and verified but never attached, do not invent an alias
or close one; preserve P100 and drain the verified R as required by the recovery
review. If its creation/attachment identity or mutation outcome is uncertain, HOLD;
do not execute an automatic restore/repause/closure while pretending it is known.
No post-admission C rollback. Recovery planning cannot clear admissionPossible or
remove tombstones. A recovery PATCH failure remains uncertain with no second write.

Stage receipts chain source/run/attempt/manifest, service UID, operation ordinal,
prior receipt digest, reviewed plan digest, before/after hashes and exact allowed
next stages. A missing/corrupt/foreign receipt or unordered/replayed phase holds.
Tombstones and admissionPossible are monotonic across this chain, including recovery;
re-reading capture cannot reset them. Existing retirement stability evidence is
consumed before createR, not falsely expected to retain its old etag after a known
successful template mutation. No admission verifier is weakened to ignore drift.

## Exact next implementation scope, still unwired

1. Add a pure BASIC5 state/receipt model and adversarial tests for the above phase
maps, monotonic tombstones/admissionPossible, creation template diff whitelist,
pre/post identity invariants, safe hash-only packets and one-attempt uncertainty.
Use injected fake IO only; no CLI/credential/workflow or production caller.
2. Add separate source-only bounded native creation and multi-target traffic client
modules with injected transport fixtures. Enforce exact masks/body/mode boundaries,
fixed URLs, streamed byte/deadline/call limits, CAS/LRO scoping and no retry. Do not
change the current retirement client or strict comparator. No token lookup adapter.
3. Independent source/docs/semantic review plus QA must approve exact source and
failure fixtures, including creation BEFORE strict recording, uncertain createR,
partial captured retirement then rollback, known unattached R, CAS loss, URL drift,
forbidden alias recreation, LATEST targets and tag-cleanup representation. Run
relevant existing retirement/admission/release tests, scriptsTSC, lint and diff.
4. ONLY after a new manager decision: implement thin protected production adapter
and BASIC5-only call-site integration, preserving all other release paths. Then
exact-head CI and independent final review before any merge/runtime authorization.
5. Obtain separate reviewed fresh protected plan/read and explicit apply authority
for initial reconciliation. Its equality receipt is followed by a NEW normal
retirement plan/full600s drain. The first paired rollout needs its own source/run
plan and phase-by-phase strict evidence; a first unsupported provider result stops
it. No extra repair loop, repeated flag experiment or general equality exception.

No source test establishes actual provider acceptance or serving delivery. Backend
serving/source/readiness/delivery-guard restoration still precede the already
conditionally authorized matching phone build/install. Retention remains
`CURRENT_ONLY_CLEANUP=false`, owned by the manager, with existing serving untouched.

## Pure-model boundary in this source step

`owner-web-release-lifecycle-model.ts` is a pure reducer over supplied snapshots and
proof projections. It does not read a file/provider, obtain credentials, poll an
operation, send a request or wire a release. Creation plans use deterministic
`assistant-web-{p|r}-{run}-{attempt}-{sourcePrefix}` names with explicit template
field mask; attach/promotion/closure plans have traffic-only masks. Complete
private templates stay in memory in the prospective request; receipts retain hashes.
The future protected adapter must construct the proof projections from bounded
native responses and verify durable receipt provenance/chains; a supplied boolean,
hash or source-only reducer output is not independent runtime authority.

The model stores unknown attempts without allowing another plan. With no bound
operation, an observed revision cannot authorize adoption or duplicate creation.
With a bound operation, only terminal success for that exact fixed-region operation,
fixed service response and exact new state can settle it. Retirement attempts and
closures conservatively tombstone possible removals BEFORE mutation. A held
retirement cannot reset capture or restore the old aliases. Existing retirement
executor/drain evidence is consumed, not replaced by this model.

Already-paused R recovery has a read-only checkpoint rather than a redundant PATCH.
If verified R was never attached, a separate supplied full600s drain proof closes
recovery without inventing an alias. If attached but still0, closeR follows the
read-only checkpoint. If R was promoted100, a new repauseP CAS plan is necessary.
No unknown attempt can enter those confirmed-state recovery paths.

Review corrections: every intent, operation binding, unknown marker and confirmed
transition now advances a sealed state receipt with its predecessor digest and
ordinal. Every state consumer verifies the complete state digest before using it;
changes to pending plans, captured canonical identity, admission state or tombstones
invalidate the seal. This detects changed projections, not a forged origin or
replay of an older valid state: the future durable protected adapter still needs
origin validation, chain history and monotonic storage/CAS. Unknown-without-operation
cannot later bind a discovered operation for either creation or retirement. Rollback
uses the captured100 row's exact tag (including an empty tag), never the first other
alias on that revision; if that captured tag was retired it uses untagged C100.
