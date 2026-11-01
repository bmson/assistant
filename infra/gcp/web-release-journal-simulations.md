# Pure journal/fence/rebase simulations — no runtime authority

This step implements only an offline model and fixtures under the f1f6 proposal.
There is no token/JWT signature implementation, new dependency, authenticated API
reader, ZIP decoder, credential, transport, adapter, workflow or provider operation.
All journal plans/states/review results explicitly say simulationOnly=true and
mutationAuthorized=false. Plain consistency projections, hashes, archive flags or
simulated review objects never become runtime authorization.

`simulateOriginBinding` models the contract AFTER future cryptographic verification
and authenticated API retrieval. It matches immutable repository/owner IDs, exact
source/workflow/main/run/attempt1/environment, time bounds and actual numeric job.
Crucially, the OIDC check_run_id must equal the ID in the authenticated job's exact
GitHub check_run_url; job.run_id/head_sha and run metadata must agree. Display names
are ignored. No decoded unsigned claims or arbitrary job-name match is sufficient
in a future real adapter. The official [job API shape](https://docs.github.com/en/rest/actions/workflow-jobs)
contains the run/source/check_run_url fields used by this contract.

The model compares full raw service envelopes across metadata PREPARE and permits
ONLY the exact owned annotation delta plus expected etag/generation/output progress.
The preserved-config digest removes ONLY assistant.release/journal-v1; raw before/
after projections are rebuilt inside the lifecycle rebase bridge and its full
stableConfig hash then includes the prepared key again. Unowned annotations,
templates, images, traffic, URI maps and latest revision identities are frozen
across metadata transitions. Actual template/traffic actions still require newer
generation; equal-generation metadata is merely a simulation case, not a qualified
Cloud Run semantic. Metadata-only preservation/generation/etag conflict behavior
and no-new-revision remain runtime blockers.

Head sequences, parent digests and acknowledged predecessor artifact IDs/digests
are bound. History records include native post-etag/generation/full-envelope digest,
source/run/attempt/job/check-run and exact member digest. Old prefixes, mismatched
origin, missing/expired records, acknowledged-ID delete/recreate and native etag or
full-state rollback refuse. These are *projection contract tests*: they do NOT
verify archive ZIP bytes, authenticated artifact origin, complete remote discovery,
or immunity to privileged deletion. The final unacknowledged archive's authenticity
still requires the qualified protected writer/runtime history reader. No artifact
or concurrency property is elevated to head/CAS authority. Unkeyed local seals
only detect changed simulation frames; they do not prove origin or prevent replay
of an entire old valid world. The live head, independently pinned genesis/high-water
evidence, authenticated history and actual service CAS remain required integration
facts, with bootstrap quiescence and anchor storage explicitly unproven.

PREPARE/action attempts remain pending after uncertainty. Lost unbound operations
cannot be adopted later; only the originally bound terminal successful operation
and exact observed delta can settle. A stale owner cannot use a new owner's fresh
service etag. No lease timeout, caller-reset flag, rerun or history truncation is a
new ownership grant. Genesis may transfer only from the exact pinned initial idle
head after its prior bootstrap run AND authenticated job are completed, followed
by one same-resource ownership CAS. A normal successor needs a terminal predecessor.
All of these are simulated conditions, not proof that a hosted writer/token is gone.

The journal plane's normal-action completion fixtures deliberately model supplied
phase postconditions; they are not a replacement for the existing raw lifecycle,
retirement/admission and transport verifiers. A future integration must compose
those verifiers. The known reconciliation path *does* directly compose its existing
exact3desired/2observed planner and strict post-verifier, and refuses generic action
entry/confirmation shortcuts. Private templates and unowned annotation values are
in-memory model frames, not public receipts or durable artifact bodies.

## Concrete initial reconciliation handoff selected

1. Genesis/metadata qualification and its bootstrap-run completion/anchor remain
separately authorized runtime gates. A later protected owner must explicitly CAS
claim the exact idle genesis before preparing reconciliation; a new run is never
implicitly allowed to reuse the old owner's etag.
2. Under that owner, validate the actual exact known3/2 topology with the existing
planner. PREPARE only the owned journal key, preserving that mismatch verbatim.
Confirm the original metadata operation and exact sole-key native delta. No normal
reader is told that this mismatch is equal.
3. AFTER PREPARE, construct a NEW known reconciliation packet from the actual new
etag/config/head and raw immutable revisions. Its review names exact packet/head,
source/run/attempt/job/check-run and bounded time. The selected composition permits
ONLY that SAME protected run AND SAME actual job/check-run to consume the review.
No ownership/head update or metadata write is allowed between review and action.
A changed run/job/head/config, old review or canceled job requires HOLD and a new
explicit recovery decision; it is not an adapter-defined handoff.
4. Consume the exact packet once, bind the returned original operation, and invoke
the existing strict known-reconciliation postcheck. Its distinct equality receipt
still requires a NEW normal retirement plan and full600s drain. A generic journal
completion cannot manufacture the reconciliation receipt.

The delivery/authentication of a real manager decision to that same live job within
TTL remains an operational qualification blocker. This model fixes its exact logical
composition; a future credentialed adapter cannot silently choose a different job,
run or rebase the packet after approval. If no supported existing approval path can
meet that composition without new permission, runtime remains blocked for a separate
explicit design decision. There is no hidden automatic approval or new permission.

## Exact drain/admission composition

A supplied confirmed retirement phase enters a frozen600second interval. No
PREPARE, completion/claim metadata transition or prepareR shortcut is allowed during
that interval or before admission verification. Native etag/generation and entire
raw envelope must remain identical. The existing retirement/drain/admission verifiers
remain separate required source/runtime prerequisites; the clock simulation is not
a real drain receipt.

After completion, the fresh admission check binds the exact current barrier etag/
generation and envelope. Only consumeBarrier may prepare createR, within15seconds
of that check, using precisely the verified etag. It persists conservative
admissionPossible even if the metadata response is lost. A confirmed sole-key
transition rebases the full config and consumes the old barrier; it does not rename
a later etag as the one drained. The unpaused action is then planned against the new
prepared state. No metadata mutation is slipped into the immutable drain interval.
Actual permission, native metadata semantics, authoritative barrier proof and
protected caller history remain gates before any adapter or production run.

## Review corrections and sequential composition

History now validates legal status edges, not just hash continuity. A prepared head
can become complete only with its matching private resolution: same intent/body,
original bound successful operation, exact native before/after delta and preserved
state. The known reconciliation resolution reruns its existing strict planner and
post-verifier. The retirement→prepareR edge additionally carries exact600s/fresh
barrier timing and native etag/generation. Idle→complete, altered intents, missing
resolution, foreign operation or wrong native postcondition are refused. Owner claim
revalidates this history rather than trusting a local complete flag or unkeyed seal.

The private simulation history includes raw frames to test those contracts. It is
NOT a public artifact format. journalEventPublicSummary builds the closed redacted
member shape: head, native post hashes/etag/generation, resolution digest and bounded
barrier fields. Raw templates, unowned annotations and native resolution frames must
never be serialized wholesale into an artifact. Obtaining authentic historical raw
proof/qualified private projections in an actual adapter remains a runtime design
gate; hashes and archive flags alone do not establish it.

Action confirmation is accepted only for attempted or unknown input and is terminal
once confirmed. Generic confirmed→unknown downgrade and repeated confirmation of
the same LRO are refused. There is no journal-model completion-upload callback or
implicit terminal reset. A real completion-archive failure remains HOLD; any future
recovery must retain and validate the exact original private pending proof (as the
separately reviewed unwired transport already does), not feed a completed state into
a generic downgrade API or manufacture a new generation.

Completion metadata has its own explicit lifecycle rebase. It rebuilds actual raw
before/after projections, validates the matching resolved phase and sole owned-key
delta, advances the private lifecycle receipt chain, and preserves phase/monotonic
flags. A sequential fixture uses existing lifecycle validators for createP native
confirmation, then journal completion, completion rebase, prepare attachP and prepare
rebase. It does not manually reseal/reset lifecycle state or exclude broad config
fields. This closes the PREPARE-only composition gap without introducing a provider
adapter or making the public summary a capability token.
