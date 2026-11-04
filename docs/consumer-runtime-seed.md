# Minimal Firestore runtime data seed

`pnpm consumer:seed-runtime` prepares the data checked by `pnpm firestore:runtime-data-preflight` for a **fresh, customer-owned** Firestore installation. It writes one configured agent, a budget policy and zero counters, eight model-role assignments, and the enabled Vertex model catalog those assignments reference. It is create-only and does not mark the runtime ready. `pnpm consumer:install --seed-plan /private/path/runtime-seed.json` can run the same seed after foundation provisioning and before optional Cloud Run deployment.

Create a private JSON plan with these required fields:

| Field                                   | Required value                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                         | `1`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `projectId`, `installationId`, `seedAt` | Exact customer target and UTC ISO timestamp, such as `2026-09-22T12:00:00.000Z`                                                                                                                                                                                                                                                                                                                                         |
| `agent`                                 | Explicit UUID `id`, `name`, owner `email`, `timezone`, `locale`, and `signature`. No credential values or references are accepted.                                                                                                                                                                                                                                                                                      |
| `budget`                                | Positive integer `dailyLimitMicros`, `monthlyLimitMicros` at least as large as daily, and integer `softPct` from 0 to 100                                                                                                                                                                                                                                                                                               |
| `embeddingSpace`                        | `provider: "vertex"`, explicit `model`, `dimensions: 1536`, and `revision`; use the same JSON in `FIRESTORE_EMBEDDING_SPACE`                                                                                                                                                                                                                                                                                            |
| `models`                                | 1–32 explicit catalog entries. Each needs `id` in `vertex/MODEL` form, `label`, `capabilities`, `latencyClass` (`fast`, `medium`, or `slow`), decimal-string `promptCostPerMTok` and `completionCostPerMTok`, HTTPS `pricingSource`, and UTC `pricingVerifiedAt`. All catalog models must be used by a role.                                                                                                            |
| `roles`                                 | Exactly one each for `plan`, `classify`, `extract`, `draft`, `reason`, `rewrite`, `embed`, and `batch`, with explicit `primaryModel`, `fallbackModel`, and `params` object. Both models must be in the catalog. Non-embed models must declare `capabilities.text: true`; the embedding model must declare `capabilities.embedding: true`. The embed role's primary and fallback must both match `embeddingSpace.model`. |

The operator must verify model availability, capabilities, token prices, pricing units, and the pricing source against the current Vertex documentation for the customer's region. The command validates the supplied data and provenance fields but does **not** fetch pricing or make a live Vertex request. Synthetic prices or the test fixture are not installation inputs. Keep the plan private because it contains the owner's email, even though it accepts no secrets.

The execution router and learned-skill recall currently require 1,536-dimensional vectors, so the seed refuses a different width. The runtime requests that width from Vertex using `FIRESTORE_EMBEDDING_SPACE`. Set the runtime config's optional `vertexLocation` to the serving location shared by the selected chat and embedding models; it can differ from the Cloud Run and Firestore region. Model and location availability still require a live Vertex call.

First inspect the plan without Google authentication:

```sh
pnpm consumer:seed-runtime --input /private/path/runtime-seed.json
```

The dry-run prints only scope identifiers, plan hash, catalog IDs, embedding provenance, and record count. It does not create a Google client or print owner email, token prices, or credential material. Review these identifiers before applying. With customer-scoped Google credentials and the foundation ready, explicitly bind the apply to the same project, installation, and Firestore database:

```sh
pnpm consumer:seed-runtime --input /private/path/runtime-seed.json --apply \
  --project CUSTOMER_PROJECT --installation CUSTOMER_INSTALLATION --database CUSTOMER_DATABASE
```

If the active gcloud login works but ADC is unavailable, add `--gcloud-auth`. The helper keeps the OAuth client and short-lived access tokens in process memory, requests tokens from `gcloud` as needed, and never prints or writes tokens. Without that flag, the command uses ADC. The same option is available on `consumer:install` when `--seed-plan` is supplied; it only authenticates the Firestore seed. Terraform can use the active gcloud login's short-lived token through its `GOOGLE_OAUTH_ACCESS_TOKEN` environment variable, for example:

```sh
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)" pnpm consumer:install \
  --manifest /private/path/manifest.json --archive /private/path/source.tar.gz \
  --state /private/path/state.json --state-bucket CUSTOMER_BUCKET \
  --terraform-dir infra/gcp/consumer/terraform \
  --seed-plan /private/path/runtime-seed.json --gcloud-auth --apply
```

The access token stays out of the command line and files, but is present in the installer/Terraform process environment and expires; start the command with a fresh token and rerun with a fresh one if the token expires before Terraform finishes. Firestore 9.2 does not expose `authClient` in its public `Settings` type. This path explicitly selects Firestore's REST fallback, whose google-gax client accepts `authClient`, and a compatibility test verifies that the client reaches google-gax. Recheck this path when upgrading Firestore or google-gax; it is not a universal authentication guarantee.

The apply requires the configured installation's known runtime collections to be empty before creating a seed marker. It never overwrites existing records. An interrupted apply can resume only with the identical plan hash and unchanged records; a foreign record, changed value, or changed plan stops it. A completed rerun performs the read-only preflight and reports `already_seeded` without rewriting records. Do not edit an incomplete seed manually or use this command to migrate an existing installation. The initial zero day/month counters are for `seedAt`; later periods are created on demand by the budget repository.

After apply, run the read-only preflight with `GCP_PROJECT`, `ASSISTANT_WORKSPACE_ID`, `FIRESTORE_DATABASE_ID`, `FIRESTORE_AGENT_ID`, `FIRESTORE_EMBEDDING_SPACE`, and `LLM_PROVIDER=vertex` matching the plan and installation. A passing data preflight proves internal configuration consistency only. Customer authentication, Cloud Run wiring, live Vertex model/IAM checks, Firestore indexes, public ingress, and application smoke remain separate gates. This command does not set `runtimeReady`, start containers, merge an installer stage, or deploy anything.
