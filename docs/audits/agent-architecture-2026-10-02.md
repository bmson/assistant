# Agent architecture and behavior review

Reviewed on October 2, 2026, with a transactional pulse-admission follow-up on October 3. This is a source-backed engineering review of the agent, core policies, conversation recall, proactive behavior, and improvement loop. It is not a production health report, a live provider benchmark, or a claim of competitive superiority. Page and native interaction reviews are separate companion work.

## Product standard

The assistant should feel like a capable person who understands the owner's circumstances, remembers accurately, follows through, and asks only when the answer matters. The engineering version of that ambition is observable:

- One continuing relationship across chats, without treating every historical remark as a current instruction.
- Work progresses when the owner closes the app. The owner can see its evidence, next step, blockage, and outcome.
- A successful task is a verified outcome, not an eloquent final sentence or a sequence of bookkeeping calls.
- Proactivity notices a meaningful change, names its consequence, and offers one useful next step. Silence is a normal successful result.
- User corrections take precedence over old summaries. Uncertainty, unverified claims, hypotheses, and forgotten facts have distinct treatment.
- An approval is a specific decision. It is not a repeated conversation, and resolving it updates every representation of the same decision.
- Self-improvement demonstrates better behavior under independent checks before changing production behavior.

This standard argues for strengthening the current modular system, rather than multiplying agents, adding a second vector store, or rewriting the durable execution loop. More independent producers and more model calls can increase noise, latency, and failure modes without improving the relationship.

## Existing architecture worth preserving

| Responsibility | Current implementation | Why it matters |
| --- | --- | --- |
| Durable work | Task leases, generations, checkpoints, parked states, queue outbox | A process restart and a repeated queue delivery do not imply repeated effects |
| External effects | Tool registry, argument-specific approval policy, trust/taint, provider-result ledger | Models propose; policy and evidence establish authority and outcomes |
| Private context | Compact owner context, bounded conversation recall, optional graph recall | The owner can have long history without sending all history to every model |
| Memory provenance | Quarantine, temporal validity, confirmation, supersession, tombstones | Remembering accurately requires correcting and forgetting, not only storing |
| Grounded replies | Deterministic response contract plus bounded model review | A verifier outage must not remove the deterministic evidence boundary |
| Proactivity | Deterministic pulse, watches, briefing, arrival nudges, curiosity, nudge policy | Important information can surface without granting a proactive job outward-action tools |
| Long-running goals | Bounded sessions, durable progress, next actions, goal evidence checks | Continuation can be independent of the current client session |
| Improvement | Reliability proposals, skill outcomes, quarantined dream hypotheses, bounded repair workflow | Advice, learning, code changes, deployment, and verified recovery remain separate stages |
| Storage portability | SDK-independent repository contracts with selected PostgreSQL/Firestore composition | A storage migration should change persistence, not the meaning of approvals or outcomes |

Evidence: [task machine](../../packages/core/src/workflow/machine.ts), [queue outbox dispatch](../../packages/core/src/workflow/dispatch.ts), [response contract](../../packages/core/src/workflow/response-contract.ts), [goal evidence](../../packages/core/src/workflow/goal-evidence.ts), [memory recall](../../packages/core/src/memory/recall.ts), [GraphRAG](../../packages/core/src/memory/graph-recall.ts), [executor notices](../../packages/core/src/workflow/executor/notices.ts), [self-improvement](../../packages/core/src/workflow/improve.ts), and [repair contract](../self-repair.md).

There are still concrete SQL queries in core and application compatibility paths. The appropriate migration unit is one use case and its behavioral contract, with both adapters passing the same tests. Moving all query code into interfaces in one pass would add churn without proving correct ownership, bounded reads, or transaction behavior.

## Improvements implemented in this review

### Enforce the actual conversation-context budget

The historical recall and graph recall code documented a hard character budget, but counted only entries. The trust/provenance header and separators were omitted, and the first entry always bypassed the limit. A long graph entity label or a caller's small budget could therefore exceed the advertised bound. The message tier also repeated previously injected lines when two neighborhoods overlapped only partly.

Both recall paths now use one complete-block budget primitive. It counts the header, separators, and every evidence entry. An entry that does not fit is skipped intact, and later smaller matches remain eligible. The total-budget guard does not cut through a rendered relationship or quotation; existing per-field excerpts retain their ellipsis. Source affordances and `used` counts include only injected entries. A budget too small to hold evidence avoids the embedding/read work entirely. Message neighborhoods include only previously unseen message IDs.

This preserves the existing trust gates, similarity threshold, embedding-sharing behavior, graph depth, and fallback behavior. It does not enable recall flags or increase memory capture. Character bounds are a useful conservative guard; they are not an exact model-specific token count. The entire composed prompt still needs a token budget that covers owner profile, history, tool definitions, situation context, and requested output.

Changed: [recall-budget.ts](../../packages/core/src/memory/recall-budget.ts), [recall.ts](../../packages/core/src/memory/recall.ts), [graph-recall.ts](../../packages/core/src/memory/graph-recall.ts). Regression evidence: [recall-budget.test.ts](../../packages/core/src/memory/recall-budget.test.ts).

### Keep one slow recurring module run in flight

The local queue already limited concurrent tasks and isolated its maintenance sweep. Recurring module ticks had no equivalent guard. A provider read that outlasted its cadence started another run, then another, consuming provider/database capacity while owner work continued arriving.

The poller now permits one in-flight run for each registered recurring tick. Independent ticks, owner tasks, and maintenance continue normally. Completion, rejected promises, and synchronous exceptions release the guard so the next cadence can recover. This is process-local backpressure, not a cross-instance lease. Provider deadlines and distributed source-sync coordination remain separate requirements.

Changed: [poller.ts](../../apps/agent/src/poller.ts). Regression evidence: [poller.test.ts](../../apps/agent/src/poller.test.ts), including a slow provider, independent quick provider, owner task execution, and failure recovery.

### Prevent old proactive notices from starving new ones

Pulse selected the strongest candidate before checking its unique historical claim. Important mail remains eligible for hours, and an open commitment remains eligible until its deadline. When an already-mentioned item ranked first, pulse stopped at `already-said` and ignored every fresh lower-ranked item. One unchanged email could repeatedly hide another useful observation.

Pulse now walks its deterministic ranking until it admits an unsaid candidate. Historical duplicates are skipped; a fresh concurrent winner causes the losing run to stand down under transactional pacing. Existing one-per-run, hourly gap, daily ceiling, suggestion approval path, and phone nudge policy remain in place.

The October 3 follow-up makes pulse's owner admission atomic across different candidates as well as identical ones. Other proactive producers still have independent in-app admission; the attention arbiter proposed below addresses coordination across those producers.

Changed: [pulse.ts](../../packages/core/src/proactive/pulse.ts). Regression evidence: [pulse-selection.test.ts](../../packages/core/src/proactive/pulse-selection.test.ts). The Firestore pulse regression expectation now requires the new commitment to surface even while previously announced mail remains eligible: [firestore-pulse.test.ts](../../apps/agent/src/firestore-pulse.test.ts).

### Preserve calendar changes that have not been announced

Pulse previously updated all calendar snapshots immediately after comparing a successful read. It then announced only one ranked moment. Every other cancellation, move, or accepted-to-declined transition in that read disappeared from the next comparison despite never being shown to the owner.

Ordinary/new observations still advance the snapshot. Changed events retain their prior baseline until their selected notice is persisted. Unselected disappeared events are retained in the update set so the stale-row purge does not erase their pending comparison. After persisting the selected notice, pulse advances only acknowledged changes. Two cancellations can now be announced on separate paced runs. A notice-storage failure leaves the calendar baseline unchanged. An explicit provider cancellation remains valid evidence even when unrelated events were truncated; disappearance alone still requires a complete read.

This is a bounded correction using the existing snapshot and moment repositories. It is not an outbox or a durable history of every intermediate calendar edit. Event changes that revert before admission may no longer be relevant. The subsequent transactional admission change closes the claim-before-message crash window for newly admitted notices. Snapshot advancement follows committed admission; a failed snapshot update can be retried without posting a second notice.

Changed: [pulse.ts](../../packages/core/src/proactive/pulse.ts), [calendar-diff.ts](../../packages/core/src/proactive/calendar-diff.ts). Regression evidence: [pulse-selection.test.ts](../../packages/core/src/proactive/pulse-selection.test.ts), [calendar-diff.test.ts](../../packages/core/src/proactive/calendar-diff.test.ts).

### Commit the proactive notice as one durable admission

The former `claimMoment` operation inserted a delivered ledger row before the suggestion or owner message was committed. A process failure or message-storage error in between permanently suppressed a notice the owner never saw. The separate pacing read also let different candidates race for the same owner's remaining gap/cap slot.

The shared pulse port now accepts one observation, its inert proposal, a privacy observation fence, and explicit pacing bounds. PostgreSQL and Firestore serialize admission for the owner and recheck current preferences. Admission checks historical duplication first, then the rolling cap, then the minimum gap. This deterministic precedence lets a concurrent loser at the final daily slot report the exhausted cap. Early reads in core remain a cost-saving optimization; they are not the authoritative admission decision.

An accepted admission commits the moment ledger, owner-visible message, any newly created suggestion, and conversation activity together. The fallback Notifications chat and its uniqueness marker also participate in that transaction. A throw commits none of these. A replay after an unknown successful commit finds the existing moment and does not create a second message. Suggestion creation remains an offer, never tool execution or approval.

Firestore reads and writes a per-owner `coordination/pulse-admission:{agentId}` record so two different absent moment keys contend. All destination, privacy, proposal, identity, preference and pacing reads finish before writes begin. Pacing queries are bounded at the gap existence check and at the cap (at most six); imported random-ID moments participate in the same counts and key checks. New notices use stable message identities; imported moments and dismissed/accepted proposals remain untouched. A legacy ledger-only claim with unknown notice history stays inert rather than being reconstructed into a potentially repeated notice.

The privacy fence is captured before candidate source reads and verified inside admission. Both adapters retain erasure generations after completion, so a worker cannot write stale observed content after an erase started and finished. Existing active/malformed fences remain closed. Firestore reuses its permanent `privacyErasureJobs.generation`; the PostgreSQL follow-up retains its generation marker without a schema migration.

This guarantee covers the durable owner message. Phone sending remains after commit and best-effort. The task-generation queue outbox is unchanged; it is not a push delivery outbox. Other producers and actual phone-delivery outcomes still need the separate coordination work below.

Changed: [pulse port](../../packages/persistence/src/pulse.ts), [PostgreSQL admission](../../packages/db/src/pulse-admission-repository.ts), [Firestore pulse](../../packages/firestore/src/pulse.ts), [Firestore notice transaction seam](../../packages/firestore/src/owner-notices.ts). Regression evidence: [Firestore admission](../../packages/firestore/src/pulse.test.ts), [portable pulse job](../../apps/agent/src/firestore-pulse.test.ts), and [core selection](../../packages/core/src/proactive/pulse-selection.test.ts).

## Architectural decisions and next increments

### October 3 continuation: suggestion state and conversation ownership

Suggestion hydration already supplies `snoozedUntil` from the authoritative row. It also resolves an elapsed snooze to pending and an elapsed proposal deadline to expired. The mobile decision endpoint returns the committed snooze deadline, including an idempotent retry. Native `MessagePart` previously discarded that hydrated field, and its local answer overlay changed only the status. The visible receipt therefore promised to return later without saying when.

Native now preserves the optional wire timestamp and uses a shared Foundation presentation value for settled status, task progress, and scheduling copy. A snoozed receipt shows its absolute return date and time while collapsed, using the device's locale/timezone; VoiceOver reads state, subject, and return time together. Fractional-second, whole-second, and offset internet timestamps are accepted. Missing/malformed legacy timestamps say “Return time unavailable”; they do not create a fictional date. No date formatter is allocated per row.

| State | Native treatment | Authority preserved |
| --- | --- | --- |
| Pending | One proposed next step with its explicitly paired source, action label, Later, and No thanks | A suggestion is an offer, separate from an approval |
| Answer in flight | Controls are disabled; inline progress/error remains at the question | No success receipt before server acknowledgement |
| Snoozed | Quiet receipt with visible local return time, or honest unavailable-time copy | Server hydration determines when the question reopens |
| Accepted | Actual task progress: queued, working, waiting, needs attention, completed, cancelled, or failed | Acceptance creates work under existing action permissions; it does not prove completion |
| Dismissed/expired/missing | Quiet non-actionable receipt retaining the original subject/details | Passing on an offer is not an error; removed work cannot be revived by a device shadow |

Known-deadline local snoozes cover older pending reads only until the acknowledged deadline. An unknown-deadline legacy snooze can settle the immediate acknowledgement, but later server reads prevail; otherwise it could remain locally snoozed forever. A conflicting terminal server status wins over every local answer. The server's accepted task identity and progress remain intact, even if a device retained an older task ID. These changes do not infer source pairing, rewrite the proposed action, add approval scope, or change suggestion expiry.

The same review found late native conversation mutations publishing into newer UI state. Hiding a message could restore its old text or offer undo after the owner changed chats. Model selection could finish either of its network phases and reopen the previous conversation. A delayed create could use the current client to open a chat created under an older connection. These paths now check the captured connection generation, configuration, owner, and relevant conversation/navigation scope before publishing. Hide still rolls back a failed local removal in its original current context, including cancellation. Chat creation and model changes stand down before network work while a reply or its cleanup is active. Manual opening, creation, and model refresh also recheck active/settling state after network waits: a reply started during an older request keeps its conversation and stream, and the older success/failure remains quiet. The approval-failure surface task also checks its captured session before starting. A refreshed authenticated bootstrap whose owner changed now advances the connection generation and clears the old draft session/shared caches even when the URL, credential and conversation ID match. Delayed projections from the prior generation cannot repopulate those caches. Repeating the same replacement identity does not reset the new session again.

Evidence: [hydration](../../packages/application/src/chat.ts), [suggestion use cases](../../packages/application/src/suggestions.ts), [mobile decision route](../../apps/web/app/api/mobile/v1/suggestions/[id]/route.ts), [native model](../../apps/ios/Assistant/Models/APIModels.swift), [shared suggestion card](../../apps/ios/Assistant/Components/MessageBubble.swift), and [native coordinator](../../apps/ios/Assistant/AppModel.swift). Focused regressions are in [APIModelsTests](../../apps/ios/AssistantTests/APIModelsTests.swift) and the conversation-mutation extension of [APIClientRetryTests](../../apps/ios/AssistantTests/APIClientRetryTests.swift).

The guarantees are state and ownership guarantees. A reopened old suggestion card is not evidence that a new reminder or push was sent. Real VoiceOver focus, Dynamic Type layout, long-transcript frame costs, dictation interruption, offline return-time behavior, and actual device interactions remain separate runtime checks. See the companion native audit for those boundaries.

### One attention arbiter, many observation sources

The notification policy currently brings ambient producers together at the phone leg through quiet hours and an atomic daily cap. Their in-app messages, proposals, ranking, expiry, and pacing remain independent. Briefing, pulse, watches, arrivals, and curiosity can each be reasonable alone while collectively overwhelming the same owner.

Use one durable candidate contract upstream of both in-app presentation and out-of-band delivery:

| Candidate field | Meaning |
| --- | --- |
| Owner and source identity | Scope and stable deduplication key |
| Source version and observed time | Which actual change earned attention; avoids “a cancelled event” becoming an eternal key |
| Evidence references and freshness | Why this is true now; when revalidation is needed |
| Consequence and useful-until | What the owner loses by learning late, and when the notice expires |
| Decision/next action | One specific choice or action, using ordinary approval policy when accepted |
| Group identity | A trip, person, goal, booking, or thread through which related changes can be combined |
| Interaction state | Presented, read, accepted, dismissed, snoozed, resolved; these are different outcomes |
| Delivery state | Claimed, message committed, channel queued, channel result, retry state |

The arbiter should choose the next useful interruption from current evidence and user availability. It should combine related observations, suppress duplicates across producers, retain unpresented candidates until expiry, and record a concise suppression reason. An atomic admission operation must reserve the pace slot and commit the owner-visible notice together. Phone delivery should follow through its own retryable outbox.

Do not add a model call merely to decide whether every low-value candidate exists. Deterministic producers should continue to identify grounded candidates. A model can help write a combined explanation or rank genuinely ambiguous consequences within explicit bounds; durable code still owns admission, expiry, privacy, and authorization.

Suggested delivery modes are “quietly available,” “ask at the next natural interaction,” and “interrupt now.” Time-critical consequences deserve a separate declared policy rather than an arbitrary priority number alone. An approval can be high priority because work cannot continue, but a routine approval should not implicitly mean “buzz repeatedly through quiet hours.” Any such policy change should be visible in notification settings and tested with owner preferences.

Acceptance examples:

1. Two producers discover the same changed flight: one current notice, one decision identity, no duplicate phone buzz.
2. Three related trip changes arrive: one combined explanation with source links and individual action targets.
3. A pace slot is unavailable: a still-useful candidate remains pending; an expired candidate retires without pretending it was read.
4. The process crashes after admission: the notice survives and phone delivery resumes without creating a second message.
5. A quiet-hours suppression remains inspectable and available in-app.
6. Concurrent different candidates cannot exceed the owner's declared pace/cap.

### A layered memory system, not one undifferentiated graph

Conversation continuity should use four clear layers:

1. Current dialogue: bounded, recent, task-relevant conversation.
2. Owner context: small, current, confirmed preferences and identity information.
3. Recall: source-labelled historical discussion, knowledge relationships, documents, and prior outcomes selected for the current request.
4. Active obligations: open loops, goals, deadlines, pending decisions, and waiting-on items with explicit state.

These layers answer different questions. A transcript summary is evidence of what was discussed; it is not necessarily a current preference. A graph edge is a source-backed relationship; it is not proof of an unstated inference. An open loop is an unresolved obligation; it is not merely text similar to the current question. Documents have passage retrieval and do not automatically become trusted owner facts.

Keep offline segmentation, extraction, consolidation, and graph construction off the ordinary turn's latency path. Preserve confirmation, quarantine, correction, temporal validity, and erasure tombstones. The current automatic history/graph recall flags default off; installations must verify which layers are active before promising indefinite continuity.

Next structural work should give context assembly one budget owner, one deadline, and an inspectable selection manifest. Each block should declare its trust, source IDs, freshness, characters/tokens, and reason for inclusion. Optional recall failures should preserve the answer path, and stale evidence must never silently become authority for an outward action. Privacy-preserving metrics should count selection/quality outcomes without copying recalled personal content into analytics.

Proposed acceptance: discuss a preference, let it leave the live window, recover it accurately with a source; correct it and exclude the old active fact; forget it and resist repeated ingestion; request a new topic and retrieve nothing; execute an untrusted task and inject no private recall.

Evidence: [segmentation](../../packages/core/src/memory/segmentation.ts), [recall](../../packages/core/src/memory/recall.ts), [graph recall and fallback](../../packages/core/src/memory/graph-recall.ts), [chat turn context assembly](../../packages/application/src/chat-turn.ts), and [privacy use cases](../../packages/application/src/profile/privacy.ts).

### Outcome-driven goals and a quieter main stream

The continuing conversation should be the relationship surface. Side work can have its own thread and technical history, but only meaningful outcomes, a material change, a useful question, or a blockage should return to the main stream.

Goal progress should distinguish completed evidence from narrated intent. Current goal evidence correctly excludes some bookkeeping tools and checks failed/unknown provider results. The remaining generic “any successful non-bookkeeping tool” rule is a weak proxy for outcome progress. A calendar read can be valuable research, yet it does not establish that a meeting was arranged.

Introduce explicit acceptance criteria for goals, evidence requirements for each criterion, and a stable next action. A checkpoint should say what was learned or completed, what remains, and when the next opportunity occurs. Estimated completion percentage should be labelled as an estimate and should not hide a blocker or a passed deadline. Cross-chat roll-ups should cite their source work and deduplicate by outcome revision.

Acceptance: repeated progress/status writes cannot advance a goal; a verified deliverable satisfies its criterion; unresolved approval/provider uncertainty remains visible; a completed side task posts one useful linked outcome; routine retries and operational notices stay in Activity.

Evidence: [goal evidence](../../packages/core/src/workflow/goal-evidence.ts), [missions](../../packages/core/src/workflow/missions.ts), [executor background notices](../../packages/core/src/workflow/executor/notices.ts), and [goal mirror tests](../../packages/core/src/mission-mirror.test.ts).

### Improve through measured experiments

The current code has several distinct learning paths:

| Path | Current value | Limit to preserve or improve |
| --- | --- | --- |
| `self.improve` | Aggregates repeated tool failures, stuck tasks, cost outliers, response-quality counters, and graph health; drafts proposals | These patterns are evidence for investigation, not proof that a proposed model or policy will be better |
| Skill reflection | Stores learned procedures and outcome counts | A task outcome alone does not isolate whether the skill caused success/failure |
| Dreaming | Produces internal observations and quarantined low-confidence hypotheses | No tools for outward action; hypotheses require review and must not become confirmed owner preferences |
| Self-maintenance | Identifies code-shaped proposals | An advisory proposal is not an implemented fix |
| Self-repair | Bounded diagnosis, synthetic reproduction, independent checks, reviewable PR, deployment monitoring | A model-completed run is not a verified patch; a deployed patch is not a confirmed behavior fix |

The next evolution should be an experiment ledger linked to an immutable baseline: observed problem, representative fixture set, proposed change, expected metric, budget, result, and promotion/rollback decision. Candidate prompt/model/skill changes should pass a holdout suite that was not used to write the proposal. Model routing experiments must keep tool correctness, structured-output reliability, refusal/uncertainty handling, latency, total cost, and privacy/provider eligibility separate; one cheap call is not proof of low total task cost.

A useful model score measures completed tasks at the required quality per dollar, including retries, verifier calls, token use, tool errors, and escalations. Do not optimize only answer eloquence or the provider's advertised token price. The OpenRouter catalog and paid model evaluation are separate work; this audit made no provider calls and does not assume any named future/current model exists or is available to this installation.

Improvement states should read as evidence: proposed, tested, awaiting review, applied, deployed, monitoring, confirmed, rolled back. Current proposal acknowledgement can use `applied` even when it only records advisory acknowledgement; broad improvement dashboards should avoid presenting that as a code or behavior change.

Evidence: [improve.ts](../../packages/core/src/workflow/improve.ts), [skills.ts](../../packages/core/src/memory/skills.ts), [dream.ts](../../packages/core/src/workflow/dream.ts), [self-maintenance.ts](../../packages/core/src/workflow/self-maintenance.ts), [self-repair.ts](../../packages/core/src/workflow/self-repair.ts), and [self-repair operator contract](../self-repair.md).

### Make performance a product contract

Current bounds cover task concurrency, various batch sizes, memory blocks, excerpts, retries, and model budgets. They do not by themselves establish fast interaction or good total cost.

Record these measures by request family and backend, with the release/version and provider role:

- Time to the first meaningful response, separate from a decorative loading state.
- Time to a verified result, including queue delay, provider reads, approvals, and retries.
- Optional context-assembly latency, skipped layers, actual token/character size, and recall usefulness.
- Recurring producer duration, active-run count, backlog age, and meaningful-candidate admission rate.
- Unprompted notices per day, duplicates, ignored/dismissed rate, resolution rate, and false urgency corrections.
- Cost per completed request/goal increment, retry/escalation cost, and provider estimates versus settled ledger values.
- Repair false positives, reproduced defects, independent-check failures, regressions, and confirmed recoveries.

These are proposed measurements, not measured benchmark results. Use redacted counters and identifiers in operational analytics; raw prompt capture remains an explicit private diagnostic policy with its retention window. Pages should consume bounded projections of this state rather than performing unbounded scans or refreshing unchanged operational data at conversation cadence.

## Remaining concrete risks and acceptance work

| Concern | Evidence and implication | Completion criterion |
| --- | --- | --- |
| Historical ledger-only claims have unknown notice history | Imported/pre-refactor claims may lack an owner message and stay inert to avoid repeated notices | A separate evidence-based reconciliation can identify and review lost legacy notices without assuming every old claim needs re-sending |
| Producers still have independent in-app admission | Pulse now has atomic owner admission, but briefing, watches, arrivals and curiosity do not share its ranking/cap contract | Concurrent candidates from multiple producers obey one attention contract |
| Calendar absence is not necessarily cancellation | A forward window can omit an event moved beyond that window; completeness describes that read, not a provider-wide deletion | Reconcile missing IDs against provider change/deletion evidence before claiming cancellation |
| Snapshot retention is a comparison baseline, not an event log | Intermediate edits can revert or pass their useful time before admission | Define whether changes need a durable source outbox, expiry, and provider version keys |
| Some pulse reads are sequential and can fail the whole observation pass | Mail, commitments, situation packs, and snapshot work remain separate awaited dependencies | Independent source failures degrade only that source; deadlines bound optional work; tests retain healthy-source notices |
| Tick backpressure is process-local | One active-tick set prevents local accumulation but supplies no distributed lease or provider abort | Replayed/multi-instance sync has source-owned leases/idempotency and bounded provider cancellation |
| Notification summaries can overstate actual phone delivery | `pingOwner` reports a fulfilled `Promise<void>` as success, which cannot distinguish suppression/no-channel from delivery | Notifier returns explicit delivered/suppressed/unconfigured/failed results; UI/telemetry use the actual outcome |
| Self-improvement experience mixes diagnostics with trusted internal memories | Error signatures may originate in external tool errors; improvement summaries are stored as assistant experience | Treat diagnostics as data with provenance; validate promoted procedures against tests and trust policy |
| Live proposal changes are not comparative experiments | An evidence-bearing known enabled model may be applied without candidate holdout results | Model change has task-based evaluation, provider/privacy compatibility, canary, and rollback evidence |
| Goal completion can rely on model reflection | Reflection chooses complete based on narrative progress | Completion requires explicit acceptance criteria and verified outcome evidence |
| No source inspection proves device/deployment behavior | Native foreground/background, notification channels, storage backend, feature flags, and release identity vary | Run installation-specific end-to-end/device checks and record the exact runtime/client versions |

The follow-up changes pulse storage adapters and the shared admission port. It introduces no schema migration, outward-action authority, provider credentials, production setting, or deployed service change.

## Validation

The focused pure regressions cover actual budget enforcement, truthful recall provenance, overlapping-neighborhood deduplication, slow recurring provider work, tick recovery, duplicate proactive candidates, fresh contention, retained calendar changes, paced second delivery, and failed notice persistence. Core and agent TypeScript checks passed. The coordinator owns canonical whole-repository, adapter/database, boundary, build, and native validation for the combined review.

The October 3 adapter follow-up passed **43 tests in seven focused emulator suites**, using the existing Homebrew OpenJDK 21.0.12.1 runtime and installed Cloud Firestore emulator 1.22.0 on loopback port 8899, with `demo-assistant-test` single-project enforcement and fresh per-test installation roots. Coverage includes same-key/different-key races, final daily-slot contention, after-commit replay, message-encoding rollback, imported moments/proposals, migrated Notifications routing, primary/archived chat routing, preference rechecks, and active/completed/malformed erasure fences. It also exercises the existing owner-notice, privacy, nudge-policy and task-outbox suites. Firestore and agent TypeScript checks, targeted Biome checks, and `git diff --check` passed. No real cloud datastore, live Google/mail/calendar/provider, or paid model experiment is involved.

The native continuation ran eight selected suggestion test-method bodies against the actual `APIModels.swift` on the macOS Swift/Foundation host, with **121 assertions**, using lightweight assertion/fixture adapters. A separate Foundation harness passed **86 assertions** against extracted current `AppModel` method bodies (`saveConnection`, `resetConnectedState`, `apply`, `connectionIsCurrent`, open/create/model/hide), with the actual `ConversationDrafts.swift` store. It covers failed candidate preservation with no credential write, same-configuration/owner draft retention, changed-owner reset exactly once during both pairing and refreshed bootstrap, late mutation success/failure after chat/owner/generation changes, and active/settling replies begun during both model phases and conversation opening/creation. Network, UIKit, credential writer and system effects are substituted. These are method/state checks, not an executed iOS XCTest suite or device interaction/performance measurement. The new native XCTest regressions remain in the registered source files for coordinated iOS validation. Swift parser checks and focused `git diff --check` passed.
