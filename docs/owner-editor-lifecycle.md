# People and family editor lifecycle

The editor supports four commands through two exact HTTP adapters. Its signed form handles do not create write authority: each driver must verify the current installation owner, complete privacy generation, editor epoch, original operation hash, live claim, and native source revisions in the same transaction as the primary write and terminal receipt. Receipt revisions identify committed operations; subsequent edits require freshly read native entity revisions.

The runtime never creates an editor epoch. Missing, malformed or disabled epoch metadata leaves browsing available without an editing grant. Enabling an installation is a maintenance operation, separate from shipping this source. PostgreSQL schema migration 0130 and required Firestore indexes must be installed and verified before enabling editing.

## Erasure and retention

An erasure entry transaction rotates an existing editor epoch before deleting receipts. The existing owner privacy fence blocks new reservations and late prepared workers while erasure runs. Receipt pages contain at most 64 PostgreSQL rows or 50 Firestore documents. Their original request digests and identifiers are deleted with the receipt rather than retained indefinitely.

Completion rotates an existing epoch to the new complete privacy generation and preserves its prior enabled or disabled state. A missing epoch stays missing. Firestore includes the committed erasure job's native seconds and nanoseconds in the generation. Its completion therefore has a separate final transaction; interruption between completion and rotation leaves grants unavailable. Retrying completion finishes that rotation without rotating an already synchronized epoch again.

Receipts have a 24-hour replay window measured from original form issuance. Expired receipt cleanup must remain owner-scoped and bounded. A missing receipt is never evidence that an operation did not apply. Only a bound terminal receipt, serialized claim abandonment, or verified scope retirement may release the corresponding pending marker. Retirement makes no historical claim about effects.

## Portable import and controlled restore

Supported portable bundles explicitly exclude editor operations and reserved `owner-editor-epoch:` maintenance cursors. Exclusions are versioned and checksummed. Import rejects supplied runtime editor records; activation rotates fresh runtime authority after the existing cutover, drain and snapshot gates. Import must not copy old claims or receipts into the destination installation.

A raw rollback of the entire database and all epoch/privacy metadata cannot be detected from those same restored records. Before restoring such a snapshot, maintenance must stop ingress and drain every worker that could hold an editor claim. Keep editing disabled during restore and validation. Before resuming ingress, use the existing maintenance-only `rotatePostgresOwnerEditorEpoch` or `rotateFirestoreOwnerEditorEpoch` hook to replace restored authority with a fresh epoch bound to the current complete privacy generation. Set readiness only after the operator's validation gates pass. These hooks are not browser routes and must not run from receipt lookup or ordinary commands.

`scripts/postgres-restore-drill.ts` remains an inert configuration check. It does not restore data, rotate authority, or qualify an installation for activation. Source and offline tests do not prove a live restore, erasure, database concurrency behavior, or deployed readiness; isolated PostgreSQL and Firestore integration checks are separate gates.
