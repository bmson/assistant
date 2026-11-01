# Person-note creation: reader compatibility stage

This source slice recognizes an explicit `create_owner_memory` request under wire/storage protocol version 1. It does not enable creation. The BASIC owner-editor issuer, HTTP release policy, deployment capability list, atomic storage writers and PostgreSQL command constraint still support exactly the existing five commands. The domain rejects creation before storage or provider work. General notes and all removal commands remain unfinished capabilities.

The first creation MVP is **Add a note about this person**. A request must name the displayed person UUID and exact subject revision; it cannot omit the subject, infer an owner contact, or substitute null authority. Its signed target is that subject UUID. General/owner notes need a separate explicitly owner/agent-bound contract.

## Recognized contract

Strict fields: version 1, apply intent, create_owner_memory, original operation UUID, subjectContactId UUID, expectedSubjectRevision SHA-256, trimmed content of 3–4,000 characters, one of the existing seven domains, integer importance 1–5 and boolean pinned. The route is the existing exact memory editor endpoint. Reconciliation retains the original operation and body hash. No new route prefix, Server Action or unsigned mutation path is opened.

Future successful creation receipts contain exactly the newly created memoryId. An `unchanged` creation receipt is invalid: content-hash duplication can establish that a note already exists, but cannot establish that this operation created it. Existing five-command canonical bytes and hashes have fixed regression vectors captured from main `95895c1`.

The shared strict persisted-record codec and browser receipt/pending-marker decoder recognize the new command. Recognition grants no authoring authority. Tests retain signed-scope rejection before backend access and fail-closed domain behavior.

## Reader and schema boundaries

| Surface | Compatibility responsibility |
|---|---|
| Firestore and PostgreSQL recovery/reconcile | Both repositories parse stored operations through the shared strict codec. New-command codec fixtures are source evidence; no new native record is written by this slice. |
| Firestore retention | Mixed old/new synthetic records pass the real retention validator; malformed new records reject the entire page before deletion. |
| PostgreSQL retention/erasure | Owner-scoped projections/deletes do not dispatch by command. The physical command CHECK still excludes creation. A fake new record cannot prove real PostgreSQL persistence. |
| Firestore migration verification | Runtime receipt inventory uses the shared strict codec and owner/physical-identity validation. New receipts remain runtime metadata, not portable content. |
| Portable export/import/restore | All owner-editor operations and epoch runtime authority remain excluded from portable replay. Validation continues to reject runtime metadata records. |
| Privacy erasure | Owner-scoped receipt deletion remains unchanged; old operation history never re-establishes current owner/privacy authority. |
| Old serving and recovery images | Older strict codecs reject new-command rows. Upgrade and verify every retained reader before any new command writes, and pin compatible rollback/recovery images. |

Database-free codec/retention/rejection tests do not prove actual Firestore transactions, PostgreSQL constraint migration, emulator behavior, production traffic or browser durability. Physical new-command PostgreSQL records remain impossible under the current constraint. This is deliberate until the separate writer/migration stage.

## Required next implementation

1. Prepare embeddings outside transactions only after exact current subject/owner/privacy/epoch eligibility. No provider calls occur in this reader stage.
2. Implement driver-specific same-transaction primitives. Existing legacy create() methods own their transactions and cannot be nested into an editor receipt transaction.
3. Re-admit the original claim and recheck actual subject/native revision, content hash and tombstone before the first write. Duplicate or forgotten content yields conflict; it never adopts another note as the operation result.
4. Atomically commit owner/manual/confirmed knowledge provenance, content hash index, vector identity/retrieval revision, owner-card invalidation and terminal saved receipt. No graph source or inferred family assertion is created.
5. Follow-up summary failure must preserve the saved receipt and truthful pending-refresh status. A timeout remains outcome unknown; retain the original handle and reconcile it before another submission.
6. Add PostgreSQL schema migration and independently qualify both native atomic writers, failure rollback, contention, lost response and replay. Only then separately review issuance policy and discoverable UI.

The current release batch and live Library investigation are independent. Merging compatibility source does not enable writes, prove deployment, or complete Add memory.
