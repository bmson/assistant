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

Every release proves itself: `infra/gcp/release.sh` polls `/api/health` on the
live `assistant-web` URL and fails unless it reports the commit being released.
The commit is baked into the image by the `GIT_SHA` build arg (passed by both
the GitHub workflow and `cloudbuild.yaml`), so "the image was pushed" can no
longer be mistaken for "production is serving it".

Three things used to break that chain silently, and are now closed:

- **The web rollout was last, behind fail-fast gates it did not depend on.** An
  agent env var only `deploy.sh` sets, or one absent Cloud Scheduler job, exited
  the script before web was ever updated. Rollout steps are now attempted
  independently and their failures reported together at the end, so unrelated
  drift still fails the release without stranding a component.
- **Traffic could stay pinned to an old revision.** A manual rollback pins the
  traffic split, after which every `services update --image` creates a revision
  serving 0% of requests. Each rollout now re-asserts `--to-latest`.
- **A skipped or unrelated-red CI run blocked deploys entirely.** Deployment
  keys off a successful `CI` run, so a `[skip ci]` commit produces no deploy,
  and CI can go red for reasons unrelated to the commit (a newly published
  advisory failing `pnpm audit`, a fresh HIGH CVE failing Trivy). Use the
  manual path below rather than pushing an empty commit.

### Forcing a release

`Deploy production` accepts `workflow_dispatch`, with an optional `sha` input
that defaults to the tip of `main`:

```sh
gh workflow run "Deploy production" --ref main
gh workflow run "Deploy production" --ref main -f sha=<commit>
```

This still builds from the given commit and still runs the full verification,
so it is a way to bypass a stuck *trigger* — not to bypass the release's own
checks.

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
and `assistant-web` revisions remain. Each secret retains its newest enabled
version and any explicitly referenced or aliased versions. Secret payloads are
never read. An unfinished rollout, split traffic, active job execution,
unsupported multi-architecture index, or changed inventory stops cleanup.
Application data, database backups, buckets, and integration credentials are
not removed.

The deployment identity already has Artifact Registry read/write and Cloud Run
admin access. Add just the missing image deletion and secret metadata/deletion
permissions using the included custom role:

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
permanently destroys superseded secret versions and old image versions.
Validate the protections with
`PYTHONDONTWRITEBYTECODE=1 python3 infra/gcp/cleanup-current.test.py`.
