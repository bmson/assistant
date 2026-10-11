# Keyless GitHub deployment setup

The normal release command is `bash infra/gcp/release.sh`. It builds immutable
images with Cloud Build, runs the database migrations in a short-lived Cloud
Run Job, then updates the services and browser job. It assumes the Cloud Run
services, service accounts, secrets, queues, and Artifact Registry already
exist; provision or reconcile those once with `bash infra/gcp/deploy.sh`.

`release.sh` selects its path from the `PERSISTENCE_DRIVER` of the live
`assistant-agent` and `assistant-web` services (unset means `postgres`):

- **PostgreSQL** runs `release-postgres.sh`, the release described below and
  unchanged by the Firestore work.
- **Firestore** runs `release-firestore.sh`: no database URL or secret, and no
  backup or migration job. Before any revision changes, it checks three gates:
  database-free service templates, a managed Firestore recovery point
  (point-in-time recovery or a recent READY scheduled backup), and
  `pnpm firestore:indexes verify`.

`RELEASE_PERSISTENCE_DRIVER=postgres|firestore`, or the workflow's
`PERSISTENCE_DRIVER` repository variable or `persistence` input, states the
expected path. A release stops if that contradicts the live services, or if
the two services disagree (a cutover in progress). `deploy.sh` provisions the
PostgreSQL composition only and refuses to run against a Firestore
installation.

The `Deploy production` workflow releases only after the `CI` workflow
succeeds for a push to `main`. It builds and pushes the immutable images from
GitHub Actions, then runs the migration and Cloud Run rollout. It uses GitHub's
OIDC token and Google Workload Identity Federation, not a downloadable
service-account key.

Database maintenance uses a direct connection when `DATABASE_URL` names a
recognized Neon pooler endpoint. The backup image and `@assistant/db reconcile`
share this conversion; application services keep their original connection.
Credentials, database name, and URL options are preserved. This avoids relying
on session state across pooled transactions during `pg_dump`, migrations, and
identity repair. Other PostgreSQL hosts are unchanged.

A failed migration remains a release gate. The release script prints the exact
execution's status and up to 50 recent error log entries. Missing logging
permissions cannot turn that failure into a success. For a separate read-only
catalog check, run `pnpm --filter @assistant/db diagnose-schema` in an environment
with the intended database configuration. It prints schema and migration-journal
metadata, not credentials or application rows; it never repairs the database.

## One-time Google Cloud setup

Set the project and `owner/repository` below before running the setup as a
project administrator. The provider condition is intentionally bound to that
repository and the `main` ref; do not loosen it to all repositories or refs.

```sh
PROJECT_ID="your-project-id"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
REPOSITORY="owner/assistant"
POOL="github"
PROVIDER="github-actions"
DEPLOY_SA="assistant-github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create assistant-github-deploy \
  --project="$PROJECT_ID" --display-name="Assistant GitHub production deployer"

gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT_ID" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPOSITORY}"

for ROLE in roles/artifactregistry.writer roles/run.admin roles/cloudscheduler.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE"
done
for RUNTIME_SA in assistant-agent assistant-web assistant-browser assistant-code assistant-processor assistant-internal-invoker; do
  gcloud iam service-accounts add-iam-policy-binding \
    "${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser
done
```

The Cloud Build service account is used only by the optional local release
path. GitHub Actions pushes directly to Artifact Registry, so the deployer
does not receive Cloud Build or Cloud Storage permissions. If this is a new
project, finish the bootstrap deploy before enabling GitHub deployments.

## Why a web change reaches production

Every PostgreSQL release writes a release manifest with immutable Artifact Registry digests and declared API/schema compatibility ranges. It checks the live service compatibility metadata before backup or migration, stages candidate agent and web revisions with zero traffic, verifies the agent, web, and secret-safe web-to-agent readiness canary, then promotes. A failure before promotion leaves existing traffic in place. A failure after one or more promotions restores the captured revision/percentage maps; Cloud Run cannot atomically promote multiple services, so this is a bounded rollback rather than an atomic transaction. Worker job templates are checked against manifest digests before promotion and restored if a later release gate fails.

The manifest is archived as `release-manifest-<sha>` by the workflow. `infra/gcp/release-contracts.json` is the reviewed compatibility declaration; update it whenever a release changes the supported API or database schema range. The provisioning script stamps these declarations onto service templates. A full release refuses to migrate when the live agent/web metadata cannot prove the migration-compatible range.

The workflow defaults to the agent+web set. Manual dispatch can explicitly select a web-only release for either supported persistence driver; it requires an explicit driver, the schema-unchanged declaration, and proven live-agent API/schema metadata. The fast local release accepts only `web`, resolves the live driver, and uses the same staged protocol. Firestore releases use the same no-traffic staging, cross-service readiness probe, captured-traffic rollback, and worker-image rollback path as PostgreSQL releases.

For a full Firestore agent+web release, the workflow reads the live
`assistant-agent` Cloud Run service URL and runs
`firestore-delivery-guard.py` around `release.sh`. It checks permission probes
before changing any control, then pauses only `agent-steps`, the three named
Assistant schedulers, and the `gmail-events-push` subscription. Controls that
were already paused or disabled stay that way. After acquiring all holds, the
guard checks BASIC task-attempt metadata and selected Cloud Run worker-job
execution metadata, and waits for active work to finish before continuing.
Unknown execution status stops the release. It writes a mode-0600 receipt in the Actions runner
temp directory before each mutation, restores only controls recorded as owned
by that run, and checks the live state before restoring so an external change
stops recovery instead of being overwritten. It restores on ordinary release
errors and SIGINT/SIGTERM, and stops the release process group before restoring
delivery. The workflow's `always()` restore step retries before artifact
archival and cleanup. Worker execution checks are read-only and limited to
workers selected by the same module plan as the release.

The deploy identity needs queue read/pause/resume and task-list permissions for
Cloud Tasks, job read/pause/resume permissions for Cloud Scheduler, read/list
permissions for selected Cloud Run worker-job executions, and subscription
read/update for the Gmail Pub/Sub subscription.
The checked-in bootstrap currently grants Artifact Registry Writer, Cloud Run
Admin, and Cloud Scheduler Admin; it does not grant Cloud Tasks or Pub/Sub
permissions. Do not add project-wide admin roles for this guard. Configure
resource-scoped grants where the service supports them; Scheduler's permission
probe is project-scoped. The workflow stops before acquiring holds when a
permission probe reports a missing permission. Google documents these probes
as advisory and notes they can fail open; actual mutation calls enforce IAM,
and a denied call after acquisition triggers ownership-based rollback.

A runner loss, forced cancellation, or machine termination can prevent both
the process trap and `always()` step from running. If artifact archival
completed, use `firestore-delivery-guard-<sha>` to inspect the exact prior
states and restore only its remaining owned entries after checking current
state. If the runner disappeared before upload, its temp receipt may be lost;
an operator must inspect each control and determine ownership from the release
logs and observed state before restoring it. Recovery is not automatic in that
case. A receipt entry is removed only after a verified restoration; changed
state or failed restoration leaves the private receipt for recovery.


## GitHub configuration

Add these non-secret repository variables:

- `GCP_PROJECT`
- `GCP_REGION`
- `ARTIFACT_REPOSITORY`
- `GCP_WORKLOAD_IDENTITY_PROVIDER` — the full provider resource name
- `GCP_DEPLOY_SERVICE_ACCOUNT` — `assistant-github-deploy@PROJECT.iam.gserviceaccount.com`

The workflow intentionally has no project or identity fallbacks: all five
variables must be set before its first run. GitHub creates the `production`
environment on first use if it does not exist. Add required reviewers only when
production releases should wait for a human gate. Workflow concurrency queues
releases instead of cancelling one already in progress.

## Retaining only the current deployment

For a personal installation without rollback history, set the repository
variable `CURRENT_ONLY_CLEANUP=true`. `Deploy production` then runs
`infra/gcp/cleanup-current.py` after the release health checks succeed. The
`Clean obsolete deployment versions` workflow also runs daily and can be
dispatched manually to clear artifacts from failed builds. Both workflows use
the same `production-deploy` concurrency group, so cleanup waits for builds.
This policy is opt-in; other installations keep their existing retention.

The cleanup reads the live Cloud Run services and jobs, resolves their exact
image digests, and retains those images plus their current Cosign signatures
and attestations (including untagged OCI referrers). Everything else in the
configured image repository is deleted. Only the current `assistant-agent`
and `assistant-web` revisions remain. Secret Manager history is retained
because a regional Cloud Run inventory cannot prove that old versions are
unused by services in other regions, offline decryptors, or non-Cloud-Run
consumers. An unfinished rollout, split traffic, active job execution,
unsupported multi-architecture index, or changed inventory stops image cleanup.
Application data, database backups, buckets, and integration credentials are
not removed.

The deployment identity already has Artifact Registry read/write and Cloud Run
admin access. Add just the missing image deletion permission using the
included custom role:

```sh
gcloud iam roles create assistantDeploymentCleanup --project="$PROJECT_ID" \
  --file=infra/gcp/cleanup-role.yaml
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="projects/${PROJECT_ID}/roles/assistantDeploymentCleanup" \
  --condition=None
gh variable set CURRENT_ONLY_CLEANUP --body true
```

Preview locally with
`python3 infra/gcp/cleanup-current.py --project PROJECT_ID --region REGION --repository REPOSITORY`.
Add `--apply` to execute after confirming that no deployment is running. This
permanently deletes old image versions. Secret versions are retained for
rollback and offline recovery.
Validate the protections with
`PYTHONDONTWRITEBYTECODE=1 python3 infra/gcp/cleanup-current.test.py`.
