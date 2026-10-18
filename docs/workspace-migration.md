# Workspace migration rehearsal

This tooling takes a checksummed, repeatable-read snapshot of a single-owner PostgreSQL installation and imports it into a new Firestore installation. Complete exports cover every table in the migration registry derived from `packages/db/src/schema.ts`, including installation-wide model, budget, cache, sync, and singleton rows. It does not activate the Firestore installation or change the live application backend.

## Export

`pnpm workspace:export` previews without connecting to PostgreSQL. A real export requires the source URL, owner identity, and exact target identity. It never falls back to the application's configured database.

When any of the six vector-bearing tables contains a vector (`messages`, `conversation_segments`, `skills`, `memories`, `writing_samples`, or `document_chunks`), the export also requires verifiable provenance for the existing vector space. Use the provider and model that created the PostgreSQL vectors; migration preserves those vectors and does not re-embed them.

```sh
pnpm workspace:export --export --database-url "$MIGRATION_DATABASE_URL" \
  --agent-id SOURCE_AGENT_UUID --project-id CUSTOMER_PROJECT \
  --database-id DATABASE_ID --installation-id INSTALLATION_ID \
  --embedding-provider PROVIDER --embedding-model MODEL_ID \
  --embedding-dimensions 1536 --embedding-revision REVISION \
  --out workspace-migration.json
```

The source must contain exactly one agent, and that agent must match `--agent-id`. The exporter selects every row of every requested table inside one read-only repeatable-read transaction. This preserves indirect relationships and installation-global rows. IDs, timestamps, decimals, bigint values, bytes, JSON, and vectors use a typed deterministic encoding with record, table, and bundle SHA-256 checksums.

New exports use snapshot version 3. They preserve PostgreSQL timestamp microseconds, including the export timestamp, and use locale-independent ordering for nested values, records, and checksums. Firestore stores timestamps natively; verification and chat pagination retain their exact precision. Version 1 and 2 snapshots remain readable with their original checksum algorithm, which depends on the exporting host's locale. Version 1 timestamps were also truncated to milliseconds and cannot recover the discarded precision. Final cutover requires a fresh version 3 export from the fenced source. File byte counts must fit a safe integer; Gmail history IDs retain their full bigint value.

Output is created with mode 0600 and cannot overwrite an existing file. Treat it as a full private database export. The default table set is the complete current migration registry. `--tables` exists only for focused rehearsals; its manifest has `coverage.complete=false` and lists every omitted source table.

## Audit referenced workspace objects

Before cutover, compare the version 3 snapshot's direct path fields (`files.workspacePath` and `import_sources.workspacePath`) with the installation's private workspace bucket. The audit reads the pinned snapshot and GCS object metadata; it never writes or deletes objects. It reports counts only and does not print file names or contents. Missing counts include lifecycle status grouped by reference table: import-source status or, for task-created files, the associated task status. These labels provide context and do not automatically make missing objects safe. The import runner marks an archive `done` without deleting it; the explicit source-purge flow deletes the source row and object, so a still-present row alone does not prove an intentional purge. In the pinned rehearsal, all 17 missing references have `done` status: 13 import sources and four browser artifacts. The application code has no completion-time cleanup for either class, so these remain unresolved missing assets rather than expected lifecycle deletions. Add `--verify-digests` to stream referenced objects with a recorded SHA-256 and compare bytes; size is compared for `files` rows when the source recorded it. Output separates references that carry expected size or digest metadata from checks that could be performed, so missing objects and absent source checksums remain visible. GCS generations are inventoried, including retained historical versions, but PostgreSQL references do not pin a generation, so only a live current generation is considered available to the application.

```sh
pnpm workspace:assets-audit --snapshot gs://PROJECT-workspace/workspace/INSTALLATION_ID/migration/snapshots/EXECUTION.json \
  --generation SNAPSHOT_GENERATION --sha256 SNAPSHOT_SHA256 \
  --bucket PROJECT-workspace --gcloud-auth --verify-digests
```

The current reference registry covers the database's explicit workspace path columns, including browser screenshots and traces inventoried in `files`. It does not crawl arbitrary JSON, prose, or external URLs for path-like strings; add any future structured asset-reference field to `ASSET_REFERENCE_FIELDS` and its schema coverage test before treating it as covered. A missing object may predate migration, so retain the report and classify each exception instead of deleting or silently dropping the reference.

## Validate and rehearse

```sh
pnpm workspace:import --in workspace-migration.json
```

Preview validates the target identity, source owner, typed values, references, coverage, counts, and checksums. It also runs the complete Firestore transformation, builds every compatibility document, and rejects duplicate destination IDs, excessive nesting, and documents estimated above the 900,000-byte safe inline threshold. A collision-escaped record codec represents JSON arrays nested directly inside arrays as Firestore maps and restores the original arrays on every read. Approval counter derivation follows PostgreSQL's numeric-prefix allocator while preserving suffixless and suffixed historical codes unchanged. Oversize rows need a Cloud Storage payload adapter before cutover; they are never truncated or silently omitted.

A write requires every target identity explicitly and either a local emulator or `--allow-cloud`:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm workspace:import --write \
  --in workspace-migration.json --agent-id SOURCE_AGENT_UUID \
  --project-id demo-assistant-test --database-id '(default)' \
  --installation-id INSTALLATION_ID
```

The importer converts vectors to native Firestore vector values and tags them with the SHA-256 embedding-space key used by the runtime. It remaps `owner_card` and `ambient_snapshots`, and derives Firestore's approval counter, memory hashes, schedule names, generated-card keys, approval-policy keys, channel-message IDs, external-task IDs, tool-call idempotency keys, budget policy, budget period totals, and held-reservation counters. Imported held reservations receive the runtime fingerprint derived from their preserved source fields.

The target must be empty. Import writes a migration marker first and advances a checksum-protected cursor with each batch. A restart verifies the completed prefix before continuing, and conflicting importers or changed documents fail closed. No outbox work is created. Task claims and schedule occurrence commits remain blocked while the marker is pending.

After an import, rerun a read-only parity check:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm workspace:import --verify \
  --in workspace-migration.json --agent-id SOURCE_AGENT_UUID \
  --project-id demo-assistant-test --database-id '(default)' \
  --installation-id INSTALLATION_ID
```

Verification rereads every expected source and derived document, compares its checksum, verifies exact collection counts, and requires a complete `pending_activation` marker for the same bundle. Cloud verification also requires `--allow-cloud` as an explicit target-selection fence.

## Explicit activation after final cutover

Activation is a separate operator action. It re-verifies the complete version 3 bundle against Firestore, reads the specified Cloud Storage object generation with `gcloud storage cat`, checks that those exact pinned bytes match the local bundle, SHA-256, and bundle checksum, then changes the matching migration marker from `pending_activation` to `active` in one Firestore transaction. Cloud activation requires an active `gcloud` identity with read access to that object. Firestore uses ADC by default; add `--gcloud-auth` when ADC is unavailable to use the active `gcloud` identity in memory. The transaction permits only one evidence set; an identical retry is idempotent and a different bundle or evidence set is rejected. Every retry reruns full parity verification, so once normal runtime writes change imported data, replaying the activation command will fail parity rather than treating an old `active` marker as proof of current data integrity. Task claims and schedule occurrence commits become eligible after this marker transition.

Before activation, stop every PostgreSQL writer and background worker, drain in-flight work, and create a fresh complete export after the fence. Activation checks that the bundle export timestamp is not earlier than the recorded drain time. Retain the operator's source-fence/change identifier and the time the drain was confirmed. Supply the exact GCS object URI, generation, and SHA-256 for the exported bytes. The CLI checks that the URI is in this installation's workspace snapshot prefix and reads the exact generation to compare it with the local file bytes. It cannot independently inspect the PostgreSQL write fence; `--source-write-fence-id` and `--source-writes-drained-at` are explicit operator attestations, not proof from PostgreSQL. Do not activate until the external fence and runtime acceptance have been independently confirmed.

```sh
pnpm workspace:import --activate --allow-cloud --gcloud-auth \
  --in final-cutover.json --agent-id SOURCE_AGENT_UUID \
  --project-id CUSTOMER_PROJECT --database-id DATABASE_ID \
  --installation-id INSTALLATION_ID \
  --source-write-fence-id CHANGE_OR_FENCE_IDENTIFIER \
  --source-writes-drained-at 2026-09-23T06:30:00.000Z \
  --snapshot-uri gs://CUSTOMER_PROJECT-workspace/workspace/INSTALLATION_ID/migration/snapshots/EXECUTION.json \
  --snapshot-generation SNAPSHOT_GENERATION \
  --snapshot-sha256 SNAPSHOT_SHA256
```

The command never prints snapshot contents or credentials. This activation command does not change the Cloud Run persistence driver or delete PostgreSQL. A production cutover still requires application deployment/configuration, workload acceptance, a verified managed Firestore backup and restore, and a separately retained PostgreSQL backup.

## Firestore backup and restore rehearsal

After Firestore activation, PostgreSQL-independent recovery uses Firestore's managed export/import service. It exports the complete customer database to a customer-owned GCS prefix. The version 2 companion manifest records the source identity, completed operation, resolved export prefix, every export object's generation/size/checksum, document counts, collection paths, and a canonical SHA-256 inventory using Firestore wire types. Recursive traversal includes nested collections beneath missing ancestor documents.

Preview is read-only:

```sh
pnpm exec tsx scripts/firestore-managed-backup.ts --backup \
  --project-id CUSTOMER_PROJECT --database-id DATABASE_ID \
  --installation-id INSTALLATION_ID \
  --gcs-prefix gs://CUSTOMER_BACKUP_BUCKET/firestore/BACKUP_ID \
  --snapshot-time 2026-09-19T12:34:00Z \
  --manifest firestore-backup-manifest.json
```

Execution requires explicit `--execute` and a recent past UTC minute. Both the recursive inventory and managed export use that exact snapshot time, so their contents remain comparable while later writes continue. Google requires the export timestamp to be rounded to the minute and within retained database history ([export API](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases/exportDocuments)). Credentials need Firestore export/import permission and write/read access to the customer-owned bucket. The local manifest is created mode 0600 and never overwrites an existing file. Final migration cutover still requires its separate application write fence.

The source database must have point-in-time recovery enabled for snapshot exports, even within the past hour. The consumer Terraform configuration enables it; the backup preflight verifies it and the earliest retained timestamp before scanning records. PITR storage is billed to the customer project and has no free tier ([Google PITR documentation](https://docs.cloud.google.com/firestore/native/docs/pitr)).

```sh
pnpm exec tsx scripts/firestore-managed-backup.ts --backup --execute \
  --project-id CUSTOMER_PROJECT --database-id DATABASE_ID \
  --installation-id INSTALLATION_ID \
  --gcs-prefix gs://CUSTOMER_BACKUP_BUCKET/firestore/BACKUP_ID \
  --snapshot-time 2026-09-19T12:34:00Z \
  --manifest firestore-backup-manifest.json
```

Restore creates a distinct Firestore database whose ID begins with `assistant-restore-`, using the requested location, and requires the same installation identity. A successful create operation is the exclusivity fence: an existing database cannot be adopted or overwritten, and the restore database must not be configured in the application while rehearsal runs. Tooling re-verifies the complete export object manifest around import. After import completes, it reads the target at one server-reported timestamp and requires exact document counts, collection paths, installation roots, and canonical hash parity. It refuses emulator routing, same-database restore, cross-installation restore, an existing/non-empty target, changed export objects, and parity failures.

Google's managed import rebases native references onto the restore database, including references originally pointing at other projects or databases. The inventory hashes source-local references by their unchanged document-relative path, including within arrays and maps. Native external references retain their full identity in the inventory hash and are counted separately; backup and restore preflight reject a nonzero external-reference count before export or database creation. This prevents a managed restore from silently changing their targets. Ordinary string IDs are unaffected. A database containing native external references needs a separate lossless reference-preservation mechanism before this managed workflow can be used. All other value types and document paths remain part of the exact checksum comparison.

```sh
pnpm exec tsx scripts/firestore-managed-backup.ts --restore --execute \
  --project-id CUSTOMER_PROJECT --database-id assistant-restore-UNIQUE_ID \
  --location FIRESTORE_LOCATION \
  --installation-id INSTALLATION_ID \
  --manifest firestore-backup-manifest.json
```

The Firestore emulator does not implement managed export/import, so unit tests exercise mocked control-plane operations, raw document traversal, and wire-type hashing. The live rehearsal remains a customer-project acceptance step. Firestore export does not copy referenced workspace objects from GCS; those objects require their own versioned backup and digest-verified restore rehearsal.

For a synthetic managed export/import rehearsal, run `pnpm firestore:backup-smoke --project PROJECT --location REGION --gcs-prefix gs://CUSTOMER_BUCKET/synthetic-firestore-validation/UNIQUE_RUN`. Preview performs no authentication or writes; add `--run` to create the two temporary databases. The smoke seeds native types and missing-parent descendants, exports a consistent snapshot, restores it, verifies the inventory, and deletes only databases whose creation it owns. Export files remain in the supplied bucket prefix. The validation, backup, and smoke CLIs accept explicit `--gcloud-auth` for development sessions with an active Google CLI account; credentials stay in memory and ADC remains the default.

## PostgreSQL retirement gate

Do not delete PostgreSQL based only on a successful import. Retirement requires all of the following evidence:

1. The export manifest reports `coverage.complete=true`, every table in the current migration registry, no omissions, and the intended vector provenance.
2. Import preview reports no oversize or duplicate destination records.
3. The emulator rehearsal and customer import both finish with `verified=true`.
4. Runtime acceptance covers chat/history recall, GraphRAG, memory and skill vector recall, approvals, reminders/schedules, model routing, budget totals and held reservations, owner context, files/documents, and customer authentication.
5. A managed Firestore export completes into the customer-owned backup bucket, and its manifest records a verified metadata object plus canonical database inventory.
6. That export restores into a distinct empty database with exact document-count, collection-count, and canonical-hash parity.
7. The application is explicitly activated on Firestore, observed under real workload, and a separately retained PostgreSQL backup has passed its retention window.

The database snapshot preserves the `files` inventory and checksums; the referenced workspace/Cloud Storage objects must be copied and digest-verified through the storage transfer path as a separate acceptance item. There is deliberately no activation or PostgreSQL deletion command in this tooling. Those actions remain separate cutover decisions after runtime acceptance.

## Installation owner validation

An installation currently supports one owner. Agent readiness and chat resolution reject an installation with zero or multiple owners, except that an empty Firestore destination may remain inert while a controlled import is prepared. Firestore maintenance rechecks the sole owner and activation checks that it matches the imported workspace.

Import preview does not access the destination and returns `destinationOwnerChecked: false`. Write and verify modes check the destination owner before updating migration markers or data. A configured agent identifier does not bypass the sole-owner check. This boundary does not add support for multiple tenants; legacy administrative database writers and every recovery path still need qualification.
