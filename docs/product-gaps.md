# Assistant product gaps and completion criteria

The product brief describes a continuous personal assistant that understands the owner, manages connected information, and keeps work moving with adjustable autonomy. The repository implements much of that experience, with important differences in scope, naming, availability, and delivery. This register makes those differences explicit so future work can close them without changing the meaning of already implemented features.

Reviewed against source **October 2–3, 2026**. These are documentation findings and proposed completion criteria; the [integrated review](architecture-review-2026-10-02.md) separately records implemented repairs and their validation. Production configuration and physical-device behavior were not checked live during this pass. The [page guide](product-guide.md) and [system reference](system-reference.md) describe the current application.

## Documentation gaps filled

- Defined Open Loops and distinguished it from tasks, goals, approvals, and reminders.
- Explained the bounded conversation window, offline segmentation, durable fact learning, vector recall, GraphRAG, and compact profile as separate systems.
- Documented every current web page, corresponding native destinations, settings, details, and supporting system surfaces.
- Explained duplicate views of shared approvals and people, rather than describing separate records.
- Distinguished server/device credentials, model API credentials, and remote-tool permissions.
- Distinguished writing voice, on-device dictation/read-aloud, hands-free Talk mode, and realtime phone speech.
- Added complete static tool and direct JavaScript dependency inventories, plus the principal infrastructure, Apple frameworks, and worker technologies.
- Recorded major architectural decisions with evidence and marked interpreted rationale instead of inventing historical ADRs.
- Separated implemented source from opt-in configuration, unfinished migrations, deployment evidence, and physical-device verification.

## Differences from the brief

| Topic | Current source behavior | Gap or decision still needed | Completion criterion |
| --- | --- | --- | --- |
| A forever conversation | Stable primary thread, bounded recent context, offline summaries and optional retrieval | “Forever” must account for configured transcript retention and retrieval quality | Define the retention promise; verify retrieval on representative old conversations and expose honest misses |
| Summarize after X messages | Segmentation is offline, with time/drift/size/settling limits; current max group is 24 | No single exposed owner setting X controls the full learning pipeline | Decide whether X is an internal budget or a user preference; document latency and retention separately |
| Automatic recall | History and GraphRAG code exist; both flags default off | Implementation does not establish that a specific installation recalls automatically | Verify selected flags, index/embedding readiness, representative queries and provenance on the actual installation |
| Everything important goes into RAG | Separate message summaries, durable memories, graph projections and document chunks | No unified importance/review contract is implied by the phrase | Define promotion rules, review expectations, source coverage and quality measurements per layer |
| Everything about me stays in context | A selected compact profile is supplied only to eligible private prompts | All memory cannot be assumed present; external/tainted tasks deliberately lack it | Publish the eligible profile contract and show what was selected, with deeper retrieval for omitted facts |
| YOLO approves everything while active | Auto next resets after sending; tasks receive expiring grants with hard floors | Persistent session-wide unrestricted YOLO is not implemented | Decide the desired scope, duration, visible status and exclusions before changing permissions; verify expiry/revocation and all client labels |
| Goal work meets a deadline | Bounded automated sessions, target dates, progress/next action, blocking states | Deadline success cannot be guaranteed; progress semantics need a product contract | Show evidence-backed progress, blockage and projected next opportunity; distinguish deadline passage from outcome completion |
| Side chats summarized into the main thread | Visible work chats and cross-chat recall; optional goal mirroring goes to Notifications | Automatic bounded roll-ups into primary chat are absent | If desired, define a roll-up trigger, source links, dedupe and owner control; verify it does not narrate routine background noise |
| Important mail/events prompt me | Ingest, watches, briefing, Pulse, arrivals, suggestions and channels exist; Pulse now atomically commits its in-app notice and new proposal under current pacing/privacy checks | Exact source coverage, setup and phone delivery depend on modules/backend/preferences; a shared cross-producer attention/delivery contract remains unfinished | Exercise real meaningful changes through observation, dedupe, in-app record, decision and delivery; exercise quiet/no-news cases |
| Knowledge graph of every known place | Graph supports source-backed place/event entities; phone location is transient | Automatic movement-history ingestion is deliberately absent | Decide whether an explicit reviewed visited-place feature is wanted; do not conflate it with current-location sharing |
| Accounts | Google services, providers, server access, MCP and telecom are supported integrations | No universal financial/social/account-management product is implemented | Name each account type and its supported read/write abilities, setup, scope and revocation contract |
| Activity and Approval overlap | The same pending approval is projected in chat/Activity/Approvals | Navigation/copy can make shared state look duplicated | Keep one decision identity, consistent resolution and direct links between decision and work across both clients |
| People and graph overlap | Contact identity, facts, occasions and relationships share sources | Contacts, graph entities and trust can be mistaken for synonyms | Explain identity/alias reconciliation; validate merges, known status, sources and communication targets |
| Documents fill the graph | File passage retrieval and personal memory/graph extraction are separate | Uploaded bytes do not guarantee personal graph ingestion | Define any document-to-memory promotion/review pipeline explicitly and verify source/provenance/erasure end to end |
| Client scope | Native is the everyday assistant; the browser proxy intentionally exposes owner administration and audit | 27 retained browser product routes are dormant; their component code is not current availability | Keep the native-first/owner-console contract explicit. Reintroduce any full browser product through an intentional navigation, API and verification decision |
| Language | Timezone, locale and signature are editable | Locale does not establish complete interface translation | Define supported UI/speech/content locales and verify actual translated flows and scheduling behavior |
| Speech commands | Native dictation is editable/manual-send; hands-free Talk is a separate deliberate flow | The brief could imply every mic tap sends a command and enables speech | Set clear dictation/Talk/read-aloud labels and defaults; device-test editing, interruption, approval handling and session exit |
| Anomalies catch any weird behavior | Page primarily shows approval-policy outliers; other checks live elsewhere | A unified model/approval/runtime anomaly view is absent | Define anomaly categories and evidence; surface actionable response/recall/runtime signals without implying universal detection |
| Self improvement | Proposals, learning, bounded investigations and tested PRs exist | No automatic unrestricted live code merge/deploy | Retain exact states from report through checks, owner merge, deployed version and behavior confirmation; define any broader scope separately |
| Costs show the total | Provider billing and operation ledger are separate overlapping views | Hosting/provider estimates cannot simply be summed or treated as invoice caps | Show scope, currency, freshness and overlap; verify billing integration and explain which limits are enforceable |
| Consumer installation | Foundation/runtime/setup tools and rehearsals exist | Complete single-click fresh-account installation remains unfinished | Pass the fresh-account pilot, owner access/recovery, model probe, runtime and update/uninstall gates in the installation plan |
| Firestore | Extensive adapters and rehearsals, default PostgreSQL, incomplete integration/writer parity | Portable tests are not a production cutover | Complete current coverage, backup/restore, assets, offline-PostgreSQL rehearsal, write fencing and final activation evidence |
| Physical iPhone behavior | Native code and automated tests; existing QA notes retain open checks | Compilation alone cannot verify speech quality, gestures or background delivery | Run current-device checks for audio routes, echo/interruption, touch editing, open/close states, permissions, push and Live Activities |

## Engineering and documentation follow-through

### Establish the current installation contract

The first operational follow-through should record the actual enabled modules, backend, auth mode, recall flags, schedules, provider availability, client version, and notification preferences. This can be done without including secrets. Current source defaults and historical deployment notes are not substitutes for that snapshot.

The same record should distinguish a configured integration, a passing connection probe, an enabled tool, and a verified real workflow. For example, a valid Calendar token establishes access; a correctly grounded tomorrow query establishes date/time handling; a successful approved write establishes execution. These are different acceptance checks.

### Resolve product meanings before broader implementation

The most material unresolved meanings are persistent YOLO versus bounded task autonomy, side-chat roll-ups, “accounts,” document-to-graph promotion, language coverage, and any future expansion beyond the current web owner-console role. The current guide gives each term a defensible implemented meaning. Broader behavior should have explicit scope and acceptance criteria before changing security, storage, or navigation.

Other overlaps can be resolved through explanation and shared-state consistency rather than adding another subsystem. Open Loops does not need a second scheduler; People does not need a separate graph; Approvals does not need duplicate records in Activity; Cards and Situation Packs do not need their own real-world execution engine.

### Complete delivery gates independently

Firestore and customer installation have dedicated plans and acceptance gates. Their status should remain in those references so this product guide does not accidentally turn historical progress into a current completion claim. After a verified cutover, update the default/deployed distinction and retain the rehearsal records as dated evidence.

Native shipping is independent of a server deploy. Features requiring new views, speech behavior, or notification handling need a distributed app build and device verification. A healthy server SHA does not establish which native build the owner has installed.

### Reconcile aging feature notes

Some detailed design documents contain implemented amendments above older planned sections. Readers should use the actual mounted route/component and current code for the present interface. For example, the current web knowledge map has starting points, focused/whole-map navigation, and Map/List views; older notes describe an earlier Explorer/Paths/Details arrangement. The current root opens Settings and the proxy blocks everyday browser product pages; older retained chat/page notes are implementation references rather than current browser availability.

Follow-up documentation work should rewrite those historical design sections around their final behavior while preserving meaningful past decisions. This pass adds current entry documents and cross-links instead of deleting historical rollout evidence.

### Review runtime dependency provenance

The agent image installs external runtime dependencies separately from workspace declarations. The reviewed Dockerfile pins `unpdf@1.6.2` and `@google-cloud/firestore@9.0.1`, while workspace manifests declare newer versions. This is a concrete packaging difference, not proof of a defect. Verify compatibility and release provenance when updating these dependencies, and keep documentation explicit about declared versus shipped versions.

The local code runner is credential-minimized but shares the agent filesystem/network and is **not an isolation sandbox**. Stronger worker isolation belongs to the selected runtime/deployment. Capability copy and readiness diagnostics should retain that distinction.

## Proposed acceptance examples

These scenarios connect product language to observable state:

1. **Continuity:** discuss a preference, let it leave the recent window, then ask about it in a later conversation. Verify retrieval source, correct meaning, bounded context, and an honest no-match case.
2. **Correction and forgetting:** correct a current fact, verify the old fact leaves the compact profile and active graph, then forget it and verify repeated processing does not restore the same hashed content.
3. **Follow-through:** capture a promise and a waiting-on loop, resolve one, snooze another, and verify retirement never claims completion.
4. **Calendar/mail:** observe a meaningful source change, show one grounded notice/suggestion, accept it, and verify a resulting outward action still enters its approval path.
5. **Autonomy:** turn on Auto next, send work, verify the control resets and the grant is task-scoped; exercise a permitted routine call, a hard-floor call, expiry and revocation.
6. **Durability:** interrupt an executor and redeliver work. Verify stale leases cannot checkpoint, effects are reconciled, unknown provider results are not blindly repeated, and the client reflects server state.
7. **Speech:** dictate and edit before sending; enter Talk deliberately; interrupt playback; receive an approval without spoken auto-approval; test a physical device with speaker/headphones and permission changes.
8. **Planning:** link a saved card and commitment in a pack, change a source, rehearse a correction, reject a stale preview, and apply a valid preview without changing the external booking.
9. **Spend:** reserve and settle one model/job operation, compare provider billing with the ledger, and verify that unavailable/delayed billing does not appear as zero.
10. **Repair:** report a reproducible issue, inspect the bounded diagnosis/test/PR, confirm exact-commit checks, merge/release through the owner process, and confirm behavior before closing the report.

Sources: [chat and recall](long-running-chat-memory.md), [autonomy policy](../packages/core/src/workflow/autonomy.ts), [goal mirror test](../packages/core/src/mission-mirror.test.ts), [native send reset](../apps/ios/Assistant/AppModel.swift), [mounted web Settings](../apps/web/app/settings/page.tsx), [mounted map](../apps/web/app/profile/knowledge/knowledge-map.tsx), [Situation Packs](situation-packs.md), [self repair](self-repair.md), [costs](cost-tracking.md), [Firestore status](firestore-implementation-status.md), [consumer pilot](consumer-fresh-account-pilot.md), [native QA](../apps/ios/docs/visual-qa.md).
