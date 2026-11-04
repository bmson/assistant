**Firestore migration and customer-owned Google Cloud installation**

Status: implementation started; the consumer installer and complete migration remain unfinished. See [implementation status](firestore-implementation-status.md).
Prepared: 2026-09-08. Repository baseline inspected: `2b9b2f4`.

Build a version of the current assistant that a customer installs into their own Google Cloud project. Use Firestore for application data, Cloud Storage for files, Cloud Run for execution, and Google models by default. Preserve OpenRouter as an option. All customer runtime, build, storage, and model costs belong to the customer; operating the assistant must require no publisher backend, credentials, billing account, or subscription service.

**1. Product contract and scope**

- New installations default to Firestore Standard edition in Native mode and Google model access through service identity.
- Existing installations remain on PostgreSQL until they explicitly migrate. Preserve their model choices and existing embeddings during the database cutover.
- Preserve current chat, cards, tasks, goals, missions, approvals, reminders, memory, people, knowledge graph, imports, budgets, privacy, and enabled-module behavior. Shipping a smaller prototype is a milestone, not completion of the migration.
- Web and iOS continue using the server application API. Do not introduce direct client database access as part of this change.
- Passkeys provide owner login without creating a Google OAuth client. Google Workspace connections are optional and separately configured.
- Keep browser, code, document processing, search, SMS, and other integrations as explicit modules. Show provider requirements and costs before enabling them.
- Keep a local development path using the Firestore emulator and existing local file/queue drivers. Retain PostgreSQL locally while migration compatibility is supported.
- Do not deploy, cut over production, publish source, or remove PostgreSQL resources merely by accepting this planning document. Those are implementation and release actions.

“Single-click install” means one entry button into a guided, resumable installation. Google account login, payment registration, and authorization to create resources still require customer interaction. Gmail/Calendar consent remains separate. Do not market the finished flow as literally one click from a new Google account to a fully connected mailbox.

**2. Current code and the real migration surface**

The original planning baseline contained 63 `pgTable` declarations; the current schema now has 66. A source scan found approximately 140 non-test TypeScript files importing database or Drizzle APIs, including 66 in core and 31 in application. This is a persistence refactor across business use cases, not a replacement of `createDb()` alone.

| Current area         | Evidence and implication                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Database adapter     | `packages/db/src/client.ts` exposes a concrete Drizzle `Db`; schema-derived types leak into consumers.                             |
| Application boundary | `docs/architecture.md` already calls out incremental migration toward repository interfaces; retain its presentation boundaries.   |
| Composition          | `apps/agent/src/deps.ts` and `apps/web/lib/server.ts` construct database and model adapters.                                       |
| Correctness          | `packages/core/src/cost.ts` and `packages/core/src/workflow/reminders.ts` use PostgreSQL transactions and advisory locks.          |
| Retrieval            | Six vector-bearing tables use 1,536-dimensional embeddings and HNSW indexes. Graph and conversation recall also join related rows. |
| Models               | `packages/core/src/model-router/router.ts` constructs OpenRouter directly and uses its options and usage metadata.                 |
| Authentication       | `apps/web/auth.ts` requires owner-allowlisted Google login in production; mobile access uses a separate credential.                |
| Configuration        | `packages/config/src/index.ts`, setup preflight, and deployment assume PostgreSQL and require an OpenRouter key.                   |
| Deployment           | `infra/gcp/deploy.sh` expects an external database and runs initial SQL migrations locally. Releases use migration/backup jobs.    |
| Idle cost            | Deployment sets the web minimum to one instance and runs a sweep every minute. The Google module also polls Gmail every minute.    |
| Privacy              | `packages/application/src/profile/privacy.ts` has export/erasure behavior and durable tombstones that must survive migration.      |

Re-run this inventory at implementation start because other repository work may have landed. Preserve existing worktree changes. Apply `apps/web/AGENTS.md` and read the installed Next.js documentation before implementing web changes.

**3. Target architecture and resource ownership**

| Responsibility                                | Target                                                                    | Ownership                                |
| --------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| Web dashboard and API                         | Cloud Run `assistant-web`, minimum zero instances                         | Customer                                 |
| Agent execution and callbacks                 | Cloud Run `assistant-agent`, minimum zero instances                       | Customer                                 |
| Operational records and semantic memory       | Firestore Native mode, Standard edition                                   | Customer                                 |
| Files, oversized payloads, recovery artifacts | Private Cloud Storage buckets                                             | Customer                                 |
| Durable dispatch                              | Cloud Tasks with application idempotency                                  | Customer                                 |
| Future scheduling and repair                  | Indexed Firestore schedule records plus bounded Scheduler jobs            | Customer                                 |
| Gmail push, when connected                    | Pub/Sub and scheduled watch renewal                                       | Customer                                 |
| Isolated work and maintenance                 | Cloud Run Jobs, created only when needed by the installation              | Customer                                 |
| Models and embeddings                         | Google provider using service identity; optional OpenRouter               | Customer                                 |
| Secrets                                       | Secret Manager and existing encrypted connector storage where appropriate | Customer                                 |
| Build and images                              | Cloud Build and Artifact Registry                                         | Customer                                 |
| Infrastructure state                          | Versioned private Cloud Storage bucket                                    | Customer                                 |
| Logs, alerts, billing visibility              | Cloud Logging/Monitoring and project billing links                        | Customer                                 |
| Source releases                               | Versioned downloadable source, initially a public repository release      | Distribution only; no runtime dependency |

Do not provision Cloud SQL, a dedicated vector service, Kubernetes, a load balancer, or a permanent installation server for the default profile. These are unnecessary for the proposed base deployment.

A dedicated customer project is the default isolation boundary. Use the eligible `(default)` Firestore database in a new project; do not take over an existing database or silently create a named database with different free-quota eligibility. Region selection must cover the intersection of supported database, compute, and selected model locations. Explain that database location and passkey hostname choices are durable decisions.

Public source hosting can use a free distribution tier, but this is not an unlimited hosting-cost guarantee. Customer installations build images themselves. Retain the source archive and working image digests in the customer project so running, repairing, and restoring an installation does not depend on the publisher remaining online.

**4. Persistence interfaces and package changes**

Introduce `packages/persistence` for provider-neutral entities, value types, repository interfaces, and shared contract fixtures. Keep it independent of core and both database SDKs. Retain `packages/db` as the PostgreSQL implementation during transition; introduce `packages/firestore` as the new implementation. Composition roots select the implementation once per process.

Repositories express business operations, not SQL-shaped generic CRUD. Examples include `reserveBudget`, `claimTask`, `recordApprovalDecision`, `cancelReminder`, `appendMessage`, and `retrieveMemories`. Operations requiring atomicity across entities must be a single repository command with an explicit transaction contract; splitting them across independent repositories must not weaken atomicity.

Move `$inferSelect` and other Drizzle-derived public types behind these interfaces. Preserve API DTOs and domain semantics. Treat this as a staged dependency inversion: migrate one use case, prove parity on PostgreSQL, implement it on Firestore, then move to the next. Do not build a SQL interpreter or pretend Firestore can execute arbitrary Drizzle queries.

Update `scripts/check-boundaries.ts` so core, application, tools, and module business logic depend on persistence interfaces rather than either SDK. Temporary exceptions must be an enumerated shrinking list, with no new exceptions added for convenience. Move business rules currently in `packages/db/src/entities.ts` into an appropriate domain module as their queries move into adapters.

Proposed central configuration additions: `DATABASE_DRIVER`, `FIRESTORE_DATABASE_ID`, `MODEL_PROVIDER`, embedding model/version/dimension settings, `AUTH_MODE`, and installation/release identifiers. Names must be finalized against existing config conventions before code changes. Provider validation must be conditional: a Firestore/Google installation must start without `DATABASE_URL`, `PROD_DATABASE_URL`, or `OPENROUTER_API_KEY`.

**5. Firestore data model and complete coverage**

Use installation-scoped collections with stable IDs and explicit relationship IDs. One document per message, task, approval, event, or memory; never grow an entire conversation or ledger inside one document. The following is a coverage inventory of the original 63 table exports (extend this inventory for subsequent schema additions), not a requirement to translate each into exactly one collection.

| Domain                        | Current table exports that must be mapped                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Identity and configuration    | `agents`, `channelBindings`, `mcpConnections`, `notificationPrefs`, `deviceTokens`                                         |
| Conversation and presentation | `conversations`, `messages`, `conversationSegments`, `generatedCards`, `generatedCardRevisions`                            |
| Goals and execution           | `goals`, `tasks`, `toolCalls`, `approvals`, `applicationConfirmations`, `approvalPolicies`                                 |
| Memory and people             | `memories`, `memoryTombstones`, `ownerCard`, `contacts`, `occasions`                                                       |
| Knowledge graph               | `knowledgeGraphEntities`, `knowledgeGraphEntityAliases`, `knowledgeGraphSources`, `knowledgeGraphRelations`                |
| Situations and commitments    | `situationPacks`, `situationPreviews`, `commitments`, `suggestions`                                                        |
| Models and costs              | `models`, `modelRoles`, `modelCalls`, `costEvents`, `costReservations`, `rateTable`, `budgets`                             |
| Documents and imports         | `files`, `documents`, `documentChunks`, `importSources`                                                                    |
| Writing and learned skills    | `writingSamples`, `voiceProfile`, `skills`, `improvementProposals`                                                         |
| Email and watches             | `gmailSyncState`, `emailIngest`, `watches`, `watchFires`                                                                   |
| Scheduling and coordination   | `schedules`, `toolCache`, `rateLimits`                                                                                     |
| Proactive context             | `proactivePings`, `proactiveMoments`, `locationPings`, `ambientSnapshots`, `dreamNotes`                                    |
| Diagnostics and maintenance   | `anomalies`, `assistantHealthAlerts`, `canaryRuns`, `selfMaintenance`, `responseChecks`, `recallMetrics`, `recallFeedback` |

Add operational records for installation state, migrations, owner credentials/sessions, device pairing, dispatch outbox, deduplication, unique-value reservations, and query projections.

For every repository query, record filters, sort order, pagination cursor, composite index, result bound, expected document/index reads, consistency requirements, and deletion behavior. Replace joins with explicit fetches or maintained projections. A stale projection may affect presentation temporarily, but cannot authorize an action or decide whether a reminder is cancelled. Preserve deterministic sorting with timestamp and ID tie-breakers.

Use explicit codecs for timestamps, null versus absent fields, enums, bytes, and monetary values. Store money using a documented fixed-precision representation and verify conversion from existing decimal values. Preserve original IDs or use a reversible mapping for identifiers invalid in Firestore paths.

Keep large attachments, raw tool output, and oversized imported source bodies in Cloud Storage with digest, size, and ownership metadata. Set an application payload limit below Firestore's 1 MiB document ceiling. Exempt unqueried large text/maps from ordinary indexes. Define all required indexes as versioned infrastructure and wait for readiness before enabling queries. [Firestore limits](https://firebase.google.com/docs/firestore/quotas), [indexing practices](https://docs.cloud.google.com/firestore/native/docs/best-practices)

Use the server SDK with dedicated runtime identities. Deny browser/mobile access through Firestore Security Rules; server SDK authorization uses IAM and therefore still requires owner/trust checks in application use cases. Do not mistake Security Rules for a guard on privileged server requests.

**6. Atomic workflows: implement and prove these first**

| Behavior            | Firestore design                                                                                            | Required evidence                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Budget reservations | Transactionally update daily/monthly/task counters and a stable reservation ID; settle/release idempotently | Concurrent requests cannot reserve beyond the allowed ceiling; retries do not double-charge      |
| Task claiming       | Compare state/version, then set lease owner, expiration, and fencing generation                             | An expired worker cannot overwrite a newer worker's state                                        |
| Approvals           | Atomic pending-to-decided transition and one durable continuation intent                                    | Double clicks and duplicate callbacks cause one continuation                                     |
| Reminders           | Cancellation/generation state and delivery commitment share a transaction boundary                          | A cancellation that wins the race prevents subsequent delivery commitment                        |
| External actions    | Persist an outbox intent atomically, then dispatch outside the transaction                                  | A committed action is recoverable after a crash; retries use provider idempotency when available |
| Uniqueness          | Deterministic reservation documents for channel IDs, ingest IDs, and other unique keys                      | Parallel inserts preserve each existing uniqueness rule                                          |
| Privacy erasure     | Durable tombstone/erasure generation, bounded deletion job, and immediate read/recall exclusion             | Interrupted deletion or stale extraction cannot reintroduce forgotten data                       |

Firestore transactions can retry. Never call an LLM, send a message, enqueue a Cloud Task, or modify an external system inside the transaction callback. Persist the decision first, then perform the side effect. Handle ambiguous provider responses explicitly rather than promising exactly-once behavior across external services. [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)

Cloud Tasks delivery is a trigger, not the authoritative task state. Use stable operation IDs plus persisted deduplication; queue-name deduplication alone is insufficient. The outbox dispatcher must recover a crash between database commit and queue creation. All callbacks retain existing route-specific Google OIDC checks.

Reminder cancellation must distinguish pending work from delivery already committed or in flight. Do not return successful prevention for an already-sent external notification. In-app message creation and the reminder's delivery transition should commit atomically. Regression tests must preserve existing one-time versus recurring behavior, natural-language cancellation, and truthful results.

Keep transaction documents small and bound retries. Start with per-installation budget counters appropriate to one owner; benchmark contention before introducing sharding that could weaken a strict cap. Separate authoritative counters from rebuildable reports. [Transaction contention and isolation](https://firebase.google.com/docs/firestore/transaction-data-contention)

**7. Retrieval, graph, and embedding migration**

- Implement vector retrieval for messages, conversation segments, memories, skills, writing samples, and document chunks. Preserve source provenance, confidence, temporal validity, owner-only recall, quarantine, and trust filtering.
- Maintain graph entities, aliases, relations, and source links with bounded adjacency queries/projections. Preserve current hop and result limits. Do not fetch the entire graph per chat turn.
- Apply authorization/trust/source eligibility before ranking where supported, and recheck authoritative records before injecting results. Bound any over-fetch loop and test recall loss from post-filtering.
- Validate cosine-distance conversions and existing similarity thresholds. Firestore vector search is a different query/index implementation from PostgreSQL HNSW; preserve semantic results rather than assuming identical ordering.
- Record embedding provider, model, dimension, task type, and version. New Google installations use a supported output dimension no greater than 2,048, selected and tested during the provider spike. Existing 1,536-dimensional vectors fit Firestore's dimensional limit. [Vector search](https://firebase.google.com/docs/firestore/vector-search)
- Preserve existing OpenRouter embeddings during database migration. Switching to Google embeddings is a separate, resumable backfill with new versioned indexes. Never compare vectors from different models even when their dimensions match.
- Route reads to the old embedding version until the new collection/index is complete and quality checks pass. Retain a bounded rollback window. Embedding generation is separately billed and must honor migration budgets.
- Inventory substring, exact-name, alias, and semantic search separately. Implement bounded exact/prefix lookups where sufficient. Do not silently replace a current text-search contract with semantic-only search or add a paid external search service. Any query that Standard edition cannot satisfy efficiently is a feasibility-gate decision, not an undisclosed regression.

Use the existing question-regression and recall fixtures to set the baseline. Add cases for graph provenance, revoked/forgotten facts, large imports, and duplicate names. Measure query latency and billed index reads at realistic and growing corpus sizes. The emulator is useful for contracts; validate vector indexes, IAM, cost, and production contention against real Firestore before sign-off.

**8. Google models without a model key**

Keep `ModelRouter`'s roles, tool loop, budgets, deadlines, and fallback decisions. Put provider construction, request options, streaming/tool-call normalization, embeddings, and usage accounting behind a small provider interface. Implement Google through the supported Google Cloud model API using the runtime service identity; keep OpenRouter as the second adapter.

Use a versioned release model catalog with tested regional availability, capabilities, fallback roles, and dated price estimates. Do not embed a transient model recommendation as an architectural dependency. Reserve conservatively, record reported usage, distinguish estimated cost from provider-reported cost, and never treat missing OpenRouter-style metadata as zero Google cost. Test reasoning-token accounting, tool schemas, structured output, cancellation, streaming errors, and retries.

A migrated installation preserves model preferences. A new installation defaults to the tested Google catalog. Enabling OpenRouter adds its secret and settings without changing the database driver. Google search grounding is not assumed to replace the existing `web.search` tool contract. [Google embedding API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings)

**9. Reduce idle work and measure total cost**

Change the new-install deployment profile to zero minimum instances for web and agent. Keep an opt-in warm-instance setting with a cost explanation. Measure first reply latency and resume behavior rather than silently keeping a process alive.

Replace broad minute-by-minute scans with indexed due-work queries, scheduled Cloud Tasks for near-term work, and a bounded periodic reconciliation job. Long-term reminders remain durable in Firestore and are materialized into the queue before their due date. Cloud Tasks currently limits scheduling to 30 days ahead, so it cannot be the only store of future reminders. [Cloud Tasks limits](https://docs.cloud.google.com/tasks/docs/quotas)

Prefer Gmail Pub/Sub for new mail, retain daily watch renewal and a measured repair cadence. Preserve history-cursor recovery when pushes are missed. Avoid database reads on every streamed token, every health check, or every client poll; persist bounded checkpoints and final results without compromising crash recovery. Paginate history and suppress background polling when clients are inactive.

Publish a cost worksheet for idle, light, daily, and import-heavy usage. Include Firestore document/index operations, vector scans, storage, backups/PITR, Cloud Run, Scheduler, Tasks, Secret Manager, logs, image retention, Cloud Build, and model calls. Do not label free allowances as a guaranteed free installation. A provisional light-use database target is under $5/month, excluding models and other services; it is a benchmark goal, not a quoted price. [Firestore pricing](https://cloud.google.com/firestore/pricing)

Enable project billing alerts and application-enforced model/task budgets. Alerts-only budgets do not cap spending. Google's preview spend-cap features must be separately checked for service coverage and availability before offering them; do not automatically disable project billing as a general safety mechanism. [Billing controls](https://docs.cloud.google.com/billing/docs/how-to/budgets)

**10. Owner claim, passkeys, and mobile access**

Implement an owner identity independent of Google OAuth, using a maintained WebAuthn library and the existing server session boundary. Preserve optional Google login for existing installations.

The authenticated installer generates a high-entropy, expiring, single-use owner-claim secret; persist only its verifier and ownership/installation context. Display it only to the installer, never in public build logs, ordinary request logs, analytics, or Terraform outputs. Deliver the setup link with a fragment or a separate code exchanged by POST, clear it from browser history, and atomically consume it with passkey registration. A public first visitor must never be able to claim an installation.

Validate WebAuthn challenge, origin, relying-party ID, user verification, and replay protection. Use the exact stable customer hostname, not a shared `run.app` parent. Authenticate all existing web/API paths through the same owner checks; secure session cookies, CSRF/origin checks, rate limits, and credential/session revocation are required. Provide a second passkey and offline recovery code; cloud-owner recovery must work without publisher email delivery. Domain changes require an explicit credential transition.

For iOS, keep the current server API and introduce one-use pairing plus per-device revocable credentials stored in Keychain. The browser owns passkey login; arbitrary customer hostnames must not be assumed to work with native associated-domain entitlements. A QR payload should carry a short-lived pairing challenge, not a permanent bearer token. Require owner approval and bind the exchange to the requesting device.

Apple push is a separate distribution constraint. Never distribute the publisher's APNs private key to customer servers. Preserve APNs for existing installations that already supply valid credentials. A fully independent native build needs customer-controlled Apple signing and push credentials; the default web installation must function without native push. A public iOS app with independent customer-hosted push requires a separately resolved design before promising that feature. Keep this explicit rather than hiding a publisher relay in the architecture. [APNs authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)

**11. Infrastructure and installation mechanism**

Extend `packages/setup` with an installation manifest, state machine, safe diagnostics, and resume behavior. Add `infra/gcp/terraform` for the new profile and a small bootstrap entry point. Existing shell deployment remains supported for legacy releases during transition; do not maintain two competing writers for resources within the same installation.

Choose Terraform run by the customer's Cloud Build pipeline. Bootstrap only the project/API prerequisites, installer identity, and private state/source buckets with authenticated `gcloud`, then let versioned Terraform own the declared resources. Keep bootstrap and managed-resource ownership explicit. Store secrets outside Terraform values/state wherever possible; secret-resource references and versions are sufficient for service deployment.

The manifest records release commit/archive digest, project, region, database ID, selected modules, provider/model configuration, image digests, schema versions, resource inventory, and completed stages. Never put secret values in it. Copy the selected source archive into the customer's bucket so a retry does not follow a moved branch.

Installation stages:

1. Authenticate in the customer environment; select/create a dedicated project and link an existing billing account. New payment registration remains a Google-controlled step.
2. Check required roles, project/billing permissions, organization restrictions, quotas, regions, available model endpoints, and resource-name collisions before creating the main stack.
3. Show the selected capabilities, a dated usage-based estimate, ongoing resources, and the permission request; obtain the customer's deployment authorization.
4. Bootstrap the installer identity and state/source storage. Use explicit resource-level roles and `actAs` permissions; no publisher service account, downloaded account key, or long-lived user token in deployed containers.
5. Provision Firestore, indexes, buckets, secrets, service identities, queues, and selected optional resources. The web/agent must not be able to grant themselves installation privileges.
6. Build immutable images in customer Cloud Build and store them in customer Artifact Registry. Pin source, lockfile, tooling, and base-image inputs according to the release policy; capture provenance and vulnerability results.
7. Run idempotent initialization/migrations with a dedicated Cloud Run Job. Deploy services using recorded image digests; reconcile the actual URLs and route-specific OIDC audiences through the infrastructure inputs.
8. Run readiness checks for storage, indexes, database, queue callbacks, model availability, and owner-claim readiness. Do not activate autonomous work before initialization and owner setup are complete.
9. Show the owner-claim link and the customer-owned installation status page. Once the build has started, browser closure must not stop provisioning. Earlier interruptions are resumable from durable state.

Use a static release/README “Install in Google Cloud” button and a Cloud Shell tutorial as the first distribution surface; no publisher-hosted installer backend. Prove the exact entry flow in Phase 0: current Open in Cloud Shell documentation says non-allowlisted repositories open in a temporary environment without inherited user credentials. A repository link therefore does not prove deploy authorization works. Test the supported explicit sign-in path. If it is not suitable, use the normal authenticated Cloud Shell with one documented, version-pinned bootstrap command. State that extra step honestly rather than depending on unavailable credentials. [Cloud Shell entry behavior](https://docs.cloud.google.com/shell/docs/open-in-cloud-shell)

The installer should ask only for installation name, project/billing selection, region, and optional features; everything else is defaulted or derived. Omit a custom domain, OpenRouter, Workspace, SMS, and native push from the base-install prerequisites.

**12. Consumer onboarding screens and account connections**

| Screen                     | Customer action                                                 | System action                                           |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Install                    | Click the release's installation button                         | Open the supported Google setup environment             |
| Google account and billing | Sign in, complete payment setup if needed, select project       | Validate authority and supported location               |
| Review                     | Confirm estimated usage/capabilities and installation           | Persist manifest and start customer build               |
| Progress                   | Wait or close/reopen                                            | Show resumable resource/build/check status              |
| Secure your assistant      | Open private setup link, register passkey, save recovery method | Atomically bind owner and enable authenticated use      |
| First conversation         | Enter name/timezone and send a message                          | Use Google model credentials from service identity      |
| Optional connections       | Connect desired accounts or pair a device                       | Store credentials only in their installation            |
| Ownership                  | Open billing, update, restore, export, or uninstall             | Hand privileged operations to cloud-owner authorization |

After passkey setup, chat/memory/tasks must work before Gmail is connected. Build a separate Workspace wizard in the deployed app: exact console links, app/audience values, copyable callback URL, credential entry, then browser consent. Replace `scripts/auth-bot.ts`'s localhost callback with a customer-hosted callback for this flow. Keep OAuth state/PKCE where applicable, secret handling, token revocation, and reconnect UX explicit.

Clarify which account owns the assistant's mailbox versus the human owner. A separate bot mailbox is optional and requires its own account; calendar/file sharing must be deliberate. Personal installations can qualify for Google's verification exception, but may still display an unverified-app warning. External apps left in Testing have seven-day refresh tokens for Workspace scopes. Guide customers through an appropriate production/personal-use configuration without presenting publishing status as verification. Work accounts may need administrator approval. [Personal-use exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#personal-use), [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

Do not add a publisher OAuth proxy or shared secret to hide these steps. Credentials entry must be masked, validated, and excluded from logs. Finish with a read-only connection check; any live sending test requires a deliberate customer action.

**13. Migration of the current installation**

Keep the old service operational while developing and rehearsing against copies. Select the data store at installation level; do not run production dual writes as the default migration strategy.

1. Build a repeatable PostgreSQL exporter and Firestore importer with a versioned format, manifest, entity counts, checksums, ID/reference mappings, timestamps, and resumable checkpoints. Export all current table families, including history, ledger data, tombstones, model preferences, schedules, and pending approvals.
2. Inventory current Cloud Storage objects, encryption keys, and provider secrets. Reuse existing customer-owned storage where appropriate; otherwise copy with digests and preserve the keys required to decrypt migrated data. Keep secrets in a separately restricted transfer path, not an ordinary data export.
3. Rehearse from a consistent PostgreSQL snapshot into an isolated Firestore database/project. Validate every mapping, relationship, uniqueness invariant, money total, pending operation, and index. Produce an exceptions report; no silently dropped rows or truncated payloads.
4. Run side-by-side read/recall comparisons without executing external actions from the rehearsal. Repair discrepancies and measure runtime/cost at actual corpus size.
5. At cutover, enforce server-side maintenance mode for all writers: web/mobile mutations, inbound webhooks, jobs, Scheduler, queue dispatch, imports, and autonomous work. Drain active operations and fence old workers. Handle inbound events through bounded buffering or provider cursor replay; reconcile the final cursor before resuming.
6. Take and verify the final backup, import final state, rebuild projections/indexes, and verify parity. Reconcile ambiguous in-flight side effects rather than automatically replaying them.
7. Deploy web and agent with one new installation generation, database driver, and schema version. Old callbacks are rejected or routed to reconciliation. Recreate due queue entries from authoritative records with stable IDs; do not blindly copy transient queue state.
8. Verify readiness and migration results before enabling writes, then resume bounded background work and monitor reminders, approvals, memory, and costs.

Before Firestore accepts new writes, rollback can return to the frozen PostgreSQL installation. After Firestore accepts writes, changing a connection setting back to PostgreSQL would lose data. Either roll application code back while keeping the compatible Firestore schema, or freeze again and run a rehearsed reverse export/import before switching databases. Define this boundary prominently in the runbook. Keep the SQL backup and old instance through an explicit observation period; removal is a separate owner action.

**14. Updates, backup, recovery, and uninstall**

- Updates select an immutable source release and run a customer Cloud Build pipeline under cloud-owner authorization. A web button can open this workflow; the web runtime must not have IAM administration or arbitrary deployment privileges. Initial release checks are manual/on demand, not a required publisher service.
- Use versioned, idempotent Firestore data migrations with a migration lease and checksummed journal. Prefer additive changes; keep the previous application revision compatible for the stated rollback window. Deployment waits for required indexes and migrations.
- Back up data, selected object generations, infrastructure/index definitions, release manifests, and required recovery secrets with explicit access controls. A user privacy export remains separate from an operational backup.
- Firestore exports during writes are not automatically point-in-time snapshots. Use a supported PITR snapshot or a write freeze for a consistent recovery point. Index definitions are not included in a Firestore export, so retain them with the release. Restore into an empty target or account explicitly for extra records that imports do not remove. [Firestore export/restore behavior](https://firebase.google.com/docs/firestore/manage-data/export-import)
- Restoring must initially suppress external actions and reapply erasure/tombstone policy so old backups cannot silently resurrect forgotten memory. Preserve or deliberately rotate sessions, device credentials, and connector encryption material.
- Uninstall first stops schedules/queues and execution, offers a data export and explicit backup retention choice, then removes only installation-owned resources from the recorded inventory. Remove images, build artifacts, secrets, and retained storage when selected. Report remaining billable resources. Never delete an entire pre-existing project automatically.
- Verify the instance continues operating when publisher network endpoints are unavailable; export and local-source repair must remain possible.

**15. Delivery sequence and estimates**

These are planning estimates in engineer-days for one experienced engineer, including focused tests and documentation. They are not elapsed-time commitments. Full parity is substantially larger than the earlier Cloud SQL migration estimate.

| Phase | Deliverable and main files                                                                                              | Depends on               | Estimate | Exit gate                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------- | -------------------------------------------------------------------------------------- |
| P0    | Feasibility spikes: Firestore atomic commands/vector costs; actual Cloud Shell entry/auth; Google models; passkey claim | None                     | 3–5      | No unresolved blocker hidden behind the installer promise; record measured baselines   |
| P1    | Provider-neutral entities and repository contracts; boundary checks; PostgreSQL adapter parity                          | P0                       | 4–7      | First use cases pass identical behavioral contracts; public API shape unchanged        |
| P2    | Firestore chat, tasks, approvals, budgets, outbox, leases, reminders                                                    | P1                       | 6–10     | Concurrency/crash/replay suite passes on emulator and real Firestore                   |
| P3    | Remaining application/module repositories, graph/recall, imports, privacy, diagnostics                                  | P2                       | 8–12     | All current table families mapped; no live SQL requirement for Firestore profile       |
| P4    | Google provider, optional OpenRouter, versioned embeddings                                                              | P1; integrate with P2/P3 | 3–5      | Tool, streaming, cost, fallback, and recall evaluations pass                           |
| P5    | Due-work scheduling, polling reduction, idle-cost profile                                                               | P2/P3                    | 3–5      | Reminders remain timely and measured idle/database costs meet agreed targets           |
| P6    | Passkeys, owner recovery, sessions, per-device pairing                                                                  | P1/P2                    | 4–7      | Unclaimed server cannot be taken over; web/mobile authentication and recovery pass     |
| P7    | Terraform, customer builds, install manifest, resumable bootstrap                                                       | P0; integrates P3–P6     | 4–7      | Clean account/project installation needs no publisher credentials or existing database |
| P8    | Onboarding UX and optional Workspace connection wizard                                                                  | P6/P7                    | 3–5      | Users can reach first chat without OAuth client or API-key setup                       |
| P9    | PostgreSQL export/import, rehearsal and cutover runbooks                                                                | P3–P5/P7                 | 4–6      | Data parity and rollback boundaries proven against a realistic copy                    |
| P10   | Updates, consistent backup/restore, export, uninstall                                                                   | P7/P9                    | 3–5      | Restore and upgrade rehearsals succeed; uninstall accounts for retained charges        |
| P11   | Fresh-account pilot, full regression, docs and source release preparation                                               | All                      | 4–6      | Acceptance checklist below complete before general release                             |

Total: approximately 49–80 engineer-days, or 10–16 engineer-weeks. Infrastructure, auth, and provider work can overlap once interfaces stabilize if staffing permits. Re-estimate after P0 and P1; query complexity and current production data volume are the largest unknowns.

Recommended first implementation batch: P0 plus the minimum P1 contracts needed to prove reserve-budget, claim-task, cancel-reminder, append-message, and retrieve-memory. Do not migrate production or remove SQL support in that batch.

Track each phase as focused reviewable PRs. Land PostgreSQL-preserving refactors before driver changes; keep migrations, provider changes, authentication, and installer privileges independently reviewable. Source publication and any live production cutover require their own concrete release review.

**16. Validation and release acceptance**

- Keep `pnpm lint`, architecture checks, `pnpm typecheck`, production build, and the existing full `pnpm test` SQL baseline. Extend the test runner with isolated Firestore emulator fixtures and adapter contract tests; do not silently replace the SQL suite during transition.
- On real Google infrastructure, verify vector index readiness, runtime IAM, queue OIDC, duplicate delivery, transaction contention, recovery, model access, and measured costs. Tests use synthetic data; current production data is only used through an explicitly scoped migration rehearsal.
- Validate web and iOS contract parity, cards, approval lifecycle, streaming/resume, per-device revocation, and passkey browser compatibility. Run applicable iOS tests and report manual device checks separately.
- Exercise the crash matrix: before/after transaction commit, queue enqueue, external provider call, response receipt, and state settlement. Prove no false cancellation success, no silent lost outbox intents, and no automatic replay of ambiguous irreversible actions.
- Rehearse failure at every install stage, closing Cloud Shell/browser, rerunning install, denied IAM, missing model quota, duplicate installation, unavailable region, existing Firestore resources, expired claim, and partially completed upgrades.
- Test both a fresh personal Google account and an existing project. Organization-restricted accounts must get actionable diagnostics rather than partial misleading success.
- Verify the Firestore profile contains no mandatory Neon, OpenRouter, SQL migration, publisher OAuth, publisher cloud key, or publisher push relay dependency. Optional external capabilities disclose their own requirements.
- Demonstrate first chat, a delivered reminder, a cancelled reminder, an approved action, semantic recall with provenance, privacy erasure, a document import, optional Google account connection, and device pairing.
- Verify a backup restores into a clean target with indexes and encryption material, with autonomous actions paused. Rehearse migration rollback before the write boundary and application rollback afterward.
- Run an idle observation and representative daily/import workloads. Publish observed costs and latency, separating models and one-time builds from database/runtime charges. Do not claim zero-cost operation based on emulator tests or free credits.
- Pilot target: at least four of five first-time testers reach authenticated first chat without developer help; median hands-on setup under ten minutes once Google billing is ready. Measure Google registration, provisioning wait, and optional OAuth setup separately. These are targets, not current performance claims.
- A release is complete only after clean-project installation, migration rehearsal, upgrade, restore, uninstall, and current-client regression checks pass. The source release must include the installer, checksummed inputs, compatibility manifest, documentation, and a clear list of optional integrations.

The intended result is a fully customer-owned assistant with no always-running database bill and no required publisher-operated service. Firestore correctness and a proven Google authorization entry flow are the first gates; the installation button comes after those are real.
