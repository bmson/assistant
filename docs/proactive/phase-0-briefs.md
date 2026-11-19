# Phase 0 briefs: make it run, stay up and tell the truth

Thirteen items. Each one fits in a single pull request. Briefs were written against `dca4009`, which includes #910; verify every reference before you change anything. Background for all of them is in [current-system.md](current-system.md).

Shared rules for every brief:

- Change both persistence drivers when the behavior is persisted. Extend the contract suite when the port has one (`packages/persistence/src/*-contract.ts`).
- Add tests before the fix where practical, so the failing case is visible in the diff.
- Do not run anything against the production installation. Production facts below come from the Nov 18 investigation.
- Keep fixtures synthetic (see [golden-signals.md](golden-signals.md)); this repository is public.

---

## A1 · Reconcile cost holds

**Goal.** Held money reflects money at risk now. Unknown-cost attempts stop blocking future days.

**Evidence.** Production held more than the whole daily cap (about 122% of it, from roughly 400 unknown-cost attempts), so every non-critical task parked at $0.00 spent and morning briefs were missed for days. The held total kept growing through ordinary use.

**Root cause.**

- Firestore: one global `heldMicros` counter (`packages/firestore/src/costs.ts:254-278`) is added to daily spent at admission (`:472-474`). The daily reset clears only spent.
- PostgreSQL: `packages/db/src/cost-repository.ts:148-160` sums every reservation with status `held`, `dispatching` or `unknown`, regardless of age.
- `expireEstimatedCostGrant` (`costs.ts:626`) deliberately leaves dispatched and unknown children held.

**Change.**

1. Log a sample of unknown attempts first (provider, model, outcome, age) to confirm why they never settle: aborted streams, timeouts, or missing usage.
2. Settle unknown attempts. Use provider-reported usage when the provider has it. Otherwise, after a configurable TTL (default 30 minutes), convert the attempt to spent at its estimate, with a distinct evidence basis, or release it when the request provably never reached the provider.
3. Scope admission. Only active holds (`held` and `dispatching` within the TTL) count against the daily cap; settled amounts count as spent in the period they settle.
4. Emit a health warning when held exceeds 25% of the daily cap (consumed by H4).
5. Add the config keys in `packages/config` and `.env.example`, and a Drizzle migration if a status or basis is added (`pnpm check:migrations`).

**Tests.** Contract tests in both drivers: yesterday's 400 unknown attempts do not block today's admission; settlement is idempotent; settled money appears exactly once in spent; outward-action approval paths are unchanged. Run `pnpm test packages/db/src/cost` and `pnpm test:firestore`.

**Done when.** Held returns to about 0 within an hour of the last call, and no task parks as `waiting_budget` at $0 spent for 7 days.

**Out of scope.** Provider billing imports; Costs UI.

**Read first.** [estimated-cost-approval-contract.md](../estimated-cost-approval-contract.md), [cost-tracking.md](../cost-tracking.md). Money paths are fenced on purpose; never weaken admission for outward actions.

---

## A2 · Wake parked work when caps change

**Goal.** Raising a cap resumes parked work at once, and the parked notice says what really happened.

**Root cause.** `waiting_budget` clears only on the period reset (`packages/core/src/workflow/schedules.ts:512`; parking in `packages/core/src/workflow/machine.ts:169`). The cap update (`PATCH /api/mobile/v1/costs`, `apps/web/app/api/mobile/v1/costs/route.ts:15`) doesn't trigger re-admission. The notice (`packages/core/src/cost.ts:155`) says the cap is "exhausted" even when most of it is held, and links a web page.

**Change.** On any cap change, run one re-admission pass over parked tasks, oldest first, within the new headroom. Reword the notice as "Paused: $X spent and $Y held against today's $Z limit", with a link the iOS app routes to its Costs screen.

**Tests.** Raising the cap resumes parked tasks within one sweep, in both drivers. A snapshot test for the notice text.

**Done when.** A raised cap resumes parked work within 1 minute.

---

## A3 · Outage watchdog and catch-up digest

**Goal.** A silent outage becomes impossible, and the owner gets one "while I was away" summary afterwards.

**Evidence.** No activity at all for about 2.6 days (Nov 15–18), and nobody was told.

**Change.**

1. Put the watchdog **outside** the scheduler it watches: a separate Cloud Scheduler job or Cloud Monitoring alert that calls a cheap health route and alerts when the last sweep heartbeat is more than 30 minutes old, or the last briefing more than 26 hours old. Check `infra/gcp` for the existing scheduler wiring first.
2. Alert through an interrupt-urgency path (push and, by A17's rules, text), deduped per incident.
3. When the agent recovers, compose one catch-up digest of what changed during the gap (cancellations, moves, important mail) through the `proactiveMoments` ledger, so nothing is repeated.

The recovery digest reads up to 500 messages received during the outage, newest first, using the provider receipt time. It looks up booking changes by the source messages admitted for that digest. Mail received after recovery and unrelated historical bookings do not displace the evidence.

**Tests.** Unit tests for the heartbeat decision and the digest composition. A test that a simulated 3-hour gap produces exactly one alert and one digest.

**Done when.** A stopped scheduler is reported within 30 minutes, and recovery produces one digest.

---

## A4 · Stop mirroring secondary-chat replies into the primary chat

**Goal.** An answer appears only in the chat where it was asked.

**Root cause.** `notifyOwnerOfDeliveredAnswer` (`packages/core/src/workflow/executor/notices.ts:41`) → `composeOwnerNotifiers` (`apps/agent/src/deps.ts:649`) → `dashboardOwnerNotifier` (`deps.ts:314`). That copies the reply into the primary chat whenever `shouldMirrorIntoPrimary` (`deps.ts:276`) is true. In Firestore mode a `destination: 'notifications'` post throws (`packages/core/src/chat.ts:612-628`).

**Change.** Answer-ready notices (delivery key prefix `task-answer`) skip the dashboard leg, because the answer is already in its own conversation. Keep the dashboard copy for owner notices that have no conversation (briefings, alerts, approvals). Optionally add a Firestore Notifications destination.

**Tests.** `apps/agent` tests: a task answer in a secondary chat posts nothing to the primary chat; an approval raised there still notifies; a briefing still posts.

**Done when.** No secondary-chat reply appears in the primary chat, and the push "answer ready" still fires.

---

## A5 · Checklist dedupe ignores trailing punctuation

**Root cause.** `packages/core/src/workflow/request-checklist.ts:189-192` compares raw planner spans with spans already stripped of trailing punctuation, so "X." and "X" become two items. One never completes, so `executor/finalize.ts:584` marks the task unfinished, and `response-contract.ts:1120` writes "Completed: … Still needed: …".

**Change.** Normalize proposed spans with the same rule before comparing and pushing them, or dedupe on the normalized key.

**Tests.** `request-checklist.test.ts`: a one-clause reminder request with a trailing period yields one item. A scripted executor test: a successful single reminder ends without "Still needed".

**Done when.** A successful single action is never reported as not completed.

---

## A7 · Self-repair cadence respects its limit

**Root cause.** `apps/agent/src/repair-schedule.ts:42-52` sets `nextRunAt = now` whenever any issue is `fixing`, `testing`, `pr_open` or `merged`. An issue that stays `merged` keeps the job running every minute indefinitely.

**Change.** Poll follow-ups at the schedule's own cadence (15 minutes) and treat `merged` as terminal after verification. Never schedule `now` unless `repairQueueReady` is true.

**Tests.** `apps/agent/src/firestore-repair-schedule.test.ts`: with a `merged` or `pr_open` issue, `nextRunAt` is at least 15 minutes away.

**Done when.** At most 96 self-repair runs a day, and Activity shows real work.

---

## A10 · Retire `morning-brief` in Firestore

**Root cause.** The seed retired it (`packages/db/src/seed.ts:211-216`), but the Firestore schedules copied at cutover still have it enabled at 07:30. It runs a model loop, titles its output with the raw internal prompt, and leaks internal text ("I have not sent this via owner.notify").

**Change.** Add an idempotent reconciliation that disables schedules the seed lists as retired (add a `retiredSchedules` list next to `scheduleSeed`) and run it with the runtime seed. Follow the pattern #910 used for `life-awareness` (`apps/agent/src/awareness-schedule.ts`, called from the Firestore maintenance sweep), and check [consumer-runtime-seed.md](../consumer-runtime-seed.md). The wake path already targets `daily-briefing` (`WAKE_BRIEF_SCHEDULE`, `schedules.ts:677`).

**Tests.** Emulator test: an installation holding `morning-brief` has it disabled after reconciliation; running it twice is a no-op.

**Done when.** Only one morning brief exists.

---

## A11 · Email pipeline: verify #910 and make stalls visible

**Goal.** Scored mail reaches extraction, and a stall is visible within hours.

**Evidence.** Every extraction run from at least Nov 14 to Nov 18 reported `0 saved … from 0 message(s) … 0 still pending`. The Nov 7 [live audit](../audits/proactive-live-audit-2026-11-07.md) found the cause: every recent ingest row sat at `message_persisted`, and every reader required `complete`, which direct ingress never reaches.

**Already fixed in code (#910).** Readers use `emailIngestReadable` (`packages/persistence/src/email-ingest-readiness.ts`), which admits authenticated direct-mode sources at `message_persisted` with a prepared score. Extraction reads automated bodies from `emailObserverSources`, and forwarded observation includes archived mail. See [current-system.md §3.2](current-system.md#32-mail).

**Implementation.** Scheduled extraction now reports the readable backlog separately from fresh intake, items awaiting review and messages stalled in each intake stage for over six hours. The default hourly health monitor raises a counts-only warning and throttles repeated delivery to once per 24 hours. The forwarded-mail fixture exercises scheduled extraction against both databases.

**Census.** Run `pnpm mail:census --help` for the read-only diagnostic. Its counts cover pipeline stage, ingest mode, source kind, score status, age, and the extraction marker. Firestore distinguishes absent fields from explicit nulls. A scan that reaches its configured limit reports whether more rows remain.

**Production acceptance.** Record daily counts of eligible mail, extracted rows, and outstanding backlog after release. A day without eligible mail is recorded separately.

**Tests.** Emulator and PostgreSQL tests: a row stuck in `scoring` past its lease is counted as stuck; a readable direct row is extracted once; the census counts every stage.

**Done when.** Extraction processes more than 0 messages a day in production, and any stage holding rows for more than 6 hours raises a warning.

---

## A13 · The owner's time zone in every card

**Root cause.** `formatTime(value, timeZone?)` (`packages/core/src/workflow/response-cards.ts:200`) renders UTC when the caller omits the zone. iOS prints `item.time` verbatim (`apps/ios/Assistant/Components/BriefingCardView.swift:226-234`), although the briefing card carries `timeZone`.

**Change.** Make the zone required and pass the owner's zone through. On iOS, format from start and end when present, using the card's `timeZone`.

**Tests.** Card tests assert owner-local times. An iOS unit test in `apps/ios/AssistantTests` covers briefing row formatting.

**Done when.** No card shows a UTC wall time.

---

## A15 · Each turn answers its own message

**Evidence.** In testing, 3 of 18 questions were answered with the answer to an earlier question: news got a weather answer, deliveries got a sleep question, and bills got a health question.

**Root causes.**

1. **Clarification binding.** `clarificationAnswerStatus` (`packages/core/src/workflow/owner-intent.ts:228-250`) returns `'answer'` for anything that isn't a short refusal or an explicit "unrelated" opener. The new message is then merged as `Owner clarification answer: …` into the old request (`:878-890`).
2. **Fold after park.** `foldOwnerRepliesSincePark` (`packages/core/src/workflow/executor/seed.ts:324`, called at `executor.ts:1192`) folds every owner message posted while the task waited for approval, including messages that started tasks of their own.

**Change.**

1. Treat a message as the answer only when it plausibly answers: short slot-filling replies, or replies that reference the question. A message that is itself a complete request with a different read intent (`read-intent.ts`, `active-read-intent.ts`) is `'unrelated'` and starts its own task. A pending clarification also expires once the assistant has answered anything else.
2. Fold only replies that modify the parked request ("also include…", "cancel that"), never a message that already owns a task.

**Tests.** Scripted-model golden tests for the three sequences: approval-parked task plus a later question; clarification plus an unrelated question, twice in a row. Existing continuity tests stay green ([request-continuity.md](../request-continuity.md)).

**Done when.** Replaying those sequences, every question gets its own answer, and the resumed task answers its own request.

---

## A16 · Weather plausibility

**Root cause.** The WMO code map (`packages/core/src/memory/ambient.ts:37-62`) is applied without checking temperature.

**Change.** Snow codes (71–77, 85–86) with a daily minimum above 3 °C become rain or sleet; cross-check against hourly data when it's available. Log implausible combinations.

**Tests.** A table test over snow codes and temperatures.

**Done when.** No "snow" appears with a daily minimum above 3 °C.

---

## A17 · Texts only for urgent items

**Goal.** Text messages are reserved for things that can't wait. Everything else goes by push, silent while the app is open.

**Evidence.** Every answer that finished in the background was also texted; 17 test answers produced 17 texts in 25 minutes. SMS was the largest cost line in November.

**Root cause.** `notifyOwnerBySms` (`packages/modules/src/sms/channel.ts:377-423`) sends any notice it receives, although its own doc comment limits it to failures, stalls, escalations and confirmations. `composeOwnerNotifiers` (`apps/agent/src/deps.ts:649`) fans out ambient answer-ready notices, email importance alerts and the twice-daily `life-awareness` notice to SMS. The nudge policy is off when no preference row exists (`packages/core/src/proactive/nudge-policy.ts:9-28`).

**Change.**

1. The SMS leg accepts `urgency: 'interrupt'` notices and approvals only. It skips `ambient` notices, recording a `skipped` leg with a reason.
2. Add a daily SMS cap (default 3, in `packages/config` and `.env.example`) and an explicit opt-in to "text me answers".
3. Email importance alerts and answer-ready notices use push.

**Tests.** SMS channel tests: an ambient task answer is skipped; an interrupt notice is sent; approvals are sent; the cap holds under concurrency (both drivers if the cap is persisted).

**Done when.** A normal answer sends no text, and there are at most 3 texts a day by default.

---

## H4 · Daily canary

**Goal.** The owner and the operator can see that every proactive source is fresh and every producer ran, so quiet can be trusted.

**Checks.** Briefing delivered today; pulse ran in the last hour; extraction processed more than 0 in 24 hours (or ingest volume was 0); Google calendar connected; phone snapshot newer than 24 hours; weather available today; held under 25% of the daily cap; texts today within the cap.

**Where.** Extend `packages/core/src/proactive/pipeline-health.ts` (`assessProactiveHealth`) and `packages/application/src/proactive-health.ts`, with Firestore reads in `packages/firestore/src/proactive-health.ts`. Use the existing `assistant-health-monitor` schedule (`packages/core/src/workflow/health-monitor.ts`) rather than a new one, and expose the result through `GET /api/mobile/v1/workspace`. The iOS card is E5.

**Tests.** One test per check, with fixed clocks. Red sends one interrupt notice a day.

**Done when.** The canary is readable from the mobile API, with red or green per check.
