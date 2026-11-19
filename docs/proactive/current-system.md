# How proactive behavior works today

Snapshot of `main` at `dca4009` (Nov 18, 2026). It includes #910, which connected admitted mail and life context to the proactive readers. Production observations are from Nov 18 and may predate the deployment of #910. The production installation runs with `PERSISTENCE_DRIVER=firestore`. Line numbers drift; search for the named symbol when a reference no longer matches.

Prior work to read alongside this page: the [proactive awareness audit](../audits/proactive-awareness-2026-11-07.md) and the [live proactive audit](../audits/proactive-live-audit-2026-11-07.md) from Nov 7, which led to #910.

## 1. Runtime

- **Agent** (`apps/agent`): composition root (`apps/agent/src/deps.ts`), executor, and the scheduler sweep, which runs every minute and fires due schedules. Code jobs dispatch from `packages/core/src/memory/jobs.ts`; model-loop tasks run through `packages/core/src/workflow/executor.ts`. The Firestore maintenance sweep (`apps/agent/src/firestore-sweep.ts`) also creates missing system schedules.
- **Web** (`apps/web`): the mobile API under `apps/web/app/api/mobile/v1`. In Firestore mode `apps/web/proxy.ts` admits an explicit allowlist and answers everything else with `503 "This web surface is unavailable in Firestore mode."` The route inventory is in [firestore-web-route-inventory.md](../firestore-web-route-inventory.md).
- **iOS** (`apps/ios`): reads mostly through `GET /api/mobile/v1/workspace`, posts chat turns to `POST /api/mobile/v1/chat`, and publishes the phone's calendar snapshot and location pings.
- **Firestore runtime gaps** are tracked in [firestore-agent-runtime-inventory.md](../firestore-agent-runtime-inventory.md).

## 2. Schedules

Seeded in `packages/db/src/seed.ts` (`scheduleSeed`, line 209); cron times are owner-local.

| Schedule | Cron | Kind | What it does |
|---|---|---|---|
| `pulse` | `*/20 * * * *` | code job `pulse.check` | Proactive moments in the next 6 hours (§4.1) |
| `ambient-refresh` | `*/30 * * * *` | code job `ambient.refresh` | Location and weather snapshot (§3.4) |
| `daily-briefing` | `45 7 * * *` | code job `briefing.compose` | Deterministic morning briefing (§4.2) |
| `life-awareness` | `0 11,17 * * *` | **model task**, $0.50 budget | Twice-daily cross-source review (§4.4). Added by #910 |
| `tomorrow-check` | `30 19 * * *` | **model task** (prompt at `seed.ts:272`) | Evening look-ahead; relies on `gmail.search` and the ambient weather block |
| `email-extraction` | `20 */4 * * *` | code job `email.extract` | Facts, dates and occasions from scored mail (§3.2) |
| `memory-extraction` | `0 22 * * *` | code job `memory.extract` | Facts from the day's conversations |
| `memory-consolidation` | `30 22 * * *` | code job `memory.consolidate` | Dedupe and resolve per entity |
| `open-loop-sweep` | `35 */6 * * *` | code job `memory.sweep_loops` | Commitments and open loops |
| `dream` | `30 0 * * *` | code job `dream.run` | Overnight reflection, "anticipations" with a 7-day TTL (`packages/core/src/workflow/dream.ts:46`) |
| `self-repair` | `*/15 * * * *` | code job `self.repair` | Investigates failed tasks; see A7 for the real cadence |
| others | | code jobs | graph sync, curiosity (one question a day), segmentation, anomaly scan, skill reflection, self-improve, self-maintain, health monitor |

- `morning-brief` (`30 7 * * *`, a model task) was retired in the seed (`seed.ts:211-216`, "do not re-add this") but **is still enabled in the production Firestore schedules** (A10).
- `maybeFireWakeBrief` (`packages/core/src/workflow/schedules.ts:689`) can start `daily-briefing` (`WAKE_BRIEF_SCHEDULE`, `:677`) on the first app open before the cron.
- `life-awareness` is defined once in `packages/persistence/src/proactive-awareness.ts`. PostgreSQL seeds it; Firestore installations get it from `ensureAwarenessSchedule` (`apps/agent/src/awareness-schedule.ts:10`, called from `firestore-sweep.ts:117`). Owner edits and pauses are preserved.

## 3. Sources

### 3.1 Calendar

- Google calendars come through the google module (`packages/tools/src/google/calendar.ts`). iPhone calendars come through a snapshot the app publishes (`apps/ios/Assistant/System/PhoneCalendarSharingCoordinator.swift:158-250, 421-451`), only while the app is in the foreground; there is no background refresh.
- Agenda answers and coverage lines: `calendarAgendaSummary` (`packages/core/src/workflow/calendar-agenda.ts:1437`) and `packages/persistence/src/phone-calendars.ts:162`.
- Household view: `CalendarHouseholdItemV1` (`packages/persistence/src/calendar-household-day.ts:29-42`) types `eventFor` and `driving` as the literal `'not_stated'`. The schema exists; nothing infers who an event is for or who drives.

### 3.2 Mail

Mail is ingested and moved through a stage machine in `packages/firestore/src/email-sync.ts` (PostgreSQL: `packages/db/src/email-sync-repository.ts`), driven by `packages/modules/src/google/email-sync.ts`:

```text
pending_classification → classifying → pending_score → scoring → score_prepared
   → message_persisted → complete            (needs_attention on failure)
```

- **Readiness (since #910).** Readers use `emailIngestReadable` (`packages/persistence/src/email-ingest-readiness.ts`; SQL twin `emailIngestReadableSql` in `packages/db/src/email-ingest-readiness.ts`). A row is readable at `complete`, or at `message_persisted` when it is an authenticated direct-mode source with a prepared score. Before #910 every reader required `complete`, which direct ingress never reaches (`completeForwardedIngest`, `email-sync.ts:2386`, is forwarded-only), so extraction, briefing and pulse saw no mail.
- **Extraction** (`FirestoreEmailExtractionRepository.pending`, `packages/firestore/src/email-extraction.ts:42-63`) reads readable rows with `extractedAt == null`, and reads automated bodies from `emailObserverSources`. Its pending counter (around `:323`) counts only readable rows, so a row stuck in an earlier stage is still invisible (A11).
- **Scope.** Forwarded observation now includes archived received mail, but never sent, draft, spam or trash (`packages/modules/src/google/email-observation-scope.ts`).
- **Scoring** (`packages/modules/src/google/email-importance.ts`). Categories are `security, financial, travel, appointment, commitment, personal, transactional, bulk, other` (`:23-33`). Since #910 the prompt resolves dates against the message's received time and doesn't treat automated school, family or sports notices as security (`:161-162`). Importance at or above `EMAIL_INGEST_NOTIFY_THRESHOLD` alerts the owner as an ambient notice, which also texts (§5).
- In Firestore mode `email.extract` quarantines occasions (see the runtime inventory).

### 3.3 Web and news

There is no news source. `web.search` is registered as `autonomous` (`packages/tools/src/search.ts:130`). Once a task has read untrusted content (mail, pages), the taint gate requires approval for further public reads, apart from the exact-plan exceptions in `authorizedPublicSourceRead` (`packages/tools/src/dispatcher.ts:458`). `life-awareness` searches before it opens private sources and may fetch the pages its own search returned. A news request in a tainted chat stopped for approval in testing (B7).

### 3.4 Location and weather

- `refreshAmbientSnapshot` (`packages/core/src/memory/ambient.ts:489-507`) needs a fresh location ping inside `LOCATION_RETENTION_DAYS`. Without one it clears the snapshot, and the job reports `ambient: no fresh location — snapshot cleared` (`packages/core/src/memory/jobs.ts:729-747`). On Nov 18, 4 of 11 runs produced weather.
- Weather is Open-Meteo for "now and today at the last location". There is no forecast for an event's place and time.
- WMO codes map to words with no plausibility check (`ambient.ts:37-62`): code 75 became "heavy snow" in a coastal city at 8–13 °C (A16).

### 3.5 Device

`apps/ios/Assistant/Info.plist:50-55`: `UIBackgroundModes` is `audio` only; location is when-in-use; calendar access exists. There is no HealthKit, Contacts, Reminders or Motion integration.

## 4. Producers

### 4.1 Pulse (`packages/core/src/proactive/pulse.ts`)

- Moment kinds (`:150-158`): `event-lead`, `mail-action`, `commitment-due`, `situation-change`, `calendar-unverified`, `calendar-cancelled`, `calendar-moved`, `calendar-declined`.
- Window: `CALENDAR_WINDOW_HOURS = 6` (`:120`); snapshots are diffed only inside it (`:1187`), so changes further out are never detected (D2).
- Pacing: `MIN_GAP_MINUTES = 60` (`:107`), `DEFAULT_DAILY_CAP = 6` (`:118`), `MAIL_MIN_IMPORTANCE = 4` (`:134`). Moments are keyed in the `proactiveMoments` collection (`packages/firestore/src/pulse.ts`), so nothing is said twice. See [durable-pulse-admission.md](../durable-pulse-admission.md).
- **Event-lead only fires for salient events** (`legacyEventLeadMoments`, `:410-465`). Lead is 45 minutes when salience includes a place ("it is at …"), otherwise 15. Salience (`packages/core/src/proactive/calendar-salience.ts`) sums `unanswered 3, travel 2, unusualHour 2, externalOrganizer 1, crowded 1, long 1, allDay 1` against `SALIENCE_THRESHOLD = 3`; group calendars count as no organizer.
  - So a child's appointment with no location scores 0, and a school conference with a location scores 2. Neither can ever produce a lead alert.
  - An evening block that runs late and long scores 4.
  - Observed on Nov 18: two overlapping family appointments in the afternoon, and every pulse run reported `quiet (no-candidates)` (D1, D3).
- Overlaps are not a moment kind; only the briefing mentions them.

### 4.2 Daily briefing (`packages/core/src/workflow/briefing.ts`)

- **Composition.** Deterministic, with no tools (`:97`): agenda, coverage, overlaps, weather (from the ambient snapshot), needs-you, mail worth reading, "coming up" (dates extracted from mail), goals that moved.
- **Life context** (since #910). `briefingLifeContext` (`packages/core/src/proactive/life-context.ts`, called at `briefing.ts:1091`) adds up to six upcoming occasions and up to five open commitments. Occasions must be owner-confirmed or owner-sourced and inside their lead window (capped at 30 days). Commitments are due within 7 days, or undated and stale.
- **Missing sections.** Bills, school, news, people and holidays.
- **Times.** Card times come from `formatTime(value, timeZone?)` (`packages/core/src/workflow/response-cards.ts:200`); without a zone they render in UTC. iOS prints `item.time` verbatim (`apps/ios/Assistant/Components/BriefingCardView.swift:226-234`) (A13).

### 4.3 Occasions and others

- **Occasions**: store and tools in `packages/core/src/memory/occasions.ts`. Since #910 only owner-confirmed or owner-sourced occasions surface (`:190`), so assistant-inferred dates stay silent until confirmed. No moment announces an occasion at its lead time, and production data holds duplicates and wrong kinds (C4, C5, D6).
- **Watches, suggestions**: [anticipation-layer.md](../anticipation-layer.md). Watches need specific senders; there is no topic or importance watch (F2).
- **Situation packs**: [situation-packs.md](../situation-packs.md). Nothing proposes one automatically (D13).
- **Dream anticipations**: `dream.ts:67-79`. None were produced on Nov 18 (D14).

### 4.4 `life-awareness` (model-loop review, since #910)

Runs at 11:00 and 17:00 with the general executor and a $0.50 budget. Its instruction (`packages/persistence/src/proactive-awareness.ts`):
- recalls memory, goals and the next 30 days of occasions;
- runs one public web search before reading private sources;
- reads every calendar for the next 14 days and two days of mail;
- connects these and sends at most one `owner.notify` with up to three grounded observations, or stays silent.

Selection, prioritization and cross-run dedupe live in the prompt, not in the `proactiveMoments` ledger, and its notice is ambient, so it also texts until A17. In the target design its findings become ledger candidates (D1).

## 5. Delivery

```text
producer / executor
   └─ notifyOwner(input)                         composeOwnerNotifiers  apps/agent/src/deps.ts:649
        ├─ dashboard leg  → primary chat         dashboardOwnerNotifier deps.ts:314, shouldMirrorIntoPrimary deps.ts:276
        └─ out-of-band    → policyGatedOutOfBand deps.ts:624 → evaluateOutOfBandPing (nudge policy)
               ├─ push (APNs)
               └─ SMS        notifyOwnerBySms   packages/modules/src/sms/channel.ts:377-423
```

- `notifyOwnerOfDeliveredAnswer` (`packages/core/src/workflow/executor/notices.ts:41`) sends **every answer that finishes in the background** as an `ambient` notice. The dashboard leg copies replies from secondary chats into the primary chat (A4). The SMS leg texts the owner the first 480 characters (A17).
- Nudge policy (`packages/core/src/proactive/nudge-policy.ts:9-28`): quiet hours and the ambient daily cap are "both off until opted in (an absent prefs row allows everything)". They can be set only in web settings, not on iOS or the mobile API (E5).
- In November, SMS was the largest cost line in production, ahead of all model calls.
- In Firestore mode a `destination: 'notifications'` post throws (`packages/core/src/chat.ts:612-628`), so everything lands in the primary chat.
- iOS renders proactive alerts as a card with no actions (`apps/ios/Assistant/Components/MessageBubble.swift:2098`, `proactive-alert`) (E4).

## 6. Costs and admission

- Unpriced model calls create "unknown" reservations that stay held. Firestore keeps one global `heldMicros` counter (`packages/firestore/src/costs.ts:254-278, 383-476`). The admission check compares `daily spent + held + pending` with the **daily** cap (`:472-474`), but the daily reset clears only spent. PostgreSQL sums every `held`, `dispatching` and `unknown` reservation regardless of age (`packages/db/src/cost-repository.ts:148-160`). `expireEstimatedCostGrant` (`costs.ts:626`) leaves unknown children held. Holds therefore accumulate across days until they exceed the cap, and every non-critical task parks (A1).
- Parked work: `parkForBudget` (`packages/core/src/workflow/machine.ts:169`). `waiting_budget` clears only on the period reset (`packages/core/src/workflow/schedules.ts:512`), not when the owner raises the cap (A2). The parked notice (`packages/core/src/cost.ts:155`) says the cap is "exhausted" even when it is mostly held, not spent.
- Estimated-cost approval: [estimated-cost-approval-contract.md](../estimated-cost-approval-contract.md).

## 7. Conversation paths that break proactive answers

- **Clarification binding** (`packages/core/src/workflow/owner-intent.ts:228-250`, merged at `:878-890`). After the assistant asks a clarifying question, `clarificationAnswerStatus` returns `'answer'` for any next message that doesn't match a short list of refusal or "unrelated" openers. A new, unrelated question is appended as `Owner clarification answer: …` to the old request, and the planner answers the old one (A15).
- **Fold after park** (`foldOwnerRepliesSincePark`, `packages/core/src/workflow/executor/seed.ts:324`, called at `executor.ts:1192`). When a task parked for approval resumes, every owner message posted in the meantime is folded into it, and the task may answer the newest message instead of its own (A15).
- **Checklist dedupe** (`packages/core/src/workflow/request-checklist.ts:189-192`). Planner-proposed spans are compared with spans that already had trailing punctuation stripped, so "X." and "X" become two items, one of which never completes. `executor/finalize.ts:584` then marks the task unfinished, and `response-contract.ts:1120` writes "Completed: … Still needed: …" (A5).
- **Relative periods**: calendar reads refuse "next two weeks" with "I can't safely search that calendar period" (F7).
- **Voice rewrite of dictated bodies**: `packages/modules/src/google/module.ts:296-302` → `packages/core/src/voice.ts:138` (F4).

## 8. Known defects

Observed in production on Nov 18, 2026, unless marked as fixed in code since.

| Symptom | Root cause | Item |
|---|---|---|
| Every non-critical task parked as `waiting_budget` at $0.00 spent; morning briefs missing for days | Holds exceed the daily cap (§6) | A1, A2 |
| 2.6-day silent outage with no alert | No watchdog or canary | A3, H4 |
| Replies from secondary chats appear in the primary chat | Dashboard leg mirrors task answers (§5) | A4 |
| A text message for every background answer | Ambient answer-ready notices reach the SMS leg; nudge policy off by default | A17 |
| Successful single actions reported "not completed" | Checklist dedupe (§7) | A5 |
| "I'll delete it now", but no tool call is made | No promise-without-action guard | A6 |
| Self-repair rows every minute | `apps/agent/src/repair-schedule.ts:42-52` sets `nextRunAt = now` while follow-ups exist | A7 |
| Dashboard "Needs you" count differs from the list; archive returns 409 | `packages/application/src/dashboard.ts:27-30` counts every row; the list scans the newest 500; the archive path (`archiveActivityWithRepository`, called from `apps/web/app/api/mobile/v1/activity/[id]/route.ts:403`) refuses `needs_attention` with `no_longer_retriable` | A8 |
| Phone screens get 503 | Proxy allowlist (§1); estimated-cost routes fixed in #934 | A9 |
| Two morning briefs; one titled with its raw internal prompt and leaking internal notice text | Retired `morning-brief` still enabled in Firestore | A10 |
| Email facts, dates and occasions never extracted (0 per run) | Readers required `complete` (§3.2). **Fixed in code by #910**; verify after deploy; stuck rows still invisible | A11 |
| QA chats, people and memories in production | The QA harness can target the production installation | A12 |
| UTC wall times in cards | §4.2 | A13 |
| "What's on today?" answers of 20,000+ characters with the wrong day heading | Agenda renders every coverage row; multi-day events start their own day card | A14 |
| A question answered with the answer to an earlier one | §7 | A15 |
| "Heavy snow" at 8–13 °C | §3.4 | A16 |
| No weather on most runs | Location-ping dependency (§3.4) | B5, B6 |
| Changes beyond 6 hours never noticed | §4.1 | D2 |
| Overlapping family appointments never alerted | Salience threshold (§4.1); no conflict moment | D1, D3 |
| "Who is attending is not recorded" | §3.1 | C6 |
| "Next two weeks" refused | §7 | F7 |
| Invented or reassigned birthdays; duplicate occasions | Bad occasion data; since #910 only confirmed occasions reach the briefing | C4, C5 |
| A paid bill still remembered as "to pay" | No evidence-based supersession | C3 |
| A practice-time change classified as `security` | Prompt guidance **added in #910**; the taxonomy still lacks schedule-change and other life categories | C2 |
| Email triage drafts a reply the thread no longer needs | Triage ignores thread state | C2, C3 |
| A dictated email body rewritten | §7 | F4 |
| News requests stop for approval | Taint gate on public reads (§3.3) | B7 |
| A permission stored as a memory ("apply without review") | No policy surface for standing approvals | G3 |
| Sensitive personal facts in unrelated answers | `packages/persistence/src/card-privacy.ts:12-23` filters secrets only, not topics | G1 |

## 9. Observing production safely

Only with the owner's consent, and read-only by default:

- `GET /api/mobile/v1/activity` (cursor-paged) shows each schedule run's `progress`, such as `pulse: quiet (no-candidates)`, ambient results, or extraction counts.
- `GET /api/mobile/v1/workspace` returns costs (`dailySpentUsd`, `heldUsd`, `unknownAttempts`, `bySource`), repairs and settings.
- Proactive health: `packages/core/src/proactive/pipeline-health.ts` (`assessProactiveHealth`) and `packages/application/src/proactive-health.ts`.

Do not send chat turns, approve, or edit anything in production to test a change. Every chat turn can text the owner (A17), and test turns pollute memory, People and self-repair.
