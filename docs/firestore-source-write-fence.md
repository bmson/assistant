# PostgreSQL source write fence

This procedure fences the Neon PostgreSQL source at the provider, proves the fence with repeated evidence, and keeps the fence reversible. `scripts/cutover-neon-fence.ts` implements it; nothing in the repository runs it automatically. The opt-in process-level Drizzle write gate remains defense in depth only. Do not treat that gate, paused queues, a read-only export transaction, a Cloud Run traffic change, or a quiet `pg_stat_activity` sample as proof that the source is fenced.

## Application maintenance gate

`POSTGRES_SOURCE_WRITES_FENCED=true` opts the web and agent PostgreSQL composition roots into a fail-closed Drizzle guard. It blocks `insert`, `update`, and `delete` builders, blocks raw `execute`/`batch`, and hides the raw postgres.js client. Typed Drizzle reads continue to work. Invalid values fail configuration parsing. The default is `false`, so deploying the code alone does not change runtime behavior.

Web actions and mobile handlers that use the web application database, plus agent webhooks, internal callbacks, Cloud Tasks execution, local scheduling, and agent maintenance steps, share these guarded connections. For a rehearsal, set the flag only on isolated test services/jobs and confirm a representative mutation is rejected while a typed read succeeds.

This is a per-process guard, not an authoritative database fence. It does not affect an already-running old revision until that process is stopped, and it cannot account for an in-flight write that was already issued. Scripts that construct `postgres()` directly (including the standalone schema repair utility), external clients, operators, and any unreviewed process that does not use `createDb()` bypass it. The workspace exporter has its own read-only transaction, which is unrelated to this application setting. Keep the provider-side fence below as a required cutover gate.

The production database URL is held in Secret Manager as `database-url` and is injected into both `assistant-web` and `assistant-agent`. The migration and workspace-export Cloud Run Jobs also receive that URL. The export job makes its own transaction read-only, but that limits only that export transaction. The agent accepts direct webhooks and internal work, and Cloud Tasks, Cloud Scheduler, and the Gmail Pub/Sub push subscription can all deliver more work. Local operator scripts and any other database clients are outside those Cloud Run controls.

The live PostgreSQL provider has been identified as Neon from read-only secret URL classification. Neon distinguishes the primary read-write compute from read-only replica computes ([Neon endpoint documentation](https://neon.com/docs/manage/endpoints/)); selecting a read-only endpoint for export does not by itself fence writes to the primary. A read-only role preflight found that the application role is not a superuser but has `CREATEROLE`, `pg_signal_backend`, and `pg_monitor` membership, and owns all 67 user tables. In particular, ordinary table grants revoked from that same owner role would not provide a credible fence. Those attributes do not prove a reversible provider fence, coverage of all sessions, or an authorized exporter identity; the provider procedure must be tested with a separate exporter/admin identity and session control. The Neon pooled endpoint rejected a `PGOPTIONS` startup read-only request, while an explicit `BEGIN READ ONLY` transaction succeeded; that result only establishes the scope of that transaction. The [Neon provider fence](#neon-provider-fence-design) below supplies the provider-side write fence, session-drain proof, and read-only export path. It has not yet been run against the live endpoint; rehearse it on a disposable Neon branch first. This application gate is not sufficient to mark that requirement complete.

## Required database-provider capability

Before scheduling the final export, the database owner must identify the provider and database role used by `database-url`, then demonstrate a provider-side fence with all of these properties:

1. It rejects all writes by every source application principal, including already-open sessions and reconnects.
2. It still permits the final exporter to read a consistent snapshot, using a separately authorized read-only identity or an explicitly supported provider read-only mode.
3. A privileged provider view can show no active source write transactions and can identify remaining sessions. The view must cover sessions owned by other roles; ordinary `pg_stat_activity` access often does not.
4. The fence can be removed without restoring or changing source data.

Do not use `default_transaction_read_only` as the fence: a client can override that session setting, and it does not change already-open transactions. Do not rely on revoking grants from the application role: it owns every table and can re-grant them. Do not assume that the application role can alter roles, signal other sessions, or inspect all sessions.

## Neon provider fence design

The fence works at the Neon control plane, not through SQL privileges:

| Property                                     | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence the tool records                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. All principals, open sessions, reconnects | `PATCH /projects/{project}/endpoints/{endpoint}` with `{"endpoint":{"disabled":true}}` on the source branch's **read-write** endpoint. Neon schedules a `suspend_compute` operation, which stops the compute and ends every session. A disabled endpoint "cannot be enabled by a connection or console action" ([Neon API](https://api-docs.neon.tech/reference/updateprojectendpoint)), so direct, pooled, console, and SQL-editor connections are refused for every role.                                                                            | Endpoint before/after state, the `suspend_compute` operation ID used as the fence ID, and a last aggregate session inventory (role, application, state, and open-transaction counts only) captured immediately before the suspend. |
| 2. Consistent exporter read                  | After the fence, a new **snapshot branch** is created from the fenced branch head with only a `read_only` compute ([read replicas](https://neon.com/docs/guides/read-replica-guide)). That compute is a PostgreSQL hot standby. The final export job reads it through a separate `database-url-final-export` secret.                                                                                                                                                                                                                                   | Branch ID, head LSN, `pg_is_in_recovery() = true`, and the SQLSTATEs from refused `SET TRANSACTION READ WRITE` (`0A000`) and transaction-ID assignment (`25006`) in rolled-back transactions. No row is written.                   |
| 3. Drain proof covering every role           | Repeated samples over at least the longest request/job timeout: the endpoint is `disabled` and `idle`, and both the direct and pooled hosts refuse a connection **with a server-side PostgreSQL error**. A local DNS/TCP failure is inconclusive and fails the sample. The Neon operations log since the fence must not contain a compute start. After the export, a short-lived **witness branch** from the source head must report the same LSN as the snapshot branch; this proves no WAL reached the source after the snapshot, whatever the role. | Every sample, all post-fence operations on the endpoint, snapshot and witness LSNs, and witness deletion.                                                                                                                          |
| 4. Reversible without data change            | `PATCH ... {"disabled":false}` restores the same endpoint. The unfence proof reads `pg_is_in_recovery() = false` and `transaction_read_only = off`; it does not write.                                                                                                                                                                                                                                                                                                                                                                                 | Endpoint before/after state, enable operation IDs, and the primary's read-write state.                                                                                                                                             |

Commands (`NEON_API_KEY` from the owner's Neon account, and `SOURCE_DATABASE_URL` from the `database-url` secret, are read only from the environment and are never printed or written to evidence):

```sh
pnpm cutover:neon-fence status --project-id NEON_PROJECT --branch-id br-... --endpoint-id ep-...
pnpm cutover:neon-fence fence --confirm-production-fence --out fence.json ...
pnpm cutover:neon-fence verify --fenced-at FENCE_COMPLETED_AT --samples 3 --interval-seconds 3600 --out verify.json ...
pnpm cutover:neon-fence snapshot-branch --confirm-snapshot-branch --name cutover-final-YYYYMMDD --out snapshot.json ...
pnpm cutover:neon-fence witness --confirm-witness-branch --snapshot-lsn LSN --snapshot-lsn-source neon-parent-lsn --out witness.json ...
pnpm cutover:neon-fence unfence --confirm-production-unfence --out unfence.json ...
```

Every production-mutating command refuses to run without its confirmation flag. `fence` is idempotent: an already-disabled endpoint is re-verified, not toggled. Evidence files are created with mode 0600 and never overwrite an existing file.

### Limits of this fence

- **Availability checks.** Neon states that a disabled endpoint is still "periodically enabled by check_availability operations". The operations log exposes those checks. By default any compute start after the fence fails verification. `--allow-availability-starts` downgrades a start within two minutes of a `check_availability` operation to a warning; client connections must still be refused in every sample. If such a check writes WAL, the witness LSN will differ and the proof fails closed. In that case, export a second snapshot branch taken from the later source head and compare every per-table count and checksum in `manifest.tables` with the final export. Accept the final export only if they are identical.
- **Unverified provider behavior.** The public Neon docs do not state that a branch served only by a `read_only` compute is supported, or whether branch-create responses report `parent_lsn` for a head branch. The tool fails closed if the created branch has a read-write compute. When `parent_lsn` is absent, the tool falls back to the replica's `pg_last_wal_replay_lsn()` and compares only LSNs from the same source. Rehearse the whole sequence on a disposable Neon branch before the production window.
- **Same-role credentials.** Neon branches inherit roles and passwords, so the snapshot and witness computes accept the application credential. Their hosts are new, private, and read-only, and the snapshot secret is separate from `database-url`. Delete both branches during retirement.
- **Scope.** The fence covers the configured branch's read-write endpoint only. Other branches in the Neon project, logical-replication subscribers, and any external copy are outside it. `status` records the target endpoint; inventory other branches and computes in the Neon console before the window.
- **API credential.** The Neon API key can also remove the fence. Keep it with the owner, and revoke it after cutover.

## Capture the writer inventory

Run these read-only commands immediately before the maintenance window. Save their output with the final export manifest; resource names and service URLs are not secret values.

```sh
gcloud run services list --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='table(metadata.name,status.url,status.latestReadyRevisionName)'
gcloud run jobs list --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='table(metadata.name,status.latestCreatedExecution.name)'
gcloud scheduler jobs list --project "$GCP_PROJECT" --location "$GCP_REGION" \
  --format='table(name,state,schedule,httpTarget.uri)'
gcloud tasks queues list --project "$GCP_PROJECT" --location "$GCP_REGION" \
  --format='table(name,state)'
gcloud pubsub subscriptions list --project "$GCP_PROJECT" \
  --format='table(name,topic,pushConfig.pushEndpoint)'
```

Also inspect enabled module schedules in the release's module plan and inventory any other Cloud Run regions, manually launched jobs, local scripts, external database clients, and integration callbacks. The deploy script creates `assistant-sweep`, module-declared Scheduler jobs, `assistant-canaries` jobs when enabled, the configured Cloud Tasks queue (default `agent-steps`), and (when the Google module is enabled) the `gmail-events-push` subscription; the live inventory is authoritative because deployment configuration can drift.

For every Cloud Run service and job, record whether its current template references the `database-url` secret without printing secret contents:

```sh
gcloud run services describe SERVICE --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='yaml(metadata.name,spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom.secretKeyRef)'
gcloud run jobs describe JOB --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='yaml(metadata.name,spec.template.template.spec.containers[0].env[].name,spec.template.template.spec.containers[0].env[].valueFrom.secretKeyRef)'
```

Do not paste any rendered environment values or secret payloads into the evidence report.

## Fence and prove drain

1. Announce the maintenance window and stop new owner activity. Pause every Cloud Scheduler job from the captured inventory. Pause each Cloud Tasks queue and record its state and pending-task count. Stop or detach each push subscription in a reversible way, preserving its backlog. Enable the reviewed `POSTGRES_SOURCE_WRITES_FENCED` Drizzle gate for application processes that support it as a defense in depth, and stop public application writes. Inventory and stop other writers separately. The gate defaults off and cannot replace the provider-side database fence.
2. Stop all remaining direct writers, including operator scripts and external callbacks. Keep a list of the stopped identities and the time each was stopped.
3. Apply the Neon provider fence (`cutover:neon-fence fence`). Record the `fenceId` (the Neon operation ID) and its exact scope. Create the snapshot branch and record its hot-standby write-rejection proof. Never test by modifying production data.
4. Drain or cancel active work according to its durable source state. Confirm no queued request can later execute against PostgreSQL. Preserve queue/subscription backlog for rollback, or explicitly account for each item before discarding it.
5. Run `cutover:neon-fence verify` across at least the longest request/job timeout and after queued callbacks have stopped retrying. It refuses a single sample. Keep the pre-fence session inventory and every sample.
6. Only after the provider fence and drain evidence pass, run the pinned workspace export against the snapshot branch. Then run `cutover:neon-fence witness` to prove the source branch did not advance. Record the export SHA-256, object generation, source snapshot timestamp, and migration release SHA. Keep the fence in place through import, parity review, target backup/restore, and the explicit production activation decision.

The freeze is reversible only after rollback or cutover ownership is explicit. For rollback, restore the database-provider write capability first (`cutover:neon-fence unfence --confirm-production-unfence`), then restore Cloud Run service traffic and resume the exact Scheduler jobs, queues, and subscriptions recorded in the inventory. Verify each resource's prior state. Do not resume both PostgreSQL writers and Firestore dispatchers at the same time.

## Evidence required to mark the gate complete

- Provider, database, source principals, fence scope, reversible operation, and provider audit ID.
- Before/after resource inventories and captured prior state for every service, job, queue, scheduler, and subscription.
- Evidence that all app writes fail while the source remains readable to the exporter.
- Provider-level session and active-transaction evidence after the drain interval.
- Queue and subscription backlog disposition, including retries that could arrive after the export.
- Pinned final export URI, generation, SHA-256, source timestamp, and exact exporter image commit.

If any item is unavailable, label the export a rehearsal and leave the source database in service. Never infer the write fence from a successful export alone.
