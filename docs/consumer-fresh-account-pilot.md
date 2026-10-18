# Fresh-account pilot runbook

This runbook is the owner-executed acceptance test for the customer-owned installation (plan phase P11). It installs the assistant into a **new Google account and a new project**, using that customer's own Firestore, Cloud Run, Vertex AI, Secret Manager, and billing, with no publisher-owned service, credential, OAuth client, or database. Every step can be repeated. Record the evidence table at the end.

The repository tests cover this flow with mocked Terraform providers, a fake `gcloud` runner, and the Firestore emulator. **None of it has run against a real fresh account yet.** Real Google Cloud behaviour is established only by working through this runbook.

## 0. Available client and prerequisites

This pilot uses the native iOS app for conversations, Calls, Costs, approvals and task controls. Browser pages are the owner administration console for claim, sign-in, security and settings. Product routes are disabled by policy; `/chat` is not an onboarding destination.

Before provisioning, obtain an accessible, published native app build compatible with the pinned server release. Record the actual distribution link, app version/build and supported iOS version. Install and launch it on the pilot device. A source checkout or a successful build is not app distribution. If an eligible new owner cannot obtain that build, stop the pilot before cloud provisioning and record the distribution blocker. This runbook does not supply or certify a distribution link.

The installed app must support server URL/device-key pairing. Do not reuse an existing owner, server connection or credential for this fresh-account pilot.

## Prerequisites

| Item | Notes |
| --- | --- |
| A new Google account | Use a personal account that has never owned a Cloud project, so the pilot proves the first-run path. |
| A payment method | Google requires a billing account. Creating one is a Google-controlled step, and its time is measured separately. |
| A shell with `gcloud`, Node.js 22+, pnpm 10+, Terraform ≥ 1.6 (CI uses 1.14.5), and Docker with Buildx | Cloud Shell has all of these except possibly a recent pnpm (`corepack enable`). A local machine also works. The "Open in Cloud Shell" button has **not** been proven (plan P0), so start Cloud Shell yourself and clone the repository. |
| An iPhone with the published native app | Record the distribution URL, exact version/build and supported OS; availability is a prerequisite. |
| A device that supports passkeys | Any current iPhone, Mac, Android phone, or Windows Hello machine. A second device or a hardware key is needed to test the second passkey. |
| About 60–90 minutes | Most of it is waiting on image builds and Firestore index builds. |

Keep one terminal open for the whole run. Closing it at any point is allowed: rerun the same command and it resumes from the persisted stage. Testing that deliberately is step 11.

Throughout, `$DIR` is the private preparation directory printed by step 3, and `$ARGS` is the common argument list:

```sh
ARGS="--manifest $DIR/install-manifest.json --archive $PWD/../assistant-source.tar.gz \
  --state $DIR/installation-state.json --state-bucket $PROJECT-$INSTALL-state \
  --terraform-dir infra/gcp/consumer/terraform"
```

## 1. Create the project (customer console)

1. Sign in to <https://console.cloud.google.com> with the new account and accept the Cloud terms.
2. Create a project, for example `pilot-assistant-1234`. Note the **project ID**.
3. **Billing → Link a billing account.** Create the billing account if prompted.
4. Record: time from first sign-in to billing linked (`t_billing`).

In the shell:

```sh
export PROJECT=pilot-assistant-1234 REGION=us-central1 INSTALL=pilot
gcloud auth login                     # the new account
gcloud auth application-default login # optional; otherwise pass --gcloud-auth below
gcloud config set project $PROJECT
```

Choose a region where Cloud Run, Firestore, and the Vertex models you select are all available. The Firestore location is permanent.

## 2. Pin the release

Verify that the release repository is accessible to the new customer and contains the exact supplied commit before proceeding. The command below specifies the canonical repository; availability is an acceptance check, not an assertion that a clone was executed.

```sh
git clone https://github.com/bmson/assistant.git assistant && cd assistant
git checkout <RELEASE_COMMIT>          # an exact 40-character SHA, never a branch
pnpm install --frozen-lockfile
git archive --format=tar.gz --output=../assistant-source.tar.gz HEAD
shasum -a 256 ../assistant-source.tar.gz   # the release digest
```

## 3. Prepare private inputs (no cloud access)

```sh
pnpm consumer:prepare --project-id $PROJECT --region $REGION --installation-id $INSTALL \
  --owner-name 'Pilot Owner' --owner-email owner@example.com --timezone Europe/London \
  --embedding-model gemini-embedding-001 --embedding-dimension 1536 \
  --archive ../assistant-source.tar.gz --commit-sha $(git rev-parse HEAD) \
  --archive-sha256 <DIGEST>
```

It prints `$DIR` (`.assistant-install/$INSTALL/`, mode 0700). The database is `assistant-$INSTALL`. See [consumer preparation](consumer-prepare.md).

**Complete the seed plan.** Copy `seed-plan.template.json` to `seed-plan.json`. Then fill in the budget, a model catalog, and the eight role assignments, using **current** Vertex prices and availability for your location (see [runtime seed](consumer-runtime-seed.md)). This is the one step that needs judgement: the installer never guesses prices. Check it offline:

```sh
pnpm consumer:seed-runtime --input $DIR/seed-plan.json
```

**Write the passkey runtime config** as `$DIR/runtime-config.json`. It holds no secrets, Google OAuth client, or domain:

```json
{
  "firestoreAgentId": "<agent.id from seed-plan.json>",
  "firestoreEmbeddingSpace": { "provider": "vertex", "model": "gemini-embedding-001", "dimensions": 1536, "revision": "customer-seed-v1" },
  "vertexLocation": "global",
  "ownerEmail": "owner@example.com",
  "ownerAuth": "passkey"
}
```

## 4. Provision the foundation and seed

```sh
pnpm consumer:install $ARGS --seed-plan $DIR/seed-plan.json            # read-only preview
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)" \
  pnpm consumer:install $ARGS --seed-plan $DIR/seed-plan.json --apply  # add --gcloud-auth without ADC
```

Expected: billing check passes; missing APIs are enabled; the state bucket and release receipt are created; Terraform creates Firestore, indexes, buckets, Artifact Registry, and the runtime identity; the installer waits until every index is `READY` (up to 30 minutes); the seed reports `seeded`; the stage is `provisioned`.

If the access token expires during a long index build, get a new token and rerun the same command.

## 5. Build images and deploy the runtime

```sh
pnpm consumer:install $ARGS --runtime-config $DIR/runtime-config.json --build-images            # plan
pnpm consumer:install $ARGS --runtime-config $DIR/runtime-config.json --build-images --apply
```

Expected:
- Both images are built from the exact commit and pushed by digest to the customer's registry. The digests are saved as `$DIR/image-manifest-<sha>.json`.
- `<install>-auth-secret` is created with one generated version; the value is never printed.
- Web (`OWNER_AUTH_MODE=passkey`) and agent are deployed. Web is public; the agent is IAM-private.
- The stage is `initialized`, and `ownerAccess.authOrigin` is `https://$INSTALL-web-<project number>.$REGION.run.app`.

From here on, `$RUNTIME` stands for `--images $DIR/image-manifest-<sha>.json --runtime-config $DIR/runtime-config.json`.

## 6. Claim the installation (owner)

```sh
pnpm consumer:install $ARGS $RUNTIME --issue-owner-claim --apply
```

1. Copy `ownerClaim.setupUrl`. It works once and expires after 24 hours. Open it on the device that will hold the first passkey.
2. Select **Create passkey** and approve with Face ID, Touch ID, or the screen lock.
3. **Save the recovery code** somewhere offline. The page shows it only once.
4. The claim completes in the owner administration console. Open **/security → Create device key**. Copy the new key once through a private channel and enter it with `ownerAccess.authOrigin` in the installed app’s **Connection** screen. The app stores the key in its Keychain.
5. Confirm that the native app loads this new installation, then record pairing success and its version/build. Keep the recovery code separate from the device key. Record `t_claim` and pairing hands-on time separately from provisioning/build waits.

Negative checks:
- Open the same link again. Expect "invalid, expired, or already used".
- Open `/security` in a private window. Expect owner sign-in.
- Open `/chat` after sign-in. Expect the configured product-route denial; the conversation is in the native app.
- Pair using an incorrect or revoked device key. Expect authentication failure without loading owner data, then use the valid new key.
- Deny local permissions requested by the app. Basic authenticated text conversation must remain usable; record the exact denied capability and its explanation.
- Open `/api/auth/signin`. Expect 404.

## 7. First conversation and final verification

1. In the paired native app, send a message such as "Hi, what can you do?" and wait for a reply. Record the owner conversation/task identity, provider result and installed version/build. A health response, synthetic provider probe or unrelated older conversation does not satisfy this step. The reply uses Vertex through the customer service identity.
2. Confirm Calls, Costs and pending approval/task controls open in the native app’s **More** menu or conversation; setup instructions must not send the owner to blocked browser product routes.
3. Verify:

```sh
pnpm consumer:install $ARGS $RUNTIME --verify --native-app-version <VERSION_BUILD> --native-pairing-confirmed
pnpm consumer:install $ARGS $RUNTIME --verify --native-app-version <VERSION_BUILD> --native-pairing-confirmed --apply
```

Expected checks, all `ok: true`:
- `native-app-installed` (operator confirms the actual version/build; distribution is not machine-verified)
- `native-pairing` (operator confirms authenticated loading on that app)
- `cloud-run-revisions`
- `owner-access`
- `health <run.app URL>` (serves the release commit)
- `owner-claimed`
- `runtime-data`
- `model-response`

The result then shows `runtimeReady: true` and stage `ready`. A failing check leaves the stage at `initialized`, exits with status 2, and names what to fix.

## 8. Acceptance checks

Mark each as pass or fail in the evidence table.

| Check | How |
| --- | --- |
| Second passkey | **/security → Add a passkey** on another device or a hardware key. Sign out, then sign in with it. |
| Sign out everywhere | **/security → Sign out everywhere**. Other browsers are signed out within about 10 seconds. |
| Offline recovery | In a private window, open **/signin → Lost your passkey?**, enter the recovery code, and create a passkey. A new recovery code is shown, and the old one no longer works. |
| Cloud-owner recovery | `pnpm consumer:owner-claim --project $PROJECT --installation $INSTALL --database assistant-$INSTALL --url <authOrigin> --recover --apply`. Open the link and register a passkey. Every other session is signed out. |
| Last passkey guard | Remove passkeys until one is left. The last one cannot be removed. |
| Native pairing and revocation | Pair as in step 6, load the new owner conversation, revoke that device key in **/security**, and verify the app rejects further owner requests. Record the observed time; then create a fresh key and pair again. |
| Native feature handoff | Open Calls, Costs, approvals and task controls in the app. Record unavailable controls as failures rather than following blocked browser links. |
| Memory | Tell the assistant a fact, then ask about it in a new chat. |
| Idle cost | Leave the installation idle for 24 hours, then read **Billing → Reports**, filtered to the project. |
| No publisher dependency | In the Cloud Run revision environment, check there is no `DATABASE_URL` and no `OPENROUTER_API_KEY`, and that no secret references a publisher project. |

## 9. Backup, restore, and export

PITR is always on and keeps 7 days of history. For a consistent export into a bucket you keep:

```sh
pnpm exec tsx scripts/firestore-managed-backup.ts --backup --project-id $PROJECT \
  --database-id assistant-$INSTALL --installation-id $INSTALL \
  --gcs-prefix gs://$PROJECT-$INSTALL-assets/exports/pilot-1 \
  --snapshot-time <an ISO minute within the last hour> --manifest $DIR/backup-1.json --execute
```

Then rehearse a restore into a **new** database and compare checksums:

```sh
pnpm exec tsx scripts/firestore-managed-backup.ts --restore --project-id $PROJECT \
  --database-id assistant-$INSTALL-restore1 --installation-id $INSTALL \
  --location $REGION --manifest $DIR/backup-1.json --execute
```

If the export fails with a permission error, grant the project's Firestore service agent (`service-<project number>@gcp-sa-firestore.iam.gserviceaccount.com`) write access to that bucket, then retry. Expect the restore result's `documents` and `canonicalHash` to match the backup. Then delete the rehearsal database with `gcloud firestore databases delete --database=assistant-$INSTALL-restore1`. Promoting a restored database to serve the installation is **not automated**. It needs a reviewed identity/state change; see the Terraform README section "Managed backups and restore".

## 10. Update and rollback

With a newer release commit checked out and archived as in step 2:

```sh
pnpm consumer:update --state $DIR/installation-state.json --state-bucket $PROJECT-$INSTALL-state \
  --archive ../assistant-source-new.tar.gz --commit-sha <NEW_SHA>           # preview
pnpm consumer:update ... --apply
```

Run the printed `next` commands in order: build and deploy the selected release with the same runtime configuration, then `--verify --native-app-version <VERSION_BUILD> --native-pairing-confirmed --apply`. Release rebase preserves the provisioned runtime; do not apply the foundation-only profile over running services. Native chat history, passkeys, and the recovery code must all survive.

To roll back, check out the old commit and run `consumer:update` with the old archive. Then deploy with `--images $DIR/image-manifest-<old sha>.json` instead of `--build-images`.

## 11. Interruption and failure drills

| Drill | Expected |
| --- | --- |
| Press Ctrl-C during step 4's Terraform apply, then rerun | Resumes from remote state and reaches `provisioned`. |
| Close the terminal while indexes are building, then rerun | Rechecks the indexes and continues. |
| Rerun steps 4 to 7 after success | Each run is a no-op or re-verification. No duplicate secret versions or resources are created. |
| Let a claim link expire, or issue a second one | The old link fails. `--issue-owner-claim --apply` issues a fresh one while nobody owns the install. |
| Run step 4 against a project whose billing is not linked | Stops before any change, with a billing prerequisite error. |
| Prepare a second installation ID in the same project | Its own database, buckets, and service accounts. No adoption of the first installation's resources. |

## 12. Uninstall

```sh
pnpm consumer:uninstall --state $DIR/installation-state.json --state-bucket $PROJECT-$INSTALL-state          # plan + retained charges
pnpm consumer:uninstall ... --apply                                                                          # stop and remove the runtime
pnpm consumer:uninstall ... --delete-data --confirm-installation $INSTALL --delete-state --apply             # optional: delete everything
```

Afterwards confirm in the console:
- no Cloud Run services, Scheduler jobs, or queues remain;
- no `$INSTALL-*` service accounts remain;
- with `--delete-data`, the database, the buckets (soft-deleted objects are billed for 7 days), and the Artifact Registry repository are gone.

The project itself is never deleted. Delete it yourself, or unlink billing, when the pilot is over.

## Evidence to record

| Field | Value |
| --- | --- |
| Release commit / archive digest and successful fresh clone | |
| Published app distribution link / installed version/build / iOS version | |
| Claim / saved recovery / authenticated native pairing / first conversation-task identity | |
| Account, project ID, region | |
| `t_billing` (account creation to billing linked) | |
| Provisioning wall time (step 4), including index wait | |
| Image build and deploy wall time (step 5) | |
| Hands-on time from step 3 to first native reply (target: under 10 minutes once billing and app availability are ready) | |
| App distribution/install, claim and pairing hands-on times separately | |
| Verification result (paste the `checks`) | |
| Acceptance checks, pass/fail each | |
| Drills, pass/fail each | |
| 24-hour idle cost, and a light-use day's cost | |
| Issues or unclear instructions | |

## Known limits in this release

- **Agent idle cost.** The Firestore agent still runs its local poller, so it keeps one always-allocated instance (1 vCPU, 1 GiB). That costs tens of dollars a month at list price even when idle; see [Cloud Run pricing](https://cloud.google.com/run/pricing). The Terraform `task_dispatch = "cloud-tasks"` profile (a scale-to-zero agent with a queue and Scheduler) is ready, but it stays off until the agent accepts `QUEUE_DRIVER=cloudtasks` in Firestore mode.
- **Minimal modules.** The Firestore runtime runs with `ASSISTANT_MODULES=minimal`. Gmail/Calendar (the Workspace wizard), SMS, browser, and code modules are not part of this pilot.
- **iOS pairing.** Device keys are copied manually. There is no QR pairing exchange yet.
- **Cloud Shell entry.** The one-click "Open in Cloud Shell" entry has not been proven. The pilot starts from a manual clone.
- **Restore promotion.** Restoring into a new database is scripted. Switching the live installation to that database is a manual, reviewed change.
- **Model catalog.** The owner must verify prices and availability; the installer does not fetch them.
