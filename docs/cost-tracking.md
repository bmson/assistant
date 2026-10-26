# Cost tracking

The web Costs page and native iOS Costs view distinguish provider billing from the assistant's operation ledger. **Do not add the two together**: Vertex, Cloud Run jobs and storage may already be present in Google Cloud billing, and OpenRouter requests already appear in its reported spend. The budget caps protect assistant operations using conservative estimates; they cannot cap the cloud provider's bill.

## Google Cloud

The connector reads the standard or detailed [Cloud Billing BigQuery export](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup), using the runtime's Application Default Credentials. It includes every exported service and SKU (Firestore/Cloud SQL, Vertex AI, Cloud Run, Storage, networking, and future services), credits, negative adjustments, and original currencies. It does not estimate infrastructure prices or convert currencies. Project scope excludes unallocated account-level charges such as some taxes or adjustments. The report covers usage in the current UTC month, not invoice month; delayed usage and adjustments mean it is not a final invoice.

1. Enable standard usage cost export in **Cloud Billing → Billing export → BigQuery export** for your billing account. Select a billing dataset in the appropriate project and location. Initial data may take hours or days; export history depends on the dataset location and when export was enabled.
2. Set these environment variables on the **web service**:
   - `GCP_BILLING_EXPORT_TABLE=billing-project.billing_dataset.gcp_billing_export_v1_ACCOUNT_ID` (or the detailed export table).
   - `GCP_BILLING_LOCATION=US` (use the dataset's actual location).
   - `GCP_BILLING_QUERY_PROJECT=billing-project` (defaults to the export table's project).
   - `GCP_BILLING_SCOPE=project` (default) filters to `GCP_PROJECT`. Set `billing_account` explicitly to include all projects and unallocated charges in this account's export.
   - `GCP_BILLING_MAX_BYTES=1000000000` caps each query's scan allowance. BigQuery rejects a query that exceeds it; the dashboard keeps the previous snapshot and flags it stale. Querying the export can itself incur BigQuery charges.
3. Enable the BigQuery API in the query project. Grant the web runtime service account `roles/bigquery.jobUser` on that project and `roles/bigquery.dataViewer` on the export dataset. No billing-account administrator credential is needed at runtime. Scope access to the dataset; billing-account reporting is an explicit installation choice.
4. Open Costs. It shows the selected project/account scope, reporting month, snapshot fetch time, latest export time, and latest usage time. A latest timestamp is not proof that all services have reported. An empty export is shown as unavailable, not $0.

For existing installations, set these values on the existing web service before its next image release (ordinary release scripts preserve the live template's environment). The bootstrap `infra/gcp/deploy.sh` passes them from its environment file or shell when provisioning the web service. No dataset, billing export, IAM grant, production migration or deployment is performed by this code change.

## OpenRouter

The existing saved OpenRouter connection (or deployment key when no saved connection replaces it) is used with [GET /api/v1/key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key). `usage_monthly` is shown as the connected key's reported spend; an explicit zero is valid. This is not an account-wide invoice, does not include other keys or credit purchases, and may include other apps sharing the key. Use a dedicated key for installation-specific attribution. BYOK upstream usage is not added to OpenRouter's amount because its bill belongs to the upstream provider.

## OpenAI reported costs

The OpenAI billing feed is separate from model routing and from the assistant ledger. It reads only the official `https://api.openai.com/v1/organization/costs` endpoint. A model inference key, self-repair key or custom OpenAI-compatible gateway credential is never used for billing. Connecting an OpenAI model alone does not prove that its requests belong to the selected billing scope.

This feed requires an owner-supplied **organization Admin API key**. This is an elevated organization administration credential, not a Costs-only permission or an ordinary project API key. Choose a separate expiring credential and keep it on the web service only. No credential is created by the setup helper. A local shape check identifies Admin-key input only; it does not authenticate the credential or prove access to billing data. Before supplying a credential or writing a production secret, explicitly choose the existing account, credential and secure destination. The implementation and offline checks can be reviewed without that access.

The optional settings are:

- `OPENAI_BILLING_ADMIN_KEY_ENCRYPTED`: the credential sealed with this installation's existing `MCP_ENC_KEY`, stored as a separate web-only Secret Manager secret. Never put plaintext in this field.
- `OPENAI_BILLING_PROJECT_IDS`: comma-separated exact OpenAI project IDs.
- `OPENAI_BILLING_API_KEY_IDS`: comma-separated exact API key IDs (identifiers, never secret key values).
- `OPENAI_BILLING_ACCOUNT_LABEL`: an optional non-secret account description.

At least one explicit project or key filter is required before any request. Selecting filters identifies the reported source scope; it does not prove that every connected model uses that scope, or that a shared project/key belongs exclusively to Assistant. Use a dedicated project/key for installation attribution. No organization-wide default is silently queried. When both filters are supplied, the request passes both constraints to the Costs API; do not use a broader filter as a substitute for an unsupported scope.

The connector requests the current UTC month, groups by project, API key and line item, and publishes only fully validated complete pages. Provider currency and negative amounts remain distinct. A provider-supplied amount of zero with a currency is a valid reported zero. An empty result without a currency is unknown, not a synthesized USD zero. Missing/revoked access and partial pages remain unavailable or retain the previous snapshot as stale. Fetch/check timestamps do not establish when OpenAI last updated its source data; a bucket boundary is not a usage freshness timestamp. The Costs API supplies an amount but no separate credit or net-after-credits breakdown; clients label those fields Not reported. Native clients explicitly advertise support for amount-only billing metadata; older or unknown clients receive an unavailable/update-required report with no line amounts, preventing their legacy credit/net labels from inventing a breakdown. Current web and upgraded native clients label the provider amount as reported cost. These are reported usage costs, not an invoice balance or cash due. No OpenAI run-rate forecast is produced without an actual source-usage horizon; retrieval time is not that horizon.

### Offline setup review

Run `pnpm exec tsx scripts/billing-setup.ts --check` to inspect the local configuration without requesting credentials, contacting providers, starting queries or changing infrastructure. It shows safe source identifiers and missing setup requirements only. Local presence does not establish production access.

After an explicit owner credential/destination choice, the optional sealing mode accepts an existing Admin key from piped standard input and writes only sealed ciphertext to a new ignored workspace file. It refuses terminal input, plaintext arguments, tracked destinations, overwrites and paths outside the checkout. Use a password manager or equivalent secure input source; never place the key in shell history, a command argument, a screenshot or chat. Run `pnpm exec tsx scripts/billing-setup.ts --help` for its exact opt-in invocation. Keep the installation's `MCP_ENC_KEY` unchanged and available to web; rotating it requires re-sealing this credential as well as other saved credentials.

The helper writes a separate file; deploy does **not** automatically load it. After the owner has approved the credential, destination and deployment, load only that ciphertext assignment into the shell before the reviewed deployment, for example `set -a; . ./.env.openai-billing.local; set +a` in the same checkout. The file must be the helper-created, reviewed ciphertext-only file, not an arbitrary downloaded shell script. Keep the remaining deployment settings in the existing installation environment file; the shell's exported encrypted setting takes precedence. This step does not create a provider key or query billing. Do not execute the full bootstrap against an existing installation merely to apply this setting; use its reviewed web-template update/release path.

The bootstrap deployment can consume the sealed setting and mount `openai-billing-admin-key-encrypted` on **assistant-web only**. Executing that deployment creates/updates a secret and grants its access, so it requires a separately reviewed deployment/credential decision. No setup helper runs the deployment, provisions a key, changes IAM or performs a live reconciliation. Existing installations should have their web template updated through the reviewed normal release process; do not run the full bootstrap merely to activate billing.

### Google Cloud access checklist

Before enabling the existing feed, record the actual export table, dataset location, query project, selected usage project and assistant-web runtime principal. Live values and IAM are unknown until verified; a healthy release does not establish billing access. Retain `GCP_BILLING_SCOPE=project` unless the owner explicitly selects account-wide reporting.

The minimum proposed access is `roles/bigquery.jobUser` for that runtime principal **on the query project**, and `roles/bigquery.dataViewer` **on the export dataset**, with the BigQuery API enabled in the query project. Enabling the billing export itself is a separate billing-account owner action. Review the exact dataset/project/principal before granting anything. No billing-account administrator role belongs on the runtime. If authentication needs renewal, renew it through the normal owner login; do not reset credentials or infer missing roles from an authentication failure.

After setup approval, reconcile the selected project/service/SKU rows, currency, gross cost, signed credits and net amount with the export for the exact UTC usage period. Check the latest export and usage timestamps and known backfill gaps. A project report can omit unallocated taxes/adjustments; it cannot establish the full account invoice. BigQuery reads may incur charges even for a read-only query: approve the query scope and maximum bytes before the first live check.

### Activation acceptance

For each feed, verify the displayed scope and period against its actual source, including a genuine zero, stale/revoked access and completeness. OpenAI must reconcile all cursor pages for the selected project/key filters; OpenRouter must match the connected key, excluding other keys and credit purchases; Google must reconcile signed credits and service rows without separately adding Vertex. Keep source timestamps distinct from fetch/check times. Never add the usage ledger to these reports. No combined total is introduced: other paid accounts and unverified connection attribution remain unknown.

## Model usage and additional providers

Every model-router ledger entry records its connection, model and available request ID, plus one of:

- `provider_reported`: the provider returned an explicit nonnegative USD cost, including an authoritative zero.
- `token_rate`: complete usage multiplied by configured model prices. This remains an estimate (cache discounts, tiers, negotiated rates and special modalities can differ).
- `preflight_estimate`: a preflight estimate used by explicitly estimated operation types. It is not a verified provider charge.
- `unknown`: a dispatched model or embedding attempt whose provider amount and complete token usage are missing, or whose metering write failed. Its positive reservation remains in the held budget total until a late actual is reconciled; it is never recorded as zero or automatically released.

Before the provider call, the reservation records a privacy-minimized attempt digest, model/provider/role, and input/output estimate. Provider generation IDs and endpoint labels are retained when available, so a late receipt can settle the same reservation once even after the originating task has ended. Provider receipts and cloud invoice exports remain separate accounting views. Stale, undispatched reservations may be released; stale dispatched reservations move to `unknown` and keep their hold.

New models automatically use the same metering path, including custom gateway identities. Live voice model usage is explicitly marked as a rate-based estimate. Connected providers without a billing connector show their coverage gap instead of a made-up bill. Direct OpenAI can additionally use the separately configured scoped Costs feed above; arbitrary compatible gateways still have no account billing connector. Neither routing configuration nor a feed for another project establishes complete account coverage. Vertex uses the Google Cloud export only when an exact project-scoped Vertex usage row is present. Search, maps, telephony, email, SMS, Apple services, Workspace seats, external CI and other vendor costs are conditional on those services being used or configured; their invoices are not imported here unless a source-specific integration is added. Adding a billing API requires a provider-specific adapter; there is no universal model billing endpoint.

## Month-end estimate and assistant limits

Web and iOS show an average daily spend and a month-end run rate for each available billing source, keeping currencies separate. The calculation is net month-to-date spend divided by elapsed UTC days, multiplied by the number of days in that month. Google uses the latest exported usage time; OpenRouter uses the snapshot fetch time. Estimates require at least three elapsed days and are withheld for stale or missing data. They assume coverage from the start of the month and similar future usage; partial exports, delayed charges, one-off credits and changes in usage can make them inaccurate. This is an estimate, not an invoice forecast from Google.

Vertex is marked as included only when the export contains a Vertex AI usage row for the exact configured project; a matching export configuration or rows for other services do not establish zero Vertex spend. Account-wide exports must contain that project's Vertex row before claiming coverage. The assistant's task, daily and monthly limits remain enforced using its operation ledger. “Edit assistant limits” does not edit provider billing budgets or stop infrastructure charges. The Costs page explicitly reports that a whole-app total is unavailable and lists known source scopes and gaps; no combined total is calculated.

## Refresh and persistence

Billing is read on demand and durably cached for one hour, shared by web and iOS, in the installation's existing tool cache. Snapshots are keyed by period, configuration and connection credentials (hashed, never stored in plaintext). Transport/auth/query errors retain the previous successful snapshot with a stale status; unsuccessful refreshes retry after five minutes. A prior month's snapshot cannot masquerade as the new month's spend. Cache records expire after seven days; this is a current-month dashboard, not a historical invoice archive. The billing export remains the historical source of truth.

PostgreSQL cost attempt reconciliation needs migration `0104_milky_masque.sql`; Firestore stores the same attempt state in its existing cost reservation documents. Billing snapshots do not create operation-ledger entries or change budget counters. This prevents overlapping billing sources from double-counting usage or unexpectedly pausing work.

The router currently withholds explicit prompt-cache hints because the provider cache contract does not let it bind retention to owner, policy, source and model revision. Provider-managed automatic caching may still occur where a provider enables it; measured cache economics and cross-scope behavior are not claimed.
