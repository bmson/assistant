# Runtime support matrix

Source snapshot reviewed 2026-10-07. This matrix describes repository configuration and composition, not a deployed release receipt. It is not evidence that a deployment uses these values or that a route passed a live probe. The checked source/route inventory is [runtime-support-matrix.generated.json](runtime-support-matrix.generated.json); verify it with `pnpm support:matrix:check` and refresh it with `pnpm support:matrix:write` after intentional composition or route changes. Read [recovery](recovery.md) for PostgreSQL restore fencing and the [Firestore cutover checklist](firestore-cutover-checklist.md) for migration gates. A healthy `/api/health`, source adapter coverage, and test counts do not authorize PostgreSQL deletion.

The generated record includes the latest PostgreSQL migration ordinal, reviewed release API/schema ranges, source composition digests, and exported web route methods/digests. `pnpm support:matrix:check` fails closed if the current PostgreSQL schema is outside the agent/web reviewed range or the source/route snapshot is stale; it never widens a compatibility range. Historical `release-contracts.json` metadata remains separate from a live deployment receipt.

## Repository defaults and supported profiles

| Area | Current source behavior | Evidence and boundary |
| --- | --- | --- |
| Persistence | PostgreSQL is the default (`PERSISTENCE_DRIVER=postgres`). Firestore is an opt-in agent profile; the web composition and production activation remain separately gated. | `packages/config/src/index.ts`; `apps/agent/src/deps.ts`; `apps/web/lib/server.ts`; `docs/firestore-cutover-checklist.md` |
| Queue and dispatch | The config default is local queueing. The GCP deployment path configures Cloud Tasks and a scheduled sweep. Local queue mode can poll and execute due work; it is not inert for a restored database. | `packages/config/src/index.ts`; `apps/agent/src/index.ts`; `apps/agent/src/poller.ts`; `infra/gcp/deploy.sh` |
| Authentication | The config default is Google owner authentication. Passkey owner authentication is an explicit Firestore installation profile with separate setup/recovery rules. | `packages/config/src/index.ts`; `docs/consumer-owner-passkeys.md`; `apps/web/lib/server.ts` |
| Modules | The source config defaults `ASSISTANT_MODULES=all`; the GCP deploy script also defaults to all modules. A selected but unconfigured module may be unavailable while its guarded routes remain mounted. A disabled module is a hard capability gate. | `packages/config/src/index.ts`; `packages/config/src/modules.ts`; `docs/modules.md`; `infra/gcp/deploy.sh` |
| Client | Web routes and Server Actions are composed from `apps/web`; the iOS client uses the mobile API. Firestore route support and client support are distinct from production activation. | `apps/web/app/api/mobile/v1`; `apps/ios/Assistant`; historical inventories below |
| Provider and vectors | Source config defaults `LLM_PROVIDER=openrouter`. Firestore vector records require explicit provider/model/dimension/revision provenance and are not presumed compatible across embedding spaces. No deployed provider or embedding-space receipt is recorded here. | `packages/config/src/index.ts` (`parseFirestoreEmbeddingSpace`); `docs/system-reference.md` |
| Unsupported or fenced paths | Firestore requires the admitted portable module set and blocks canary/location paths that still depend on PostgreSQL. A path omitted or gated in a source profile must not be described as supported merely because the URL exists. | `packages/config/src/index.ts` (`validateAgentPersistenceConfig`); `apps/agent/src/deps.ts`; `docs/firestore-agent-runtime-inventory.md` |

## Historical inventories

The Firestore agent inventory and web-route inventory are dated snapshots (2026-09-26), not living proof of current source or production behavior. Their detailed classifications and counts are retained as historical evidence. Reconcile them against current composition and route trees before relying on an individual row; no claim in those snapshots establishes a deployed Firestore cutover. The implementation-status document is an implementation history, not a current deployment receipt.

## Deployment receipt

No current deployment receipt was collected for this review. A release receipt must be a separate, timestamped, read-only record tied to an exact release SHA. It should identify the serving web and agent revisions, effective persistence and queue settings, owner-auth mode, enabled modules, provider and embedding-space identifiers (never secret values), client build, dispatcher/scheduler state, backup evidence, and the exact end-to-end probes exercised. A missing field is unknown; repository defaults and emulator results cannot fill it in.
