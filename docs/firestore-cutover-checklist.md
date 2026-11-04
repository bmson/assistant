# Complete Firestore cutover

The migration is complete only when production can operate with the old PostgreSQL database unavailable and every source record and stored asset is accounted for. Adapter releases and synthetic chat tests are intermediate evidence.

## Acceptance gates

- [ ] Every enabled web, mobile, agent, module, worker, maintenance, and tool path uses Firestore-compatible persistence. No SQL fallback may run in the Firestore composition.
- [ ] Complete source inventory covers all database tables, object storage, secrets, external integration credentials, schedules, active work, and vector embedding provenance. Sensitive values stay out of reports and logs.
- [ ] Complete, consistent export and resumable import preserve records, references, timestamps, bytes, decimal values, privacy markers, and compatible vectors. Oversized records and Firestore-specific derived records are handled explicitly.
- [ ] Source-to-target parity is verified by table counts and canonical record hashes; any intended transformation has an explicit verified mapping. Historical and active data are both covered.
- [ ] A rehearsal starts the complete application against the migrated target with PostgreSQL unavailable and exercises authenticated web/mobile chat, tools, recall, approvals, schedules, background jobs, uploads, and enabled integrations.
- [ ] Customer-owned deployment has runtime IAM, indexes, queues, scheduler, storage, secrets, authentication, owner onboarding, and the guided installer. No publisher-owned paid runtime dependency is required.
- [ ] Firestore backup/export and restore have been tested into an isolated target, including externally stored assets and encryption prerequisites.
- [ ] Final cutover freezes source writes and drains or fences active work, captures the final consistent data set, verifies parity, activates exactly one scheduler/dispatcher, and switches production.
- [ ] Live verification shows the exact release commit, working end-to-end application behavior, and no PostgreSQL connections or database-secret dependency. Rollback instructions and the recovery archive are usable.
- [ ] Old database retirement is ready: the user has a concrete evidence report showing that deleting it will remove no remaining runtime or recovery dependency.

## Final cutover runbook

`pnpm cutover` runs the final cutover as fifteen resumable steps. Each step writes one private JSON evidence file (`NN-step.json`, mode 0600) to the evidence directory. Every file records the configuration hash and the SHA-256 of the previous step's file, so a changed configuration or an edited file is detected. A step runs only after every earlier step has passed under the same configuration. A passed step is never re-run, and its file is never overwritten. A failed attempt is kept as `NN-step.failed-<time>.json`, and the step can be retried. **Every step that changes production refuses to run unless `--confirm` names that exact step.** Nothing in CI runs these commands.

Before the maintenance window:

1. Merge and release the commit that will serve production. Its migration image must be deployed (`assistant-migrate` runs `migrate:<releaseSha>`), and the web/agent images for the Firestore composition must be built from the same commit.
2. Rehearse the [Neon provider fence](firestore-source-write-fence.md#neon-provider-fence-design) on a disposable Neon branch.
3. Create an empty target Firestore database with PITR and ready indexes (`pnpm firestore:indexes`). Confirm the Firestore composition passed its PostgreSQL-offline acceptance run.
   Grant each serving identity (`assistant-web@`, `assistant-agent@`) `roles/datastore.user` on the target database, for example conditioned on `resource.name == "projects/<project>/databases/<target>"`. Access granted for a rehearsal database does not carry over. Preflight refuses to run without the grant, because once `switch-services` runs every Firestore call would be denied.
4. Write the configuration file. It holds no secrets and should be kept with the evidence:

```json
{
  "gcp": { "project": "bmson-assistant", "region": "us-west1", "firestoreLocation": "us-west1" },
  "installationId": "assistant",
  "workspaceBucket": "bmson-assistant-workspace",
  "releaseSha": "<40-hex release commit>",
  "sourceAgentId": "<PostgreSQL owner agent UUID>",
  "embedding": {
    "provider": "<source provider>",
    "model": "<model>",
    "dimensions": 1536,
    "revision": "<revision>"
  },
  "firestoreDatabaseId": "assistant-production",
  "neon": {
    "projectId": "<neon project>",
    "branchId": "br-...",
    "endpointId": "ep-...",
    "snapshotBranchName": "cutover-final-YYYYMMDD"
  },
  "fence": { "samples": 3, "intervalSeconds": 3600, "allowAvailabilityStarts": false },
  "sourceDatabaseSecret": "database-url",
  "exportDatabaseSecret": "database-url-final-export",
  "exportServiceAccount": "assistant-agent@bmson-assistant.iam.gserviceaccount.com",
  "appWriteGateServices": ["assistant-web", "assistant-agent"],
  "assets": {
    "recoveryManifest": ".workspace/firestore-cutover/<recovery manifest>.json",
    "recoveryPrefix": "gs://bmson-assistant-workspace/workspace/assistant/migration-recovery/source-missing-20260923T092250Z-f1734efe/",
    "backupPrefix": "gs://<separate backup bucket>/assistant/final-YYYYMMDD/assets/",
    "restorePrefix": "gs://<separate backup bucket>/assistant/final-YYYYMMDD/assets-restore/",
    "expectedRecovered": 12,
    "expectedUnresolved": 5
  },
  "firestoreBackup": {
    "gcsPrefix": "gs://bmson-assistant-workspace/workspace/assistant/firestore-backups/final-YYYYMMDD",
    "restoreDatabaseId": "assistant-restore-final-YYYYMMDD"
  },
  "services": [
    {
      "name": "assistant-web",
      "image": "<web image @sha256 digest>",
      "env": { "PERSISTENCE_DRIVER": "firestore", "FIRESTORE_DATABASE_ID": "assistant-production" },
      "secrets": {},
      "health": { "path": "/api/health", "expectReleaseSha": true }
    },
    {
      "name": "assistant-agent",
      "image": "<agent image @sha256 digest>",
      "env": { "PERSISTENCE_DRIVER": "firestore", "FIRESTORE_DATABASE_ID": "assistant-production" },
      "secrets": {},
      "ready": { "path": "/ready", "authenticated": true, "expectDatabase": "firestore" }
    }
  ],
  "dispatcher": {
    "schedulerJobs": ["assistant-sweep"],
    "queues": [],
    "pushSubscriptions": [],
    "acceptLegacyTaskBacklog": false
  }
}
```

The configuration is rejected in any of these cases: a service's env or secrets names a database setting; it lacks `PERSISTENCE_DRIVER=firestore`; its image is neither a digest nor tagged with `releaseSha`; the export secret is `database-url` itself; or the target is a restore database. The `services[].env` and `secrets` maps must contain the complete Firestore composition, including `FIRESTORE_AGENT_ID`, `FIRESTORE_EMBEDDING_SPACE`, `QUEUE_DRIVER`, and module settings. The step only adds or replaces those values and removes database settings.

Run the steps from the repository root on the owner's machine. Use `gcloud` authenticated as the owner and the Neon API key in the environment:

```sh
export NEON_API_KEY=...   # owner's Neon API key; revoke after cutover
C="--config cutover.json --evidence-dir .workspace/firestore-cutover/final-YYYYMMDD"
pnpm cutover status $C
pnpm cutover run preflight $C
pnpm cutover run quiesce $C --confirm quiesce
pnpm cutover run fence $C --confirm fence
pnpm cutover run drain-proof $C              # waits samples x intervalSeconds
pnpm cutover run snapshot-branch $C --confirm snapshot-branch
pnpm cutover run final-export $C --confirm final-export
pnpm cutover run source-witness $C --confirm source-witness
pnpm cutover run import $C --confirm import
pnpm cutover run verify-import $C
pnpm cutover run assets $C --confirm assets
pnpm cutover run firestore-backup $C --confirm firestore-backup
pnpm cutover run activate $C --confirm activate
pnpm cutover run switch-services $C --confirm switch-services
pnpm cutover run dispatcher $C --confirm dispatcher
pnpm cutover run live-verify $C
```

| #   | Step               | Changes production                  | Pass criteria recorded in evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `preflight`        | no                                  | Active `gcloud` account. Writer inventory recorded as names, states, hosts, and secret references (full push endpoints go only to `private/`). Migration image matches `releaseSha`. Target database exists with PITR. Restore database does not exist yet. The configured services and dispatch resources exist. `database-url` points at the configured Neon endpoint. The recovery manifest lists the expected 12 recovered and 5 unresolved references. Last aggregate source session inventory. |
| 2   | `quiesce`          | yes                                 | Every enabled Scheduler job is paused, every running queue is paused, and every push subscription that targets a Cloud Run service is converted to pull (its backlog is kept). `POSTGRES_SOURCE_WRITES_FENCED=true` is set on the listed services as defense in depth. A fresh inventory shows nothing dispatching.                                                                                                                                                                                  |
| 3   | `fence`            | yes                                 | Neon read-write endpoint disabled and idle. The `suspend_compute` operation ID becomes the fence ID.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | `drain-proof`      | no                                  | Repeated fence samples over `samples × intervalSeconds`, each refused by the server on both the direct and pooled hosts. No compute start after the fence. Dispatch still idle. Queue backlog counted. `drainedAt` is recorded.                                                                                                                                                                                                                                                                      |
| 5   | `snapshot-branch`  | yes                                 | Read-only snapshot branch, its LSN, and proof that the standby rejects writes. The `database-url-final-export` secret version (the value is never recorded), granted to the export identity.                                                                                                                                                                                                                                                                                                         |
| 6   | `final-export`     | yes (Cloud Run job, new GCS object) | The export job reads the snapshot secret. The v3 bundle is complete and has the configured source and target identities. Object generation, size, and SHA-256 are pinned. The bytes are downloaded to `private/final-snapshot.json`, and `exportedAt` is at or after `drainedAt`. Per-table counts and checksums are recorded.                                                                                                                                                                       |
| 7   | `source-witness`   | yes (temporary branch)              | The witness branch LSN equals the snapshot LSN, the source is still fenced, and the witness has been deleted.                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | `import`           | yes                                 | Preview, then write into the empty target. The write verified itself, its write count equals the preview's, and it pinned the exported SHA-256.                                                                                                                                                                                                                                                                                                                                                      |
| 9   | `verify-import`    | no                                  | A separate verify-mode job matches record count, document writes, per-collection counts, and bundle checksum.                                                                                                                                                                                                                                                                                                                                                                                        |
| 10  | `assets`           | yes (create-only copies)            | The asset audit shows no digest or size mismatch. The recovery resolver has nothing left to copy, and all 12 recovered objects are live with their recovery SHA-256. Every present referenced object is copied create-only to the backup prefix and restored to a separate prefix with identical SHA-256. No missing object falls outside the recovery manifest. The 5 unresolved references are listed as `owner-accepted-loss-required`.                                                           |
| 11  | `firestore-backup` | yes                                 | Managed backup of the target (document count equals imported writes) is restored into the isolated `assistant-restore-*` database with equal document count and canonical hash. The isolated database is then deleted.                                                                                                                                                                                                                                                                               |
| 12  | `activate`         | yes                                 | Runs only while zero dispatchers are running. Runs `workspace:import --activate` with the Neon fence ID, `drainedAt`, and the pinned snapshot, and checks that the bundle checksum matches.                                                                                                                                                                                                                                                                                                          |
| 13  | `switch-services`  | yes                                 | Each service runs the configured image and the Firestore env, with every database env name and secret reference removed and 100% of traffic on the new revision. The previous revision is recorded for rollback.                                                                                                                                                                                                                                                                                     |
| 14  | `dispatcher`       | yes                                 | Enabled Scheduler jobs, running queues, and push subscriptions are exactly the configured sets, and each targets a switched service. It refuses to resume a queue that holds legacy tasks unless `acceptLegacyTaskBacklog` is set.                                                                                                                                                                                                                                                                   |
| 15  | `live-verify`      | no                                  | Each service reports the release SHA (`/api/health`), and Firestore readiness where configured (`/ready` with `database: firestore`). Templates have no database env or secret. No other serving service references the database, and jobs that still do are listed. The Neon source is still fenced, so no PostgreSQL connection is possible.                                                                                                                                                       |

The order differs slightly from the checklist wording: `activate` flips the Firestore marker while **no** dispatcher runs, the services are switched, and only then does `dispatcher` resume the single Firestore dispatch path. At no point do PostgreSQL and Firestore dispatchers run together.

### Rollback

```sh
pnpm cutover rollback $C --confirm rollback                                  # before switch-services
pnpm cutover rollback $C --confirm rollback --accept-firestore-divergence    # after switch-services
```

Rollback runs in this order:

1. Pause the configured Firestore dispatch resources.
2. Re-enable the Neon endpoint and check that it is writable, without writing.
3. Route each touched service back to its exact preflight revisions. This also drops the app write gate.
4. Resume the preflight Scheduler jobs and queues, and restore the recorded push endpoints.

It then compares the traffic and dispatch state with preflight and writes `rollback-<time>.json`. Writes made in Firestore after `switch-services` do not return to PostgreSQL. That is why the extra flag is required. The Firestore target keeps its data, so a later cutover attempt must import into a new empty database. Keep the snapshot branch, the final snapshot object, the Firestore backup, and the asset backup until retirement.

### Retirement evidence report

After `live-verify` and an observation window, generate the report required by the last acceptance gate:

```sh
pnpm cutover:retirement-report $C --decisions owner-decisions.json --out retirement-report.md --live
```

The report combines the evidence files, a scan of every tracked repository file, and (with `--live`) a fresh inventory of Cloud Run services and jobs, Scheduler, Pub/Sub, and Secret Manager names. `--live` uses read-only `list`/`describe` calls only. It writes `retirement-report.md` and `retirement-report.md.json` (create-only, mode 0600) and exits non-zero unless every gate passes. The verdict is **READY** only when all of these hold:

- every cutover step passed under the same configuration and the evidence chain is intact;
- production has run on Firestore for `--min-observation-hours` (default 168) since `live-verify`;
- no Cloud Run service or job references `DATABASE_URL` or a `database-url*`, Neon, or PostgreSQL secret;
- every enabled Scheduler job and push subscription targets a switched Firestore service;
- no repository file in a blocking class references the database. The blocking classes are release pipeline, backup tooling, Terraform, non-local CI, and unclassified files. The report also lists the non-blocking classes: inactive application code, manual migration tooling, operator scripts, tests, local development, and documentation;
- the Firestore backup restored with hash parity, and every present asset (including the 12 recovered objects) was backed up and restored with SHA-256 parity;
- the owner recorded a separately retained PostgreSQL archive with a tested restore;
- the owner recorded an accepted-loss decision for each asset reference without recoverable bytes. Five such references are known today (two import originals and three generated artifacts).

The decisions file is written by the owner and never generated:

```json
{
  "acceptedLosses": [
    {
      "sourceRecordId": "<record id from the assets evidence>",
      "decision": "accepted-loss",
      "decidedBy": "<owner>",
      "decidedAt": "2026-10-01T10:00:00Z",
      "reason": "<why the bytes cannot be recovered>"
    }
  ],
  "postgresArchive": {
    "uri": "gs://...",
    "generation": "...",
    "sha256": "...",
    "restoreTestedAt": "2026-10-01T09:00:00Z",
    "retainedUntil": "2027-10-01T00:00:00Z"
  }
}
```

The release path is split by persistence driver, so the static scan passes for the Firestore path. `pnpm cutover:retirement-report --static-only` runs in CI and proves two things:

- `infra/gcp/release.sh` hands over to `infra/gcp/release-firestore.sh`;
- nothing that release reaches (scripts, Cloud Build config, Dockerfiles) references the database.

These files still reference the database. They are reported as `postgres-only`, and remain so only while the proof holds:

| File                                                       | Why it cannot run on the Firestore path                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/gcp/release-postgres.sh`                            | The original release, renamed without edits. `release.sh` runs it only when the live services use `PERSISTENCE_DRIVER=postgres`.          |
| `infra/gcp/release-diagnostics.sh`                         | Migration diagnostics, sourced only by `release-postgres.sh`.                                                                             |
| `infra/gcp/deploy.sh`                                      | The PostgreSQL provisioner. It refuses to run once `assistant-agent` uses Firestore, because it would reattach the `database-url` secret. |
| `infra/docker/backup.sh`, `infra/docker/database-admin.sh` | The `pg_dump` backup image. Only `release-postgres.sh` runs it, and a Firestore deploy does not build it.                                 |

Delete these files together with the database. After a READY report, the report lists the retirement actions in order:

1. Delete the Neon project and branches.
2. Delete the `database-url*` secrets.
3. Revoke the Neon API key.
4. Remove the revisions and jobs that still reference the database. Deleting those revisions ends the PostgreSQL rollback path.

### Releases after the cutover

`switch-services` sets `PERSISTENCE_DRIVER=firestore` on both services, so the next `bash infra/gcp/release.sh` selects the Firestore path by itself. After the cutover, also set the GitHub repository variable `PERSISTENCE_DRIVER=firestore`. With it set:

- the `Deploy production` workflow stops building the backup and migration images;
- every release asserts that the live services agree with the variable.

The deploy identity reads Firestore metadata for these gates. It needs a role with `datastore.databases.get`, `datastore.databases.getMetadata`, `datastore.backups.list`, `datastore.backups.get`, `datastore.locations.list`, `datastore.indexes.list` and `datastore.indexes.get`. Production uses the custom role `assistantReleaseFirestoreGates`, which grants no document access.

The Firestore release runs no database step. Before it rolls out any revision, three gates must pass:

1. Both service templates are database-free.
2. A managed Firestore recovery point covers the pre-release state: point-in-time recovery, or a READY scheduled backup no older than `FIRESTORE_BACKUP_MAX_AGE_HOURS` (default 26).
3. `pnpm firestore:indexes verify` matches the release's index manifest.


## Production cutover (2026-09-26)

All 15 steps passed on release `1d2d062c`, and Firestore (`assistant-production`) has been authoritative since `switch-services` at about 23:37 UTC. The write-fence window, from `quiesce` to `switch-services`, ran from 19:38 to 23:37 UTC. It included a 30-minute drain proof (3 × 900 s), several retries, and the managed backup and restore.

- **Data.** 79,393 source records were imported as 97,484 documents and independently verified. 22 present assets and the 12 recovered objects were backed up and restored with SHA-256 parity. 5 references remain unresolved and need owner accepted-loss decisions at retirement.
- **Tooling fixes found during the run** (#432, #433, and the `BUILD_SHA` fix):
  - `gcloud` 586 vector-index syntax
  - the push-subscription OIDC identity through dispatcher and rollback
  - job summaries logged as `jsonPayload`, and log ingestion lag
  - `assets` treating expected findings as fatal
  - a preflight check for runtime Firestore access
  - `switch-services` pinning `BUILD_SHA`
- **Outage.** From 23:37 to 23:53 UTC, the agent and web identities had Firestore access only on a rehearsal database, so every Firestore call was denied: agent `/ready` and Gmail push returned 503. Pub/Sub redelivered the pushes after the grant.
- **Evidence.** The owner's checkout holds it under `.workspace/firestore-cutover/final`, next to `cutover.json`.

Retirement follows the report above once the observation window has passed.

## Active work

Recovery baseline (2026-09-19): application commit `259d4ecaf8624ea3c337647d442b5b90ea2a29a1`. PostgreSQL is still authoritative. The saved migration work has been reconciled with current chat visibility, immediate memory corrections, and generated-card refresh behavior. The complete installer and production data cutover are unfinished.

The September 12 source snapshot passed offline preview, full local Firestore emulator import, and a separate verification pass: 61,382 source records, 14,565 derived documents, 75,947 total writes including the migration marker. Every source table was covered. Legacy approval codes and nested JSON arrays are preserved. This is a rehearsal snapshot; production still needs a fresh final export after writes are fenced.

Application chat, historical/graph recall, memory save/recall, generated cards, and scheduled follow-up tools now have portable adapters. Remaining work includes runtime composition, enabled module/tool and management domains, memory writers, customer deployment/onboarding, object verification, backup/restore, and final cutover. The old database remains intact until the acceptance gates establish that it is safe to remove.

The real Google query/runtime validator passed with 49 indexes and 16 field exemptions, including the exercised chat and recall paths with zero SQL access. An isolated GCS rehearsal backed up and restored all 86 available application assets (60,038,954 bytes), with matching source/backup/restore SHA-256 and byte counts. Seventeen referenced objects were already absent at source; their metadata remains preserved. These results do not establish full production runtime portability or final cutover parity.

A separate real Firestore managed export/import smoke passed inventory and checksum parity for mixed native values, nested local references, and missing-parent descendants. Both temporary databases were deleted. The backup tool now requires PITR and rejects native references to external databases/projects because Google's managed import changes their targets. A complete production-data backup/restore remains required before retirement.

The manual [Cloud Run source snapshot workflow](firestore-production-export.md) can capture a fresh read-only PostgreSQL v3 bundle directly into the installation's private workspace bucket without disclosing the database URL to GitHub Actions. An unfenced snapshot remains a rehearsal until the final source write freeze and parity gates above pass.

The matching [Cloud Run import workflow](firestore-production-import.md) pins a private snapshot by object generation and SHA-256, previews all target writes, imports only into an empty installation, and verifies document checksums and collection counts. These are manual rehearsal capabilities; runtime activation and database retirement still require every acceptance gate above.

The [PostgreSQL source write-fence procedure](firestore-source-write-fence.md) now includes a Neon provider-level fence (disabled read-write endpoint, repeated refusal samples, read-only snapshot branch, and post-export witness LSN). The [final cutover runbook](#final-cutover-runbook) orchestrates it with the export, import, parity, backup, activation, and switch steps. Neither has been run against production yet; a final export remains a rehearsal until the fence and drain evidence exist.

The [September 23 production-data rehearsal](firestore-rehearsal-2026-09-23.md) records a pinned 70,372-record source export, full Firestore import/independent verification, ready indexes and data preflight, a private PostgreSQL-free agent boot, and a managed target backup. It also records the create-only recovery and independent verification of 12 historical asset generations, five references that still require an owner archive or accepted-loss decision, and the remaining runtime and final-cutover gates. PostgreSQL remains authoritative.
