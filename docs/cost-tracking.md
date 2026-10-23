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

## Model usage and additional providers

Every model-router ledger entry records its connection, model and available request ID, plus one of:

- `provider_reported`: the provider returned an explicit nonnegative USD cost, including an authoritative zero.
- `token_rate`: complete usage multiplied by configured model prices. This remains an estimate (cache discounts, tiers, negotiated rates and special modalities can differ).
- `preflight_estimate`: a preflight estimate used by explicitly estimated operation types. It is not a verified provider charge.
- `unknown`: a dispatched model or embedding attempt whose provider amount and complete token usage are missing, or whose metering write failed. Its positive reservation remains in the held budget total until a late actual is reconciled; it is never recorded as zero or automatically released.

Before the provider call, the reservation records a privacy-minimized attempt digest, model/provider/role, and input/output estimate. Provider generation IDs and endpoint labels are retained when available, so a late receipt can settle the same reservation once even after the originating task has ended. Provider receipts and cloud invoice exports remain separate accounting views. Stale, undispatched reservations may be released; stale dispatched reservations move to `unknown` and keep their hold.

New models automatically use the same metering path, including custom gateway identities. Live voice model usage is explicitly marked as a rate-based estimate. Connected providers without a billing connector show their coverage gap instead of a made-up bill. When direct OpenAI or arbitrary compatible gateways are used, the ledger records usage but their account invoices are not imported. Vertex uses the Google Cloud export only when an exact project-scoped Vertex usage row is present. Search, maps, telephony, email, SMS, Apple services, Workspace seats, external CI and other vendor costs are conditional on those services being used or configured; their invoices are not imported here unless a source-specific integration is added. Adding a billing API requires a provider-specific adapter; there is no universal model billing endpoint.

## Month-end estimate and assistant limits

Web and iOS show an average daily spend and a month-end run rate for each available billing source, keeping currencies separate. The calculation is net month-to-date spend divided by elapsed UTC days, multiplied by the number of days in that month. Google uses the latest exported usage time; OpenRouter uses the snapshot fetch time. Estimates require at least three elapsed days and are withheld for stale or missing data. They assume coverage from the start of the month and similar future usage; partial exports, delayed charges, one-off credits and changes in usage can make them inaccurate. This is an estimate, not an invoice forecast from Google.

Vertex is marked as included only when the export contains a Vertex AI usage row for the exact configured project; a matching export configuration or rows for other services do not establish zero Vertex spend. Account-wide exports must contain that project's Vertex row before claiming coverage. The assistant's task, daily and monthly limits remain enforced using its operation ledger. “Edit assistant limits” does not edit provider billing budgets or stop infrastructure charges. The Costs page explicitly reports that a whole-app total is unavailable and lists known source scopes and gaps; no combined total is calculated.

## Refresh and persistence

Billing is read on demand and durably cached for one hour, shared by web and iOS, in the installation's existing tool cache. Snapshots are keyed by period, configuration and connection credentials (hashed, never stored in plaintext). Transport/auth/query errors retain the previous successful snapshot with a stale status; unsuccessful refreshes retry after five minutes. A prior month's snapshot cannot masquerade as the new month's spend. Cache records expire after seven days; this is a current-month dashboard, not a historical invoice archive. The billing export remains the historical source of truth.

PostgreSQL cost attempt reconciliation needs migration `0104_milky_masque.sql`; Firestore stores the same attempt state in its existing cost reservation documents. Billing snapshots do not create operation-ledger entries or change budget counters. This prevents overlapping billing sources from double-counting usage or unexpectedly pausing work.

The router currently withholds explicit prompt-cache hints because the provider cache contract does not let it bind retention to owner, policy, source and model revision. Provider-managed automatic caching may still occur where a provider enables it; measured cache economics and cross-scope behavior are not claimed.
