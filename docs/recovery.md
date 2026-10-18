# Backup, restore, and migration safety

Every production release creates a PostgreSQL custom-format dump before applying migrations. The
release stops if the backup fails. Backups are stored at:

```text
gs://WORKSPACE_BUCKET/workspace/WORKSPACE_ID/backups/pre-migration/RELEASE_SHA.dump
```

The backup job uses PostgreSQL 17 tooling, the agent's existing database secret, and object-only
workspace access. Serving containers never receive backup tooling.

## PostgreSQL restore rehearsal

The opt-in local restore profile is deliberately inert. It requires `QUEUE_DRIVER=inert`, a
loopback disposable `_test` database and a dedicated reader role scoped to that run ID, a separate
workspace path, empty configured provider/callback credentials, and disabled telemetry. PostgreSQL
connections default to read-only and startup rejects a superuser or any role with write grants on
public relations. The agent binds only to `127.0.0.1`, serves only health/readiness, does not start
its poller or call bridge, and rejects webhook, internal-task, and application endpoints. The Node
process denies non-loopback fetch, TCP, TLS, and UDP destinations before opening them. The web proxy
permits only health/readiness and static assets. These process and route guards protect the shipped
runtime from ordinary application dispatch; they do not constitute a host-level network firewall or
a production recovery receipt. Keep a host-level egress deny in place to cover subprocesses and
operating-system network paths outside the Node runtime.

Restored rows can contain due tasks, reminders, approvals, or schedules. Never use a production
runtime identity, live provider credentials, production callback URL, or shared workspace for a
rehearsal. A health or readiness response is not proof that restored work was inert.

Use a new local database whose name includes a fresh 12-hex run ID and `_test`; never use the source
database, a production URL, a shared development database, or a customer environment. The following
target preflight checks the URL's scheme, literal loopback IP, database name, and dedicated reader
role. It does not connect, restore data, or start an application:

```sh
RESTORE_DRILL_DATABASE_URL='postgres://assistant_restore_reader_0123456789ab:PASSWORD@127.0.0.1:55432/assistant_restore_0123456789ab_test' \
  pnpm recovery:postgres-restore-preflight
```

Keep the URL in a protected local environment and do not paste it into logs or reports. To inspect a
dump without restoring it, use PostgreSQL 17 tooling:

```sh
pg_restore --list ./assistant-restore.dump
```

The command above only lists the archive contents. The URL preflight does not prove that its
database name is unused. Before restoring, create the target with a create-only operation that
fails if the name already exists; never overwrite or clean an existing database. Use
`pg_restore --no-owner --no-acl` only after that fresh target is confirmed. Create a dedicated
non-superuser reader role with no write grants, then validate the runtime profile without printing
the database URL:

```sh
RESTORE_REHEARSAL=true \
RESTORE_REHEARSAL_ROOT='/tmp/assistant_restore_0123456789ab_files' \
ASSISTANT_WORKSPACE_ID=restore-0123456789ab \
DATABASE_URL='postgres://assistant_restore_reader_0123456789ab:PASSWORD@127.0.0.1:55432/assistant_restore_0123456789ab_test' \
PERSISTENCE_DRIVER=postgres QUEUE_DRIVER=inert POSTGRES_SOURCE_WRITES_FENCED=true \
FILES_DRIVER=local OTEL_EXPORTER=none \
pnpm recovery:postgres-restore-profile-check
```

The profile check is configuration-only; it does not connect, restore data, or start an application.
At runtime, database role grants and read-only session settings are checked before the agent listens.
The web and agent surfaces are restricted to readiness/health. The application now enforces:

- a distinct read-only database identity, with server-side read-only enforcement;
- no local poller, queue publication, scheduler, or background dispatch;
- no configured provider credentials or reachable provider/task/callback routes; host-level network
  egress remains an explicit external isolation gate;
- no production callback URLs or callback secrets;
- isolated storage and installation identity;
- writes only to a dedicated local workspace path, while exposing no file mutation endpoint.

Run the local profile qualification on a fresh allocator-owned database with:

```sh
pnpm test --restore-target apps/agent/src/postgres-restore-rehearsal.test.ts
```

The special test-target mode creates a unique `assistant_restore_<12 hex>_test` database with the
same ownership sentinel and cleanup checks as ordinary test targets. The test seeds due task,
reminder, expired approval, and privacy-tombstone fixtures, creates a run-scoped SELECT-only role,
then starts the shipped agent entrypoint with inert queueing, empty provider credentials, and the
restore profile. It checks readiness, disabled task/callback ingress, database read-only behavior,
unchanged due-work/tombstone state, and unchanged model-audit/notification ledgers. The test
preloader denies external access in its child process, and dedicated tests exercise blocked fetch,
redirect, TCP, and UDP paths in the runtime fence. Cleanup removes only the test database and role
when their ownership sentinels match.

This is a local inert-runtime rehearsal, not a restore from a real backup. The inert profile does not
reconcile pending or unknown effects; it leaves them untouched for separate review. It does not yet
prove backup archive integrity, restored data/object hash parity, a full historical-erasure restore,
host-level egress denial, runtime-version compatibility, or bounded recovery promotion. Those gates
remain open. Record backup archive integrity, restored data integrity, application readability, and
any recovery promotion separately. Promotion requires a bounded, explicit owner decision; never
activate two schedulers during rollback.

## Migration rules

- Prefer additive changes: add nullable columns/tables first, deploy readers/writers, then enforce
  constraints in a later release.
- Do not rename or drop a column in the same release that stops writing the old shape.
- Data backfills must be resumable and bounded; they should not hold a long table lock.
- A migration failure stops deployment before either serving revision changes.
- Application rollback is safe only while the previous revision understands the migrated schema.
  If it does not, prepare a restore into a new isolated database and keep runtime activation fenced
  until the recovery gates above pass.

## Retention

Workspace object versioning is enabled. Configure a provider lifecycle rule appropriate to the data
policy—for example, keep daily pre-migration dumps for 30 days and monthly recovery points for one
year. Do not delete the last verified restore point.
