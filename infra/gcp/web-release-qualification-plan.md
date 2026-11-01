# Converged qualification plan — proposal only, nothing executable is authorized

Decision: stop reducer expansion. Correct the three final validation findings, then
qualify existing capabilities in one read-only hosted slice. No provider access,
credential/signature implementation, dependency, workflow or production adapter is
authorized by this plan. Existing serving/traffic/cleanup and phone remain unchanged.

## Cold recovery decision: fail closed, no automatic continuation

Public summaries are audit evidence. Their digests cannot reconstruct private raw
before/after service/template or resolution proof. Do NOT hydrate an executable
JournalSimulation, lifecycle state, completion, owner claim or recovery token from
those summaries, a head status or an old unkeyed seal. The simulation's private
history projections are hypotheses, not a supported durable private proof store.
No new bucket, database, encryption key, token scope or runtime-SA reuse is proposed.

Warm recovery is limited to the same live protected process retaining the original
private pending proof and original bound operation. It may use the reviewed bounded
GET-only same-operation path; it does not resend a PATCH. Loss of that process or
private proof is a hard stop. Missing operation binding, unknown PREPARE/action,
missing archive, expiration or inconsistent history also stops normal progression.
A terminal local result is not reset through a generic unknown API.

After a job/cancellation/runner loss, a NEW owner recovery decision must name a NEW
bounded read-only observation and exact source/current native head/UID/etag. The
owner reviews observable facts, old writer quiescence, recorded uncertainty and the
specific proposed fence/recovery delta. It cannot declare a lost action complete
from a digest, deterministic revision existence, elapsed lease or archived status.
There is no automatic cross-run continuation or genesis claim in a real adapter;
the simulated claim functions require private hypotheses unavailable from public
summaries. A separately reviewed recovery procedure must establish a new authority
boundary before any further write. This procedure is NOT implemented or authorized.

A metadata-only qualification may finish and lose its private state without moving
traffic. Its persisted idle head is then an observable qualification result, not
permission for a future job. Further use still needs the separate owner recovery/
activation decision. Do not erase/reinitialize it or silently treat absence as zero.

## Which assumptions are already source/local facts

| Item | Evidence / precise limit |
|---|---|
| Native clients and journal consistency contracts | Offline fixture suites, scripts typecheck, full lint; no provider or durable-auth proof |
| Repository identity | Read-only GitHub metadata: PUBLIC bmson/assistant, repository1304152266, owner890821. Does not prove job artifact ZIP capability |
| Existing declared deployment privileges | github-actions.md76–90: Run admin/Artifact Registry writer/Scheduler admin; explicitly NO Cloud Storage. Not a fresh IAM inventory |
| Existing workflow shape | deploy.yml and retirement workflow: production-deploy, cancel-in-progress:false, main/attempt1/context guards, contents:read/id-token:write, pinned WIF/SDK/artifact actions. Actual environment policy/identity/liveness remains unproved |
| SDK flag behavior | Exact official576 source audit with metadata MD5 match; both flags emit the problematic representation. No SDK/provider experiment |
| Annotation contract | Official v2 annotations/field-mask/etag rules and Kubernetes syntax/size; own8KiB head/64KiB map caps. Actual metadata generation/preservation/conflict behavior unproved |
| Existing verification dependency | apps/agent declares jose; lock pins6.2.14. No new dependency is needed in principle; a verifier import/path/policy still requires source review |
| Last real web observation |41351973081 at6297a84a: exact3desired/2observed mismatch, no apply. This is historical evidence, not a fresh current state or new read budget |
| Retention/phone | Manager-owned CURRENT_ONLY_CLEANUP=false receipt; phone install conditional on verified backend. Neither is changed here |

The independently reviewed simulation logic fixes the initial logical handoff:
PREPARE first, then a fresh exact3/2 packet, then SAME run/job/check-run review
consumption with no intervening ownership/metadata change. Authentication/delivery
of a real manager decision to that live job remains unsupported. A future adapter
cannot choose another composition implicitly. Cold recovery choice above prevents
using a new job's digest-only history to evade this limitation.

## Minimal exact NEXT implementation slice to request

After exact corrected-source review, request ONLY a read-only qualification harness
and offline fixtures, plus an explicitly reviewed manual read-only branch of the
EXISTING deploy.yml so its workflow identity matches the intended production origin.
Proposed selector: workflow_dispatch input native_web_qualification=read_only;
default remains off. This job must skip image build/push, release, delivery holds,
cleanup, journal writes and phone work. It keeps the existing production concurrency,
production environment and first-attempt/main-source requirements. No new permission.

Prospective entrypoint (NOT PRESENT/NOT AUTHORIZED):
`pnpm exec tsx scripts/owner-web-release-qualification.ts --read-only`.
Its transport must reject all Cloud Run methods except fixed GETs; there is no
metadata writer linked to this executable. Use existing supported jose from its
own declared package for signature verification, not unsigned parsing or a new
crypto dependency. Any dependency/import/source change is part of that future review.

Offline tests must verify redaction, actual check-run/job mapping, exact source,
expired/foreign OIDC, missing job/artifact capability, truncated listings, timeout,
GET-only routing and refusal of all mutation modes. Exact-head CI and independent
review precede a separate explicit authorization for ONE hosted dispatch. This
plan neither creates the harness/workflow nor dispatches anything.

## One bounded hosted READ-ONLY dispatch, only after that authorization

Application probe budget: at most20 HTTP requests,15s each,120s overall; fixed
origins and body bounds. This includes OIDC/JWKS, existing WIF STS/IAM token exchange,
redirect/blob and any SDK/library HTTP. No opaque auth action, remote-JWKS fetch or
SDK retry may run outside that shared budget. Use budget-owned fetches and local
JWK verification with the existing library; zero SDK network calls. The only allowed
POSTs are the existing fixed WIF token-exchange/impersonation endpoints, never a
Cloud Run write. Tokens stay private. The audit upload is separately accounted output. No permission probe POST, provider
log sample, native/tag HTTP probe, IAM change, ADC fallback or credential inspection.
No automatic retries or broader capability request on failure.

1. Obtain/verify an ephemeral GitHub OIDC assertion under existing id-token:write;
fixed issuer/JWKS/audience and time/source/repository/environment/run/attempt claims.
Keep bearer material private and ephemeral. Bind check_run_id to the actual job's
exact GitHub check_run_url and numeric job/run/source metadata, never its name.
Use the existing job capability for fixed GitHub metadata calls. Missing claim,
invalid signature, wrong workflow/source/job, denied read or incomplete mapping is
UNKNOWN/HOLD, not a weaker environment-variable substitute.
2. Test READ access under the actual job capability to this ONE exact archive:
- Repository bmson/assistant; deploy run40403696377, attempt1;
  source0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43.
- Artifact ID12690736934; exact name
  release-manifest-0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43;837archive bytes;
  archive SHA2562d4ea8eb94aafc85d1ae2f07c2009378eea7178e61c7dfd57f4e553c14c05d61.
- Expected single member assistant-release-0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43.json,
  from the recorded direct-file upload path; payload SHA256
  88111506b65187b3b24e40e910251420184168ffff7d4fbfe0d2aeb4cc4bf23c.
  The hosted probe must verify the actual ZIP member; a different layout is HOLD.

These pins come from the retained provenance packet and exact historical upload
log, not a new artifact download. Public metadata alone is insufficient. This needs
a NEW bounded manifest-only reader in the authorized implementation scope, sharing
the request/redirect/byte/timeout budget and exact one-member ZIP restrictions.
Do not broaden owner-web-tag-artifact.ts: that reader expects the DIFFERENT
owner-web-tag-creation-<source>-<run>-<attempt> archive with owner-web-tag-creation.json
AND release-manifest.json members. No known existing creation archive is presumed.
This probe qualifies manifest ZIP access only, not creation proof or cold recovery. No new artifact upload or
permission is required by this read-only probe. Failure stops; do not try a PAT,
connector token, anonymous fallback or new actions permission. This does not qualify
streaming upload, finalize/collision behavior, durable private history or cold recovery.
3. The exact reviewed operative set is:
  .github/workflows/deploy.yml, cleanup.yml, owner-web-tag-retirement.yml,
  owner-editor-v1-maintenance.yml, prepare-owner-editor-index.yml,
  workspace-import.yml, workspace-export.yml, owner-editor-release-inventory.yml
  (all basenames after the first are under .github/workflows/).
  The inventory includes the diagnostic WIF holder conservatively. ci.yml and
  self-repair.yml use the demo emulator without production WIF auth in reviewed
  source; ios.yml and agent-image-pr-smoke.yml are not production writers.
  Unknown active workflow paths are HOLD, never silently excluded.

Query scope: five repository-wide GETs to /repos/bmson/assistant/actions/runs,
per_page=100&page=1, one each status=in_progress, queued, waiting, pending, requested;
no branch/event/created-time filter. Match exact workflow paths. total_count>100,
next-page link, missing status/source/path or unsupported query is UNKNOWN; do not
page/retry beyond the budget. Any operative run other than the exact qualifier
is HOLD. Exclude the qualifier only after its authenticated current jobs listing
shows all mutating jobs skipped. Lists are non-atomic and are observations, not
process/token quiescence proof. Completion/teardown/lifetime facts not present in
this bounded inventory remain UNKNOWN for separate owner review. Exclude only this exact source/run/job's read-only qualifier. An old writer,
pending old mutation, self-hosted/unknown runner, incomplete page, uncertain teardown
or unbounded prior credential lifetime leaves quiescence UNKNOWN. Workflow status
alone is not process death or token revocation. Bound maximum old-writer credential
lifetime/hosted teardown from existing reviewed auth/source/evidence; if that cannot
be established without additional access, STOP and report the precise missing fact.
4. Only after identity checks, use existing WIF and pinned SDK capability to perform
at most THREE Cloud Run native GETs: fixed assistant-web and the two pinned immutable
revisions.2MiB/body,15s/call, no listing or arbitrary target. Record bounded raw facts
privately and publish allowlisted hashes/UID/etag/generation/known row facts. Check
current topology, proposed annotation key presence, total-map size, service/template/
image/tagURI identities, settled state and genesis expectations. Wrong/unknown head,
drift or unsupported shape stops. Do not normalize the known mismatch as equality.
5. The only proposed external write in this observational job is its standard
redacted audit artifact; this must be included explicitly in the future dispatch
authorization. It is not an upload/concurrency experiment or mutation capability.
Publish ONE redacted qualification packet using the already supported end-of-job
artifact archival mechanism and STOP. Do not add an unbudgeted audit readback. The existing-manifest ZIP probe already
checks the job read path; audit publication output is not mutation authority. No result carries mutationAuthority.
The source must not turn a successful read-only result into an automatic next stage.

No current read authorization remains. The above counts are a proposal for the
manager's next bounded dispatch decision, not permission to use them now. If all
required facts cannot fit the budget, stop and return UNKNOWN; do not silently page
or fetch more. Scheduled/background application delivery is not manipulated.

## Facts this READ-ONLY slice cannot establish

It cannot prove run.services.update on the exact annotation mask, server etag conflict
behavior, metadata generation semantics, absence of a newly created revision after
metadata update, artifact upload conflict/finalization guarantees, cold proof storage,
privileged-actor absence, or an unsupported manager-approval channel. Source roles,
read success and token availability do not become those facts. Artifacts+concurrency
remain blocked as authoritative head CAS. If bootstrap quiescence/genesis anchor or
artifact origin/access remains unknown, no metadata mutation is eligible for review.

## The later SINGLE metadata qualification, separately reviewed

Only if read-only facts and prerequisites pass, prepare a NEW exact packet naming
source, live service UID/etag/complete preserved-state hashes, absent expected owned
key/genesis condition, exact proposed owned JSON, original annotation-map hash,
executing protected owner identity binding and freshness. The manager must separately
approve that concrete packet and its execution binding; the read-only packet is not
a write token. If the execution job differs, its identity/packet handoff must be
explicitly reviewed before execution, not inferred from the prior qualifier.

A separately source-reviewed one-shot qualifier may then send at most ONE
`PATCH {name,etag,annotations}` with updateMask=annotations, adding only the fixed
genesis key. It has no traffic/template/alias writer or retry/rollback path. Poll
only its returned original fixed operation (shared60GET/180s cap), then bounded
fixed native readback. Confirm exact sole-key delta, same UID/images/template/latest
revisions/traffic/status/root/tagURIs and all unowned settings, new etag and actual
settled generation behavior. Report the generation delta as observed; it does not
prove a universal future policy. Do not manufacture a conflict by issuing another
PATCH: positive server conflict qualification needs a separate later review if
not otherwise proved. No new revision/tag/traffic/epoch/unpause/cleanup is allowed.

STOP immediately after that observation. Metadata failure, lost operation/response,
config drift, unexpected generation behavior, new revision, changed traffic or
artifact failure is HOLD; no inverse PATCH, retry, ownership takeover or initial
reconciliation. A success is metadata qualification only. Private state loss then
uses the fail-closed owner recovery rule above. A fresh separately reviewed known
reconciliation packet, supported real approval channel, normal retirement+600s
barrier, first paired serving proof/delivery restoration and phone installation
remain separate decisions and evidence gates.

### Shared request allocation for the future read-only implementation

The worst-case20application requests are: two OIDC requests (journal audience and
existing provider audience), discovery+JWKS2, existing STS+IAM exchange2, current
run+complete current-job listing2, pinned artifact run-attempt+metadata+ZIP redirect+
blob4, five status listings5, and three fixed native GETs3. Library/SDK requests
consume these same slots; no hidden retries. If a supported flow requires more,
STOP with UNKNOWN and no native/write fallback. Publication of the one redacted
audit artifact is separately bounded/accounted as output; no duplicate-upload
experiment. No qualifier is currently implemented or dispatched.
