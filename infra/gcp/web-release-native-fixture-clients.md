# Native web fixture clients — unwired source step2

The creation and traffic wrappers require injected request/clock/sleep/intent hooks.
There is no fetch default, token lookup, credential, CLI, workflow or production
caller. The hooks in the tests simulate transport and private in-memory recording;
they do not establish authenticated durable storage or deployment authority.

The creation wrapper permits only createP/createR with `updateMask=template` and
exact `{name,etag,template}` body. The traffic wrapper permits only the eight
reviewed lifecycle modes and `updateMask=traffic`, exact `{name,etag,traffic}`.
The existing retirement transport and strict comparator are unchanged. Both use
the sealed pure model's phase/identity rules, re-read the raw service and finite
fixed revisions, reconstruct all proof projections and require exact fresh equality
with the reviewed state before generating a request. A caller-supplied projection,
hash or readiness boolean cannot replace these reads. A creation also requires a
404 at the deterministic revision's exact fixed endpoint; an existing revision is
HOLD, never adopted as a successful new creation.

Raw validation requires the fixed service/parent/revision names, native settled
success, explicit REVISION targets, exact model traffic equality, native UID/image/
manifest/source/run/attempt/pause proof, complete supported template schema and
preservation hashes. The pre-release C proof is restricted to the reviewed pinned
historical current revision for this first paired rollout. P/R are limited to the
protected-context deterministic names. Known C URI hashes remain pinned; new tags
must use the native fixed-service tag hostname. Private environment/secret/template
values are only used in memory to validate/preserve exact configuration. Safe errors
and checkpoint metadata contain no raw payload, URI, template or credential.
Returned successful model state and the fixture intent hook are private internal
values; they must never be emitted as logs or public receipts by a future adapter.

Transport URLs are fixed to the Cloud Run v2 service, those finite revisions or
one validated project/region operation. Redirects are errors. JSON-only successful
responses are decoded with strict UTF8, streamed at most2MiB, within a15s deadline
that also bounds stalled headers, body reads, cancellation and abort-ignoring
callbacks. Non-success bodies are canceled without disclosure. There are at most
100 actual requests across one attempt and its one GET-only recovery. A PATCH is
sent once, with the fresh native etag; even a412 remains possibly attempted. There
are no write retries, allowMissing, SDK calls or flag substitutions.

The original returned operation name is retained privately. Polling is GET-only,
maximum60polls/180s with its original deadline retained through recovery. No later
caller-supplied operation is accepted. An unknown response without a bound operation
cannot recover or adopt a revision. With a bound operation, at most one recovery
may GET only that operation and fixed poststate; it cannot send a PATCH. Fresh raw
postchecks reconstruct the projections and require the model's new etag/newer
settled generation, native identities and exact phase map. A completed provider
operation with a failed completion-receipt hook remains unknown; it does not become
a success or authorize another write. A failed intent hook before PATCH sends no
mutation. Deadline/size/drift errors stay HOLD with sticky uncertainty afterward.

These tests use synthetic raw HTTP responses only. They do not establish actual
Cloud Run template preservation, native defaults/shape acceptance, serving release
or delivery guard restoration. Unsupported native shapes refuse rather than
coalesce or weaken comparison. The full source model/templates are not production
artifacts or mutation tokens. Authenticated origin, durable chain history,
monotonic storage/CAS, source/workflow/manifest/owner approval, production concurrency
and credential binding remain explicit unresolved integration gates. They must be
reviewed before any production adapter/callsite scope is implemented. Unkeyed state
seals and successful fake hooks do not meet those gates. Cleanup retention remains
manager-owned false; historical retirement/full600s drain and phone sequencing
remain separate and unchanged.
