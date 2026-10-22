# Calendar sharing compatibility bridge

These notes describe the frozen C bridge release `a9b493383a3ff5077e156df04c527401497ea8b9`.
The subsequent B sharing release adds migration 129, requires 129 for agent/web,
and replaces the bridge HTTP mutation rejection with the owner-, publisher-, and
generation-checked protocol. It retains the bridge privacy/export and rollback
protection, along with 129-compatible selected-worker ranges. B must not merge
until C is verified serving through the normal automatic pipeline.

This release keeps the PostgreSQL journal at 128. Migration 129 belongs to the
later calendar-sharing release. Its reviewed SQL only adds
`phone_calendar_sharing` with an owner foreign key, check, and unique index.
The test fixture is byte-pinned to SHA-256
`09047938c28be5eb0232176d4452aea14960fe563dff097d7dbc467d62e51a6a`;
it is never part of the migration journal.

Newly built agent/web images declare PostgreSQL 128–129. Browser, code-runner,
and document-processor images retain minimum 0 and raise their maximum to 129.
Their entry points use workspace storage and authenticated callbacks, not
PostgreSQL: no SQL driver or database configuration is introduced. Their existing
runtime tests and the complete selected-worker manifest fixtures validate this
range. Firestore remains storage contract 1.

## Behavior across versions

On PostgreSQL 128 the read adapter detects that the sharing table is absent and
preserves legacy cached-source reads. On 129 it validates owner-bound v1 consent
with the shared protocol parser. A known enabled selection stays visible as
unavailable/incomplete; this bridge never consumes B's cached event details or
asserts current availability. Disabled or absent consent does not expose cached
events. Firestore applies the same protection once a sharing-state document
exists. Corrupt or foreign state fails closed.

Both legacy HTTP PUT and DELETE authenticate and then reject with 503 before
opening storage. They cannot overwrite a newer publisher snapshot, delete its
cache, bypass generation checks, or acknowledge a removal they did not perform.
The direct legacy persistence helper also rejects every bridge-wired repository
before storage access, avoiding a check-then-write race with consent changes. This bridge has no publisher mutation endpoint or native feature
activation.

Privacy erasure conditionally handles the 129 table under the existing owner
and erasure transaction, and always purges the phone event cache. It reuses the
shared scrubbed generation tombstone rather than deleting/resetting consent.
Firestore performs state scrubbing and cache deletion atomically within the
current erasure job. A completed erase rejects old initial-consent replay;
resuming cleanup does not increment an already scrubbed tombstone again.

Owner export includes bounded consent and selected-calendar metadata. Publisher
and mutation tokens stay excluded. Event snapshots remain transient cache data
and are explicitly excluded from the export; erasure removes them. This is a
consent-metadata export, not an export of calendar event content.

## Merge and automatic release order

1. Land the final schema-128 semantic fixes (A).
2. Build and test this bridge (C), including final A and the frozen pure protocol
   (P), on both absent-128 and populated-129 fixtures. Merge C after review.
3. Let the normal automatic pipeline deploy C. Verify that the serving agent and
   web are the exact bridge release and declare 128–129 before merging B.
4. B adds migration 129 and requires 129 for agent/web, preserving compatible
   selected-worker ranges. Its rollback target must be C, never an old 128-only
   artifact. B must reconcile its publisher implementation with these bridge
   read/erasure/export hooks rather than leaving competing implementations.

Existing artifact declarations and serving-revision metadata are never relabeled.
The live compatibility preflight, backup, migration, staged probes, and rollback
safeguards remain unchanged. No manual deployment or native distribution is part
of this work.
