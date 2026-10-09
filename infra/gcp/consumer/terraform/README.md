# Customer-owned consumer foundation

With no image digests supplied, this directory provisions only the first customer-owned resources for a Firestore installation:

- required Google APIs;
- an explicitly selected Firestore Native Standard database with point-in-time recovery (PITR), required for consistent managed snapshot exports;
- an optional daily managed Firestore backup schedule with configurable retention;
- application composite/vector indexes and large-payload single-field exemptions from the shared `infra/gcp/firestore/firestore.indexes.json` specification;
- private, versioned assets and source archive buckets with uniform access, public access prevention, and seven-day soft-delete retention;
- an immutable-tag Docker Artifact Registry repository; and
- a dedicated runtime service account with access to the selected Firestore database and asset object administration. The source archive bucket has no runtime grant.

The foundation does not manage the project, billing account, existing Firestore databases, Cloud Run services, queues, secrets, or a publisher-owned installer. A name collision is allowed to fail during creation rather than silently adopting an existing resource. The database, buckets, and Artifact Registry repository use Terraform `prevent_destroy`. Firestore also enables server-side delete protection, and the buckets refuse forced deletion of their contents. Keep these resources in state; removing their resource blocks also removes Terraform lifecycle protection.

## State bootstrap

The GCS backend is configured without a bucket value because the state bucket must be customer-owned and created before this configuration is initialized. Creating that bucket from this same configuration would make the first state write circular. Bootstrap it with an authenticated customer workflow, apply the bucket's own retention/versioning/IAM policy, and then initialize this directory with the resulting bucket:

```sh
gcloud storage buckets create gs://CUSTOMER_STATE_BUCKET \
  --project=CUSTOMER_PROJECT \
  --location=CUSTOMER_REGION \
  --uniform-bucket-level-access \
  --public-access-prevention

terraform init \
  -backend-config="bucket=CUSTOMER_STATE_BUCKET" \
  -backend-config="prefix=assistant/CUSTOMER_INSTALLATION_ID"
```

The bootstrap bucket is outside this state. Keep its versioning, retention, access policy, and backup procedure under the customer's operational controls. Do not put credentials, secret values, or owner-claim material in Terraform variables or outputs. The optional runtime accepts immutable image digests as non-secret inputs.

## Configuration

All ownership and collision-sensitive identifiers are explicit. A minimal variable file looks like:

```hcl
project_id             = "customer-project-id"
region                 = "us-central1"
installation_id        = "assistant-prod"
firestore_database_id  = "(default)"
create_default_database = true
firestore_location_id  = "nam5"
assets_bucket_name     = "customer-project-id-assistant-assets"
source_bucket_name     = "customer-project-id-assistant-source"
artifact_repository_id = "assistant-prod"
```

The default consumer path creates `(default)` in a fresh customer-owned project. It requires explicit `create_default_database = true`; a future installer must verify absence under the authenticated customer identity before applying. The opt-in is creation intent, not evidence that a cloud check ran. An existing database must cause installation to stop: never import it, adopt it, or silently switch to a named database. Terraform creation also fails on an existing resource. A named 4–63 character non-UUID ID remains available for deliberately isolated installations; omit the opt-in for that path.

Google currently grants free quota only to the eligible default database; named databases are usage-billed. The free quota does not cover all features or the rest of the application. See [Firestore pricing](https://cloud.google.com/firestore/pricing?hl=en). The named-only isolation rule in the real-cloud validation harness is separate and remains unchanged. Choose a Firestore location that is compatible with the customer's region and selected Google model endpoints; the database location is a durable choice.

PITR retains seven days of document history and is billed to the customer's project outside the free storage tier. It is enabled here so managed exports can request a consistent snapshot for checksum verification. It is distinct from managed scheduled backups and does not create a durable backup schedule. See [PITR behavior and billing](https://docs.cloud.google.com/firestore/native/docs/pitr).

## Managed backups and restore

Recurring managed backups are available as an explicit cost-bearing opt-in. Select retention while preparing the customer-owned installation; the choice is recorded in `install-manifest.json` and replayed by `pnpm consumer:install`, including resume and reapply:

```sh
pnpm consumer:prepare ... --daily-backup-retention-days 7
pnpm consumer:install --manifest .assistant-install/INSTALLATION_ID/install-manifest.json ...
```

The schedule is disabled by default. Retention accepts whole days from 1 through 98 (14 weeks); Firestore chooses the time of each daily backup. Each retained backup incurs storage charges based on the database's stored size for the time retained, and restores incur a size-based restore charge. PITR storage is billed separately. A daily seven-day schedule can therefore retain several database-sized snapshots; check current [Firestore pricing](https://cloud.google.com/firestore/pricing) for the selected location and estimate from the installation's actual stored size before enabling. Billing continues for already-created backups after the schedule is removed; those backups expire at their recorded retention time. See Google's [backup and restore details](https://cloud.google.com/firestore/docs/backups) for current limits and billing behavior.

The manifest validates and preserves the choice as immutable installation selection. On every Terraform invocation, the installer derives both schedule enablement and retention from that manifest, and it verifies the resulting schedule resource belongs to the selected project/database. Changing retention after provisioning is a separate operator change that needs a reviewed manifest/state transition and matching Terraform plan; editing Terraform state or the manifest alone is unsupported.

The operator applying this opt-in needs permission to manage backup schedules, such as `roles/datastore.backupSchedulesAdmin`. A restore operator needs backup-read and restore permissions, such as `roles/datastore.backupsViewer` and `roles/datastore.restoreAdmin`; grant these to the human/operator identity only when recovery work requires them. The application runtime service account receives no backup-administration permissions.

Restore to a **new, unused database ID in the same project and Firestore location**. Firestore managed restore does not overwrite an existing database. Keep application writes fenced during incident recovery, preserve the source database and backup, and do not repoint Cloud Run automatically. First identify and restore a completed backup:

```sh
gcloud firestore backups list \
  --location="$FIRESTORE_LOCATION" \
  --format='table(name,database,state,snapshotTime,expireTime)'

gcloud firestore databases restore \
  --project="$PROJECT_ID" \
  --source-backup="projects/$PROJECT_ID/locations/$FIRESTORE_LOCATION/backups/$BACKUP_ID" \
  --destination-database="$RESTORE_DATABASE_ID"
```

Record the returned operation name and wait for it to finish:

```sh
gcloud firestore operations describe "$RESTORE_OPERATION"
```

Before using the restored database, verify the restore operation completed, compare document counts/checksums with the incident recovery point, confirm the restored index configuration and application preflight, and apply database-scoped IAM to the runtime identity. Keep external actions, queue dispatch, and schedules paused while validating. Backups include documents and index configuration but do not replace the separately managed installation state, secrets, Cloud Run revisions, or external workspace assets. [Restore behavior and limitations](https://cloud.google.com/firestore/docs/backups#restore_data_from_a_database_backup).

This Terraform profile currently manages the configured source database, not an operator-created restored database. Switching a live runtime to that new database requires a separately reviewed Terraform/state and IAM change plus explicit application write-fence and parity evidence. Do not change `firestore_database_id` and apply against the existing installation state as an improvised restore; the database resource is create-only and protected against replacement. The recovery runbook leaves the original database intact and the promotion decision explicit.

The Google provider constraint permits compatible 8.x releases. The committed `.terraform.lock.hcl` records the provider version and package checksums validated for local Apple Silicon and Linux CI/Cloud Shell. Refresh both platform checksums deliberately when upgrading: `terraform providers lock -platform=darwin_arm64 -platform=linux_amd64`. Read-only initialization must be followed by successful validation on the target platform.

With these variables alone, this remains a foundation-only apply. The installer copies only its verified foundation files into an isolated Terraform directory and does not set the runtime digest variables or advance a runtime-ready stage.

## Optional minimal Firestore runtime

`runtime.tf` is a separate, direct Terraform opt-in for a customer who has already built and verified `web` and `agent` images in this installation's Artifact Registry repository. The runtime sets `FIRESTORE_DATABASE_ID` on both services to the exact `firestore_database_id` selected for the installation; a named database is never redirected to `(default)`. Both image inputs are **immutable image digests**, for example:

```hcl
web_image_digest   = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
agent_image_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

firestore_agent_id = "11111111-1111-4111-8111-111111111111"
firestore_embedding_space = {
  provider   = "vertex"
  model      = "text-embedding-005"
  dimensions = 768
  revision   = "customer-seed-v1"
}
owner_email  = "owner@example.com"
web_auth_url = "https://assistant.example.com"

# Versions of existing, customer-populated Secret Manager secrets.
auth_secret_version          = 1
google_client_id_version     = 1
google_client_secret_version = 1
# Optional for native iOS access, on a new runtime installation only.
mobile_api_token_version     = 1
```

The digest examples are placeholders, not published images. Terraform constructs `REGION-docker.pkg.dev/PROJECT/REPOSITORY/web@sha256:...` and the matching `agent` URL, so tags and other registries cannot be selected by these inputs. Both digests must be supplied together. Both services open the selected Firestore database, whether `(default)` or a named installation database; their IAM grants are scoped to that same database. `firestore_agent_id` must identify a seeded owner agent, and embedding provenance must match the existing data. The selected Vertex model must be available in `region`; Terraform cannot prove model access or embedding compatibility.

Before supplying digests, create and populate these exact secrets in the customer project, outside Terraform state:

| Secret ID | Cloud Run web environment variable |
| --- | --- |
| `<installation_id>-auth-secret` | `AUTH_SECRET` |
| `<installation_id>-google-client-id` | `AUTH_GOOGLE_ID` |
| `<installation_id>-google-client-secret` | `AUTH_GOOGLE_SECRET` |
| `<installation_id>-mobile-api-token` (optional) | `MOBILE_API_TOKEN` |

Supply positive, numbered versions. Terraform grants only the web service account `secretAccessor` on the three required secrets and the optional mobile secret, and injects those pinned versions; it never reads, outputs, or stores secret values. Omit `mobile_api_token_version` to preserve the previous no-mobile runtime. The consumer installer currently refuses changed runtime config after `initialized`, so adding or rotating a token on an existing install needs a separately reviewed update path. See [consumer installation](../../../../docs/consumer-install-preview.md) for customer-side secret creation and secure transfer to iOS. Configure the Google OAuth client for the owner account and the callback `${web_auth_url}/api/auth/callback/google` before exposing the service. `web_auth_url` must be a real HTTPS origin under customer control; Terraform neither provisions DNS/custom domains nor derives it from a service URI.

The web service requires Cloud Run IAM invocation by default, even with application Google OAuth configured. After configuring the owner OAuth client and callback, a separate `allow_public_web_invoker = true` grants `allUsers` invocation **to web only**; application routes still enforce the verified owner email. The agent's default URL accepts network ingress, but **Cloud Run IAM invocation remains required**: this configuration grants `roles/run.invoker` on the agent only to the dedicated web service account and never to `allUsers`. A web-to-agent call using the default URL is not considered internal Cloud Run ingress without additional VPC routing, so `INGRESS_TRAFFIC_INTERNAL_ONLY` would block it even with correct IAM. Audit any inherited project-level invoker grants before applying this profile. See [Cloud Run ingress](https://cloud.google.com/run/docs/securing/ingress) and [service-to-service authentication](https://cloud.google.com/run/docs/authenticating/service-to-service). No dev or localhost auth bypass is enabled. The agent uses a single minimum Cloud Run instance with CPU allocated while idle so its local Firestore poller can run; this has customer-billed cost even when no one is chatting. The web service can scale to zero.

For installs managed by `consumer:install`, use its explicit `--owner-access-callback` resume step after private deployment. It verifies the numbered auth secret versions and live web/agent IAM, inspects a Terraform plan that changes only the web invoker binding, and leaves `runtimeReady: false` until owner sign-in and model chat are tested. See [owner onboarding](../../../../docs/consumer-install-preview.md) for the exact customer OAuth client and HTTPS routing steps.

Terraform sets the web service's `AGENT_URL` to the agent's default Cloud Run URI. The web readiness source accepts only that HTTPS `run.app` service origin, obtains an audience-bound ID token from the web service account's metadata server, and sends it only to the agent's `/ready` path with uncached GET and redirects disabled. It supplies the injected source for the portable capability read; a later mobile-workspace composition step must connect that source and the repository to the route. A missing URI, token, permission, or healthy `/ready` response reports capabilities unavailable rather than ready. Terraform plan tests verify URI wiring and the scoped invoker grant; live customer IAM and ingress have not been exercised by these offline tests.

This profile enables the Cloud Run, Secret Manager, and Vertex APIs; creates a dedicated web service account with selected-database Firestore access; grants Vertex access to web (for direct chat replies) and the existing runtime service account (for background turns); and creates both Cloud Run services. It does not build or scan images, seed the agent/models, check a live model response, configure OAuth or public DNS, provision backup/update/uninstall workflows, or connect to installer stages. Applying these resources is **not** evidence that the installation is runtime-ready or that PostgreSQL can be retired. Mobile bootstrap and non-chat web surfaces are still outside the minimal Firestore profile.

### Passkey owner sign-in (no OAuth client)

Set `owner_auth_mode = "passkey"` to use [owner passkeys](../../../../docs/consumer-owner-passkeys.md) instead of a Google OAuth client. Only `<installation_id>-auth-secret` is required; supplying Google client versions is rejected. When `web_auth_url` is omitted, Terraform reads the project number and uses the deterministic Cloud Run URL `https://<installation_id>-web-<project_number>.<region>.run.app` as the exact passkey origin, so no custom domain or DNS is needed. The URL is stable for the life of the service name and project; a later custom domain is a new relying party and needs passkeys re-registered through recovery. Because application sign-in is claim-protected, `allow_public_web_invoker = true` can be applied together with the runtime; issue the one-time setup link with `pnpm consumer:owner-claim` afterward.

### Optional Cloud Tasks dispatch

`task_dispatch = "cloud-tasks"` replaces the always-on agent poller with a scale-to-zero agent (`min_instance_count = 0`, CPU only during requests), a regional `<installation_id>-agent-steps` queue, and a `<installation_id>-sweep` Cloud Scheduler job that POSTs `/internal/sweep` every minute (`sweep_schedule`). A dedicated `<installation_id>-invoker` service account signs route-bound OIDC tokens; it alone receives `roles/run.invoker` on the agent (besides web's readiness probe). Web and the runtime identity receive only `roles/cloudtasks.enqueuer` on this queue and `roles/iam.serviceAccountUser` on the invoker account, and the Cloud Tasks service agent receives `roles/iam.serviceAccountOpenIdTokenCreator` on it. The agent's `AGENT_URL`, `PUBLIC_URL`, and `INTERNAL_OIDC_AUDIENCE` use the deterministic agent URL.

The agent registers exactly `/internal/tasks/execute` and `/internal/sweep` as service-level Cloud Run custom audiences for this profile. Cloud Tasks and Scheduler send the Google-signed, route-bound token in `Authorization`; Cloud Run checks its permitted audience and invoker IAM, then the application independently checks the signature, issuer, verified invoker email, expiration, and the audience for the actual request route. A sweep token cannot authorize task execution. The default service audience remains accepted by Cloud Run for web's readiness probe, but fails the internal route validator. Do not replace the signed application proof with a decoded platform header or disable either check. This uses the documented [custom audience configuration](https://docs.cloud.google.com/run/docs/configuring/custom-audiences) and [Authorization forwarding contract](https://docs.cloud.google.com/run/docs/authenticating/service-to-service#authenticate_requests).

**Keep the default `poller` until this optional profile passes a disposable real-cloud rehearsal.** The checked-in Firestore agent has Cloud Tasks composition and local regressions, but mocked Terraform plans and locally signed tokens do not prove platform forwarding or delivery. The installer does not select this profile yet. Qualification must exercise actual queue delivery and Scheduler invocation, cold-start dispatch, retry/outbox recovery, and rejection of the wrong service, route, and caller without owner data or external effects. Scheduler jobs are billed per job beyond the free allowance, and each sweep cold-starts the agent if it is idle.

### Runtime IAM summary

| Identity | Grants |
| --- | --- |
| `<id>-runtime` (agent) | `datastore.user` conditioned on the installation database; `storage.objectAdmin` on the assets bucket only; `aiplatform.user`; queue enqueuer and invoker `actAs` with Cloud Tasks dispatch |
| `<id>-web` | `datastore.user` conditioned on the installation database; `aiplatform.user`; `secretAccessor` on its pinned auth (and optional mobile) secrets only; `run.invoker` on the agent; queue enqueuer and invoker `actAs` with Cloud Tasks dispatch |
| `<id>-invoker` (Cloud Tasks only) | `run.invoker` on the agent only |

Neither runtime identity can change IAM, deploy services, read the source/state buckets, or administer backups.

## Offline validation

CI uses Terraform 1.14.5 and the locked Google provider to validate this foundation without credentials:

```sh
terraform fmt -check -recursive
terraform init -backend=false -lockfile=readonly
terraform validate
terraform test
```

The tests use a mocked provider. They cover the explicit default-database creation guard, exact database-scoped IAM, retained delete protection, named database selection, invalid IDs, index deployment, foundation-only behavior without images, runtime digest and auth wiring, private defaults, and invalid runtime inputs. They do not establish that a customer project is empty, billing is enabled, a location or Vertex model is available, secrets exist, Cloud Run starts, OAuth works, or IAM works in Google Cloud. The live Firestore validation harness deploys the same indexes and exemptions into an isolated temporary database and waits for index operations before exercising queries.
