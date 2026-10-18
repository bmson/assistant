# Firestore web and mobile route inventory

> Historical source inventory, last updated 2026-09-26. Route totals and classifications below are retained as a dated snapshot, not a current route-drift check or production receipt. Reconcile against `apps/web/app` and the proxy before relying on an individual row. See the [runtime support matrix](runtime-support-matrix.md) and [cutover checklist](firestore-cutover-checklist.md).

Reflects `apps/web` on the `claude/firestore-final-docs` branch (2026-09-26), which contains every port. It answers one question for every page, route handler, and Server Action: with `PERSISTENCE_DRIVER=firestore` and no `DATABASE_URL`, does it work without SQL? Production still runs on PostgreSQL; nothing here changes that composition.

How the Firestore composition is gated:

- `apps/web/proxy.ts` is an allowlist. Any path/method it does not list returns `503 {"code":"unavailable"}` in Firestore mode, before authentication or the handler runs.
- `getDb()` in `apps/web/lib/server.ts` throws `PostgreSQL-backed web surface is unavailable in Firestore mode`, and `getApplication()` builds the PostgreSQL application through `getDb()`. Anything reaching them in Firestore mode fails with a 500.
- Handlers branch on `PERSISTENCE_DRIVER === 'firestore'` themselves, or go through a driver-aware accessor in `lib/server.ts` (`getChatApplication()`, `getOwnerMemoryCommands()`, `getImportCommands()`, `checkWebReadiness()`, `downloadOwnerArtifact()`, `recordOwnerLocation()`, `registerOwnerDeviceToken()`, `organizeOwnerMemoryNow()`), `lib/workspace-reviews.ts`, `lib/task-activity.ts`, or `lib/firestore-*.ts`.

Classification:

| Class | Meaning |
|---|---|
| **Ready** | Proxy passes it and every action it offers has a Firestore path. |
| **Degraded** | Proxy passes it and it has a Firestore path, but some actions are refused, hidden, or the page renders read-only. |
| **Gated** | Proxy blocks it, but the handler itself needs no SQL (unblocking is enough). |
| **SQL** | The Firestore composition would reach PostgreSQL; a portable port is required. |

## Summary

| Surface | Total | Ready | Degraded | Gated | SQL |
|---|---:|---:|---:|---:|---:|
| Mobile API handlers (`/api/mobile/v1`, per method) | 82 | 82 | 0 | 0 | 0 |
| Web API handlers (`/api`, per method) | 26 | 26 | 0 | 0 | 0 |
| Pages (30 `page.tsx`) | 30 | 30 | 0 | 0 | 0 |
| Server Action modules (17) | 17 | 17 | 0 | 0 | 0 |

Nothing is Degraded, Gated, or SQL. No web route reaches SQL in Firestore mode.

## Mobile API (`/api/mobile/v1`)

Ready (82 handlers): `activity` GET/POST, `activity/[id]` POST, `activity/foreground` POST, `anomalies/[id]` POST, `approvals/[id]` POST, `bootstrap` GET, `cards` GET, `cards/[id]` POST, `chat` POST, `chat/status` GET, `chats` POST, `chats/[id]` GET/POST, `chats/[id]/messages/[messageId]` POST, `costs` PATCH, `devices` POST, `documents` GET/POST, `documents/[id]` GET/DELETE, `goals` GET/POST, `goals/[id]` GET/PATCH/POST, `imports` POST, `improvements/[id]` POST, `knowledge` GET/POST, `knowledge/[id]` GET/PATCH, `knowledge/cleanup` GET/POST, `knowledge/graph` GET, `knowledge/relations/[id]` GET/POST/DELETE, `knowledge/sources/[id]` GET/PATCH/DELETE, `knowledge/workspace` GET, `live/scoreboard` GET, `location` POST, `mcp` GET/POST, `mcp/[id]` POST/DELETE, `memory` POST, `memory/[id]` PATCH/POST, `memory/commitments` GET/POST, `memory/export` GET, `memory/library` GET, `memory/occasions/[id]` POST/PATCH/DELETE, `memory/people` POST, `memory/people/[id]` GET/PATCH/POST/DELETE, `memory/people/[id]/occasions` POST, `memory/profile` GET/POST, `overview` GET, `packs` GET/POST, `people` GET, `people/[id]` GET, `settings` PATCH, `settings/policies/[id]` POST/DELETE, `settings/reminders/[id]` DELETE, `settings/schedules/[id]` POST, `skills` POST, `skills/[id]` PATCH/POST/DELETE, `suggestions/[id]` POST, `workspace` GET.

Handlers that were SQL, Gated, or Degraded in the 2026-09-23 snapshot, and what serves them now:

| Handler | Firestore path |
|---|---|
| `devices` POST | `registerOwnerDeviceToken` → `registerDeviceTokenWithRepository` on the Firestore device tokens |
| `location` POST | `recordOwnerLocation` → `recordOwnerLocationPingWithRepository` (ping plus arrival hook on `persistence.tasks`) |
| `memory` POST, `memory/[id]` PATCH/POST | `getOwnerMemoryCommands()`: create, correct, confirm, approve, reject, forget, prominence |
| `memory/people/[id]` POST, DELETE | `mergeFirestorePeople`, `deleteFirestorePerson` (`lib/firestore-profile-commands.ts`) |
| `memory/profile` POST | Every action, including `purge-voice` through `FirestoreVoiceSamplePurgeRepository` |
| `improvements/[id]` POST | `FirestoreWorkspaceImprovementRepository.applyAction`; applying a `model_role` proposal swaps the role to enabled models in the same transaction, as PostgreSQL does |
| `documents` POST, `documents/[id]` DELETE | `FirestoreDocumentCatalogRepository` and `FirestoreDocumentDeletionRepository` |
| `live/scoreboard` GET | Now admitted by the proxy; reads only the agent timezone |

`activity` POST and `activity/[id]` POST return 503 in Firestore mode only for an action name outside the supported set; PostgreSQL rejects the same input with 400.

## Web API (`/api`)

| Handler | Class | Notes |
|---|---|---|
| `auth/[...nextauth]` GET, POST | Ready | Returns 404 in passkey mode. |
| `owner/claim` POST, `owner/login` POST, `owner/logout` POST, `owner/recovery` POST, `owner/recovery-code` POST, `owner/status` GET, `owner/devices` GET/POST/DELETE, `owner/passkeys` GET/POST/DELETE | Ready | Passkey owner auth on `FirestoreOwnerAuthRepository`; each returns 404 unless `OWNER_AUTH_MODE=passkey`. |
| `card-image` GET | Ready | No persistence. |
| `chat` POST, `chat/status` GET | Ready | `getChatApplication()` |
| `health` GET | Ready | |
| `ready` GET | Ready | `checkWebReadiness()` probes for exactly one configured owner; no SQL connection. |
| `files` GET | Ready | `downloadOwnerArtifact()` gates on `FirestoreWorkspaceFileLookup`. |
| `profile-export` GET | Ready | `FirestorePrivacyExportRepository` |
| `shell/status` GET | Ready | |
| `live/scoreboard` GET | Ready | Same as the mobile route. |
| `maps/snapshot` GET | Ready | No persistence at all. |
| `documents/upload` POST | Ready | `uploadDocument` with the Firestore document stores. |
| `import/upload` POST | Ready | `getImportCommands()`; bytes go to the workspace store, records to Firestore. A voice upload returns to `/profile/voice`. |

## Pages

| Page | Class | Notes |
|---|---|---|
| `/` | Ready | Redirect. |
| `/setup`, `/signin`, `/security` | Ready | Passkey owner onboarding and sign-in; 404 outside passkey mode. |
| `/approvals` | Ready | `getApprovalStore()` |
| `/capabilities` | Ready | |
| `/cards` | Ready | |
| `/chat`, `/chat/all` | Ready | |
| `/chat/[id]` | Ready | `getChatApplication().getChatConversation`; the `firestorePreview` variant is gone, and its inline actions post to the portable Server Actions below. |
| `/costs` | Ready | |
| `/goals` | Ready | |
| `/packs` | Ready | |
| `/skills` | Ready | |
| `/tasks` | Ready | Archive/restore/archive-old actions are portable. |
| `/tasks/[id]` | Ready | `getTaskActivityDetail`; retry, revoke autonomy, raise budget and cancel run through `FirestoreTaskActivityCommandRepository` (`lib/task-activity.ts`). |
| `/settings` | Ready | Pairing and token rotation (no SQL), the Noticing panel (`FirestoreProactiveHealthRepository` counts) and the Spending link render in Firestore mode. MCP connections are editable, inspectable and executable. |
| `/import` | Ready | Upload, start, purge, delete and review run through `getImportCommands()`. |
| `/documents` | Ready | `getFirestoreDocumentsOverview()`; delete through `FirestoreDocumentDeletionRepository`. |
| `/anomalies` | Ready | `listOpenAnomalies()` on `FirestoreWorkspaceAnomalyRepository`. |
| `/improvements` | Ready | `listOpenImprovements()` on `FirestoreWorkspaceImprovementRepository`. |
| `/profile` | Ready | Memory hub on `FirestoreProfileMemoryHubRepository`, commitments on `getFirestoreCommitmentOverview`; organize through `organizeOwnerMemoryNow()`. |
| `/profile/memories` | Ready | Firestore-only read hub (PostgreSQL redirects it to `/profile/knowledge`). |
| `/profile/about` | Ready | Owner facts on `FirestoreProfilePeopleReadRepository`; confirm, correct, forget, add and card refresh go through `profile/actions.ts`. |
| `/profile/data` | Ready | Firestore privacy export and erasure. |
| `/profile/knowledge` | Ready | One bounded Firestore snapshot serves the header, library, map, entity focus, and cleanup views. |
| `/profile/people/[id]` | Ready | Pure redirect to `/people/[id]`; now admitted by the proxy. |
| `/profile/voice` | Ready | Profile edit, sample upload and the sample purge (`FirestoreVoiceSamplePurgeRepository`). |
| `/people` | Ready | `listFirestorePeopleDirectory` (`lib/firestore-people.ts`) feeds the same directory as PostgreSQL: upcoming birthdays, locations, last contact, search, and add person through `profile/actions.ts`. The proxy admits GET and the Server Action POST. |
| `/people/[id]` | Ready | `getFirestorePersonDossier` (`lib/firestore-people.ts`) builds the SQL dossier shape from `FirestoreProfilePeopleReadRepository`, `getFirestorePersonTemporalDetails` and `getFirestorePersonGraph`, so the page renders the same edit, occasion, relation, fact, merge and delete controls; they post to `profile/actions.ts` and `profile/knowledge/actions.ts`. The proxy admits GET and the Server Action POST for UUID paths. |

## Server Actions

| Module | Class | Notes |
|---|---|---|
| `app/actions.ts` | Ready | Sign-out only. |
| `anomalies/actions.ts` | Ready | Dismiss and suspend policy through `lib/workspace-reviews.ts`. |
| `approvals/actions.ts` | Ready | |
| `cards/actions.ts` | Ready | |
| `chat/actions.ts` | Ready | Every action, including `recordRecallFeedbackAction`, goes through `getChatApplication()`. |
| `costs/actions.ts` | Ready | |
| `documents/actions.ts` | Ready | Delete through `FirestoreDocumentDeletionRepository`. |
| `goals/actions.ts` | Ready | |
| `import/actions.ts` | Ready | Start, purge, delete and review through `getImportCommands()`. |
| `improvements/actions.ts` | Ready | Apply (including `model_role`) and dismiss through `lib/workspace-reviews.ts`. |
| `packs/actions.ts` | Ready | |
| `profile/actions.ts` | Ready | Commitments and memory commands through `getOwnerMemoryCommands()`; organize through `organizeOwnerMemoryNow()`; people create, edit, merge and delete, occasions, voice profile, voice purge, card recompile and forget-all (`forgetOwnerLongTermMemory`) have Firestore branches. |
| `profile/knowledge/actions.ts` | Ready | Graph curation (rename, retype, merge, orphan removal, source retry and re-extraction) uses `FirestoreKnowledgeGraphCurationRepository`. |
| `settings/actions.ts` | Ready | Identity, notifications, schedules, policies and MCP connections have Firestore branches. `rotateMobileToken` writes `.env` or Secret Manager and touches no database. |
| `skills/actions.ts` | Ready | |
| `suggestions/actions.ts` | Ready | |
| `tasks/actions.ts` | Ready | All task commands through `lib/task-activity.ts`. |

## Structural gap

`apps/web/lib/server.ts` statically imports `createDb` and the PostgreSQL card repositories from `@assistant/db`, and `@assistant/application`'s barrel re-exports SQL use cases. The Firestore composition therefore still loads the Drizzle/`postgres` modules even when no SQL call runs. Removing that reachability needs the PostgreSQL facade moved behind a lazily imported module and Firestore-only entry points for the application barrel; it is tracked here rather than attempted per domain.

## Remaining

No route reaches SQL in Firestore mode. What is left on the web side is the structural gap above.

The production cutover is an owner action, run from `docs/firestore-cutover-checklist.md`.
