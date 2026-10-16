# Firestore agent runtime inventory

Updated 2026-10-16. This lists every capability the production agent (`apps/agent`) enables and records whether it runs with zero SQL access when `PERSISTENCE_DRIVER=firestore` selects the Firestore composition in `apps/agent/src/deps.ts`. The selected production driver must be verified from deployment and runtime evidence; adapter coverage alone does not establish a production cutover. This inventory covers the agent only. Web and mobile routes are tracked in `docs/firestore-web-route-inventory.md`.

Production composition: `assistant.config.ts` composes 11 modules, and `infra/gcp/deploy.sh` defaults `ASSISTANT_MODULES=all`. The agent runs with `QUEUE_DRIVER=cloudtasks`, one Cloud Scheduler `/internal/sweep` job per minute, Gmail sync/watch scheduler jobs, and optional canary jobs. `packages/db/src/seed.ts` seeds 19 proactive schedules.

## Classification

- **Ready**: a Firestore adapter is selected in the Firestore composition, and an emulator test exercises it with a throwing SQL proxy.
- **Disabled**: `validateAgentPersistenceConfig` refuses the setting, or the Firestore composition deliberately does not register or run the path. It cannot reach SQL. It is also unavailable to the owner.
- **SQL**: the code path still calls PostgreSQL. It would hit the `unavailableSqlDb()` tripwire if Firestore mode reached it.

`validateAgentPersistenceConfig` admits `ASSISTANT_MODULES` ⊆ `FIRESTORE_PORTABLE_MODULES`, which lists all 11 production modules (browser, calendar, code, documents, google, maps, push, reminders, search, sms, watches). It also requires `CANARY_ENABLED=false`, an empty `LOCATION_PING_SECRET`, and `INTERNAL_AUTH_MODE=oidc` when `QUEUE_DRIVER=cloudtasks`. Anything outside those limits is **Disabled** by configuration.

## Process and dispatch

| Path | State | Notes |
|---|---|---|
| Boot (`buildFirestoreDeps`), `/health`, `/ready` | Ready | `firestore-boot.test.ts` spawns the process with an unreachable `DATABASE_URL`. No SQL client is constructed. |
| Local poller claim/drain (`QUEUE_DRIVER=local`) | Ready | Fenced by owner readiness. Claims only the configured agent. |
| `/internal/tasks/execute` (Cloud Tasks delivery) | Ready (route) | Runs the same `executeAgentTask`. |
| Durable outbox → Cloud Tasks dispatcher | Ready in #383 | With `QUEUE_DRIVER=cloudtasks`, the scheduled `/internal/sweep` is the single dispatcher. It reclaims expired leases, then runs `dispatchOutbox`. No local poller starts. `/internal/tasks/execute` answers 503 until the installation is ready. Covered by `firestore-cloudtasks.test.ts` and `firestore-boot-cloudtasks.test.ts`. |
| Canaries (`/internal/canaries/*`, browser canary webhook) | Disabled | Return 501 in Firestore mode. `canary_runs` is SQL. |
| Location webhook (`/webhooks/location`) + arrival nudge | Disabled | `recordLocationPing` and `maybeEnqueueArrivalNudge` are SQL. Firestore requires an empty `LOCATION_PING_SECRET`, so the route answers 404. Owner pings still arrive through the web's mobile `location` route, which is ported. |
| Vertex model probe | Ready | Firestore-only route. |

## Executor (general model loop)

| Path | State | Notes |
|---|---|---|
| Claim, checkpoint, sleep/park/complete, retries, dead letter | Ready | `ExecutionPersistence.tasks`. |
| Seed/context window, owner replies while parked | Ready | `executionContext`. |
| Planner, owner card, ambient, commitments, skills, history/graph recall, recall metrics | Ready | `firestore-executor.test.ts`, `firestore-chat.test.ts`. |
| Tool dispatch, approvals, policies, cost reservations, idempotency, cache | Ready | `dispatcher.firestore.test.ts`, `firestore-approval.test.ts`. |
| Browser/code job staging, callback, and settle | Ready | `executionJobs`. The `/webhooks/{browser,code}/callback` command keeps the hashed sentinel check, callback-versus-timeout ordering, lease fencing, and pending reservation settlement (`firestore-job-callbacks.test.ts`). |
| Final delivery to the task's own chat, generated cards, response checks | Ready | |
| Full composition with all 11 modules (construction + maintenance) | Ready in #387 | `firestore-full-composition.test.ts` checks that `createDb` is never called, every tool is classified (`SQL_DEPENDENT_TOOLS` is empty), no module tick or sweep step is non-portable, and a full `runFirestoreSweep` logs no SQL tripwire. |
| Final delivery for a conversation-less assistant task (e.g. seeded `tomorrow-check`) | Ready | `persistence.notifications`. The `notificationConversations` marker makes concurrent first uses converge on one conversation. `firestore-goals-missions.test.ts` races two finals and four direct calls. |
| Goal-blocked write (`recordGoalBlocked`) | Ready | `persistence.goals.recordBlocked`. `firestore-goals-missions.test.ts` runs an unattended goal session to its clarify park. |
| Missions (`startMission`, `wakeMission`) | Ready | `enqueueTask` carries the reflection cadence; the wake reads sessions and spend through `persistence.missions`, and reports through `persistence.messages` and the goal mirror. `firestore-goals-missions.test.ts` covers start, session spawn, the in-flight guard, the budget stop, and reflection. |
| Save-status answers | Ready | |

## Code jobs (`packages/core/src/memory/jobs.ts`)

Every job in `CODE_JOBS` has a Firestore port and an emulator test. The State column also records whether the job is in `FIRESTORE_PORTABLE_CODE_JOBS`, the list the Firestore runtime actually lets run.

| Job | Seeded schedule | State |
|---|---|---|
| `reminder.notify` | per reminder | Ready (#368, `firestore-reminder-delivery.test.ts`) |
| `memory.consolidate` | memory-consolidation | Ready (`firestore-memory-consolidation.test.ts`) |
| `memory.graph_sync` | knowledge-graph-sync | Ready (`firestore-graph-sync.test.ts`) |
| `documents.extract` | per upload | Ready (`firestore-document-extraction.test.ts`). |
| `watch.suggest` | per watch fire | Ready (`firestore-watches.test.ts`). It uses only `persistence.watches/messages/executionContext`. |
| `memory.extract` (+ commitments) | memory-extraction | Ready (`firestore-memory-extraction.test.ts`). Each conversation's facts, occasions, and open loops commit with a per-task checkpoint under the task lease, so a reclaimed run resumes after the last committed conversation. |
| `memory.sweep_loops` | open-loop-sweep | Ready (`firestore-open-loop-sweep.test.ts`). Retires open loops through `persistence.commitmentMaintenance`, each kind on its own window, and pages past a single query's limit. |
| `email.extract` | email-extraction | Ready (`firestore-email-extraction.test.ts`). Runs through `persistence.emailExtraction`: facts go through the Firestore memory writer (embedding space, content-hash and tombstone markers), and occasions stay quarantined. |
| `briefing.compose` | daily-briefing | Ready (`firestore-briefing.test.ts`). Reads the same inputs through `persistence.briefing`, proposes dates through `persistence.suggestions` (one per source, UUID-shaped ids), and posts through `persistence.ownerNotices`. |
| `pulse.check` | pulse (every 20 min) | Ready (`firestore-pulse.test.ts`). The moment ledger, calendar snapshot, actionable mail, due loops and situation packs go through `persistence.pulse`; suggestions and notices share the briefing seams. |
| `graph.curiosity` | knowledge-graph-curiosity | Ready (`firestore-graph-jobs.test.ts`). Gap inputs come from `persistence.graphCuriosity` using graph recall's active-relation rule, superseded memories included. The asked-gap ledger is a `dismissed` suggestion that never surfaces, and the question is an owner notice. |
| `memory.graph_date_backfill` | knowledge-graph-date-backfill | Ready (`firestore-graph-jobs.test.ts`). Runs through the curation fences (`persistence.graphDateBackfill`). A re-keyed date moves to the document id its canonical key derives, with no alias for the old relative wording, and duplicates fold in through the curation merge. |
| `chat.segment` | chat-segmentation | Ready (`firestore-chat-segmentation.test.ts`). Groups only vectors in `FIRESTORE_EMBEDDING_SPACE` and stamps new segments with it; one segment per start message. |
| `anomaly.scan` | anomaly-scan | Ready (`firestore-anomaly-scan.test.ts`). Reads auto-executed tool calls through `persistence.anomalyScan`, scoped by the owner's approval policies; anomaly ids are keyed by (kind, subject, window), so a re-scan or an imported row never double-reports. Alerts post to the Notifications conversation. |
| `skill.reflect` | skill-reflection | Ready (`firestore-skill-reflection.test.ts`). Reads the owner's finished tasks and their tool calls through `persistence.skillReflection`, and writes skills under the same owner and privacy-erasure fence as owner edits. An owner-authored skill is never overwritten, and a full 500-skill library is left as it is. |
| `self.improve` | self-improve | Ready (`firestore-self-improvement.test.ts`). Reads the week's signals through `persistence.selfImprovement`. Tool calls, model calls, response checks and graph sources count only when their task or memory is the owner's. The experience memory is saved through the lease-fenced `memoryExtraction.applyMemories` (`source: 'self-improve'`), and proposals are unique per (kind, title), including imported ones. The web applies or dismisses proposals through `FirestoreWorkspaceImprovementRepository`. |
| `ambient.refresh` | ambient-refresh (every 30 min) | Ready (`firestore-ambient-refresh.test.ts`). Builds the owner snapshot from `persistence.ownerContext` and writes it through `persistence.ambientSnapshots`, replacing an imported copy, clearing it once no fresh location exists, and writing nothing during a privacy erasure. |
| `dream.run` | dream | Ready (`firestore-dream.test.ts`). Reads the owner's failures and approval decisions through `persistence.dream`. Tool calls and approvals are kept only when their task is the owner's. Hypotheses are saved quarantined through `memoryExtraction.applyMemories` (lease-fenced, one checkpoint per task, tombstones honoured, `source: 'dream'`), and notes are keyed per task so a retried run converges. |
| `self.maintain` | self-maintain | Ready (`firestore-self-maintenance.test.ts`). Reads the owner's open proposals and records fenced backlog items through `persistence.selfMaintenance`. Items are unique per title, including imported ones. The PR primitive is unchanged and stays inert without a GitHub token. |
| `health.monitor` | assistant-health-monitor | Ready (`firestore-health-monitor.test.ts`). Reads signals through `persistence.assistantHealth` and `persistence.graphSync`; alerts once, reminds weekly and resolves as PostgreSQL does, and reopens an imported alert under its legacy key. |
| `documents.process` | document-processing (every 15 min) | Ready (`firestore-document-processing.test.ts`). Runs the launch, the one-shot callback and the hand-off to extraction through `persistence.documentProcessor`. |
| `import.run`, `voice.ingest` | on demand | Ready (`firestore-imports.test.ts`). Window commits and the voice checkpoint are lease-fenced. |

No code job is SQL-only: `firestore-sweep.test.ts` asserts `sqlOnlyCodeJobs()` is empty. `firestoreCodeJobUnavailable` stays as a guard that names any future job registered in `CODE_JOBS` without being admitted to `FIRESTORE_PORTABLE_CODE_JOBS`.

Goal sessions run through the portable goal gate. Unlike PostgreSQL, the Firestore sweep does not re-sync goal cadences each tick; the firing's instruction is rebuilt from the goal's current progress, and the cadence is the one the goal's last mobile or tool mutation wrote.

## Maintenance sweep (`/internal/sweep` and local poller)

| Step | State |
|---|---|
| `expireStaleApprovals`, `resumeResolvedApprovalTasks`, `renotifyStalledApprovals` | Ready |
| Watch expiry (`persistence.watches.expire`) | Ready |
| `runDueSchedules` (portable runner) | Ready. Goal sessions pass `prepareGoalSession` on `persistence.goals`, the same gate PostgreSQL uses (`firestore-goals-missions.test.ts`). |
| Stale cost-reservation release | Ready (`firestore-sweep.test.ts`). Runs inside `purgeExpired`, as in PostgreSQL. |
| `expireStaleSuggestions`, `renotifyStalledAttention`, `emitBudgetNotices` | Ready (`MaintenanceRepository`, `firestore-sweep.test.ts`, `maintenance.test.ts`). Stalled-attention scans walk a durable cursor, so tasks whose notice fails cannot starve later ones. A budget notice and its dedupe key commit together. |
| `backfillMessageEmbeddings` | Ready. Vectors are written only in `FIRESTORE_EMBEDDING_SPACE`, with matching space metadata, and only while the embed role produces that space. Messages are read in creation order behind a durable cursor that advances after the vectors are stored. A vector from another space is re-embedded. |
| `purgeExpired`, `purgeAgedHistory` | Ready. They delete the same data classes as PostgreSQL, including its foreign-key effects: graph provenance for expired memories, recall feedback and card or commitment provenance for messages, captured prompts for model calls, and freed idempotency keys. They keep the same rows: segment anchors, and tool calls referenced by an approval or a retained cost event. Kept rows stay behind a durable cursor that rescans at most daily. `firestore-maintenance-parity.test.ts` runs both drivers on the same rows. |
| `findDueTasks` backstop | Not needed. Every Firestore transition that makes a task runnable commits a durable wake intent. The local drain claims due tasks, and in Cloud Tasks mode the sweep reclaims expired leases and dispatches the outbox. |
| Module sweep steps: watches `reapExpiredWatches`, `pollWebWatches` | Ready in #374. Steps marked `portable` run under Firestore. |
| Module sweep step: google `reapExpiredApplicationWatches` | Ready (portable, `persistence.applications.expireDue`). |
| Module poller ticks: google `email-sync` | Ready (portable). |

## Modules

Every module is in `FIRESTORE_PORTABLE_MODULES`. `firestore-full-composition.test.ts` installs all 11 with configured credentials and a throwing SQL client.

| Module | Boot | Tools | Hooks / background | State |
|---|---|---|---|---|
| reminders | Ready | `reminder.create/list/cancel` through the portable reminder and schedule repositories (`firestore-reminders.test.ts`) | Delivery through `reminder.notify` (#368, `firestore-reminder-delivery.test.ts`) | **Ready** (allowed) |
| calendar | Ready | `calendar.*` reads, Google HTTP only (`firestore-google-calendar.test.ts`). With google installed, google registers the full calendar tool set instead. | none | **Ready** (allowed) |
| watches | Ready | `watch.create/list/cancel/web` through `persistence.watches` (`firestore-watches.test.ts`) | Portable sweep steps `reapExpiredWatches` and `pollWebWatches`; email watches observe google's sync; fires run `watch.suggest` | **Ready** (allowed) |
| search | Ready | `web.search`, metered through `persistence.costs` (#381, `firestore-lookup-tools.test.ts`) | none | **Ready** (allowed) |
| maps | Ready | `maps.directions` through `persistence.ownerContext.getLatestLocation` (#381, `firestore-lookup-tools.test.ts`) | none | **Ready** (allowed) |
| browser | Ready | `browser.plan/execute` staged through `persistence.executionJobs` | `/webhooks/browser/callback` through the execution-jobs callback command (#400, `firestore-job-callbacks.test.ts`) | **Ready** (allowed) |
| code | Ready | `code.execute` staged through `persistence.executionJobs` | `/webhooks/code/callback` through the execution-jobs callback command (#400, `firestore-job-callbacks.test.ts`) | **Ready** (allowed) |
| documents | Ready | `documents.search` through `persistence.documentSearch` (native vector search in `FIRESTORE_EMBEDDING_SPACE`, `firestore-document-search.test.ts`) | `documents.extract` Ready; `/webhooks/document/callback` through `persistence.documentProcessor`; `documents.process` Ready (`firestore-document-processing.test.ts`) | **Ready** (allowed) |
| push | Ready | none | Owner notifier through `persistence.deviceTokens` (list, invalidate on APNs 410), behind the Firestore nudge policy (`firestore-push-notifier.test.ts`) | **Ready** (allowed) |
| sms | Ready | `sms.send`, with the voice rewrite through `persistence.voiceContext` | Inbound `/webhooks/twilio/sms`, approval codes, final delivery, metering and the `channel:sms` limit, and the notifier leg through `persistence.smsChannel` and the shared cost, approval, message and task repositories (`firestore-sms-channel.test.ts`) | **Ready** (allowed) |
| google | Ready | Gmail, Docs, Sheets, Slides, Drive and Calendar HTTP tools; `gmail.send`/`gmail.create_draft` voice rewrite through `persistence.voiceContext`; `drive.ingest` through `persistence.documentCatalog`; `applications.*` through `persistence.applications` (`firestore-application-confirmations.test.ts`) | `/webhooks/gmail/pubsub`, `/internal/gmail/{sync,watch}` and the portable `email-sync` tick through `persistence.emailSync` (leased mailbox lock, `firestore-email-sync.test.ts`); attachments through `persistence.documentCatalog`; application confirmations and the portable `reapExpiredApplicationWatches` step; email thread replies and approval notices through `persistence.emailSync` (`firestore-email-channel.test.ts`); ingested mail feeds `email.extract` | **Ready** (allowed) |

Owner notifications in Firestore mode post to the dashboard (`firestoreDashboardOwnerNotifier`) and fan out to the module phone legs (push and SMS) through `persistence.nudgePolicy` (quiet hours and the ambient daily cap), exactly as PostgreSQL does. Each module leg is isolated, so a failing channel never silences the next. `owner.notify` pings through the same gate.

## Built-in tools

The Firestore composition registers `memory.save`, `memory.recall`, `task.schedule`, `goals.list`, `goals.create`, `goals.update_progress`, `mission.update`, `owner.notify`, `weather.lookup`, `sports.scores`, `web.fetch`, `workspace.read/write/list`, the record tools below, and the owner's MCP tools (`mcp.list_connections/list_tools/call`) from Firestore connection snapshots, in every environment. `firestore-full-composition.test.ts` lists every registered tool in `PORTABLE_TOOLS`; `SQL_DEPENDENT_TOOLS` is empty.

| Tool | State |
|---|---|
| `weather.lookup` | Ready and registered under Firestore in #381 |
| `sports.scores` | Ready and registered under Firestore in #381 |
| `web.fetch` | Ready and registered under Firestore in #362 |
| `workspace.read/write/list` | Ready and registered under Firestore in #362 |
| `memory.save`, `memory.recall` | Ready: portable memory tools on `persistence.memory`, embedding in the pinned space, with contradiction supersede through `persistence.memorySupersede` |
| `task.schedule` | Ready: portable task tools on `persistence.tasks` |
| `owner.notify` | Ready: owner notice plus the out-of-band phone legs |
| `memory.graph_snapshot` | Ready: graph recall repository's verified seeds, filtered by embedding space |
| `tools.read_result` | Ready: tool-execution `load`, scoped to the calling task and owner |
| `occasions.save/list` | Ready: Profile occasion writer with tool provenance (untrusted saves stay quarantined); bounded owner scan for the list |
| `occasions.list_birthdays` | Adapter implemented: bounded agent/contact-scoped reads of confirmed annual birthdays. Family recall separately requires a confirmed relationship to the exact contact identity; quarantined occasions are excluded. |
| `contacts.lookup` | Ready: bounded contact scan, name and alias prefix match |
| `conversations.search` | Ready: owned-conversation vector search in the configured space; bounded newest-first substring fallback |
| `conversations.context` | Adapter implemented: up to two revision-bound search anchors, each with at most three preceding and one following messages. Ownership, visibility, speaker/body revisions, and the erasure fence apply to anchors and neighbors. This is a bounded context window, not a complete conversation read. |
| `goals.list`, `goals.create`, `goals.update_progress`, `mission.update` | Ready (`firestore-goals-missions.test.ts`). `goals.create` also writes the work chat and automation that the PostgreSQL sweep's goal sync would create. |
| `mcp.list_connections/list_tools/call` | Ready (`firestore-mcp.test.ts`) |
| `situations.read/decisions/sources/change` | Ready: the situation pack read and command repositories the owner UI uses |

## Remaining work

Code-side, the agent has two paths left that `validateAgentPersistenceConfig` keeps Disabled:

1. Canaries. `CANARY_ENABLED` must stay false; `/internal/canaries/*` answers 501 because `canary_runs` is SQL.
2. Agent-side location pings. `LOCATION_PING_SECRET` must stay empty; `/webhooks/location` and its arrival nudge are SQL. Mobile pings go through the web instead.


The production cutover itself is an owner action, run from `docs/firestore-cutover-checklist.md`.
