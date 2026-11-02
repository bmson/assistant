# Atomic person-note creation: source and test stage

This stage adds internal Firestore and PostgreSQL transaction adapters for `create_owner_memory`. It follows reader draft #763. Production migration, new-command issuance, HTTP admission/recovery, deployment capability and UI remain closed to creation. The existing BASIC5 release gate remains unchanged. General/owner notes and all removal capabilities remain separate unfinished work.

## Person-only boundary

The subject must be an explicit non-owner contact UUID with the displayed exact revision. Preparation rejects owner/self identity, owner trust, missing eligibility and changed owner/privacy/epoch before embedding. It rechecks after asynchronous embedding-space discovery. Both transaction adapters independently reject owner/self contacts even with a matching freshly read native revision, so rebasing the displayed revision cannot turn this into owner-note authority.

Prepared note/retrieval UUIDs, content/hash, subject revision, vector identity and vector are frozen outside SDK transaction callbacks. No provider call occurs within a transaction. The content hash retains existing global dedupe semantics: independent identical content is a conflict, including identical wording for different people. A matching old note is never adopted as this operation's created result. Forgotten hashes are not resurrected.

## Atomic effects

Firestore admits the exact original claim and owner/privacy/epoch, reads contact/native revision, target note, content hash and tombstone before staging any writes, then writes the new manual owner-confirmed knowledge note, hash index, card invalidation and terminal saved receipt in one native transaction. PostgreSQL uses the existing owner/privacy/claim lock order in a serializable transaction, checks the same subject/hash/tombstone policy, then inserts the note, invalidates the card and conditionally stores the receipt. Transaction-local create primitives also preserve the legacy wrapper behavior; the new writer does not nest their old transaction wrappers or invert card/owner locks.

The receipt contains only the new memoryId and commit revision, with refreshPending=true. Post-commit summary refresh is separate and cannot change a saved result to unsaved. Creation dispatches no graph-extraction follow-up. Lost responses and serialization/claim uncertainty remain unknown until the original operation is reconciled; a new operation is not an automatic retry. Two concurrent attempts may encounter native serialization failure, but can never share another operation's note ID as their own success.

## Forward schema change and reader rollout

The actual generation tail was0133 after composing main `4fa99ecb` with reader commit `b8bbe967` (composition `6223b385`). Generated0134_owner_memory_creation changes only the owner-editor command CHECK to recognize creation. Historical SQL stays unchanged; schema, journal, generated snapshot and strict tail guard are updated together. This source change does not authorize production DDL.

All retained serving, recovery, rollback, retention and migration readers must support creation receipts before any new-command writes are enabled. Preserve compatible recovery images and the forward constraint during rollback; disabling admission is separate from downgrading readers/schema. Portable export/import/restore continues to exclude editor receipt/epoch authority. The old reader-stage document records its historical commit boundary, not the new internal adapter availability.

## Evidence boundaries

Database-free tests, native PostgreSQL tests and actual-SDK loopback Firestore tests are separate results. Native tests use explicit owned isolated targets, local credentials/egress guards and bounded cleanup. Failure injection at terminal receipt staging must roll back note/hash/card effects; lost-response injection happens only after an actual commit and must resolve through the original receipt. Contention, forgotten-hash changes, owner trust/self changes, stale native subject revision, owner/privacy/epoch retirement and claim changes are required cases.

Exact source, fixture, runtime, allocation and result hashes are kept in the external task receipts. Native success must be recorded only after those runs complete. No test here is a live web save, genuine owner sign-in, production migration, model/provider performance experiment or activation result.
