# Target design

How the proactive assistant should work once the plan is done. Use it when an item adds data, a moment kind, a delivery rule or a device signal. The current state is in [current-system.md](current-system.md).

## 1. Principles

1. **Deterministic first, model second.** Signals and moments are computed in code jobs from source facts. A model writes wording, and only from verified facts. This keeps the "cannot act outward" guarantee of code jobs and extends what `briefing.ts` and `pulse.ts` already do. Model-loop reviews such as `life-awareness` (#910) stay useful for connecting sources, but their findings enter the moment ledger as candidates rather than notifying directly.
2. **One ledger for everything said.** Every moment, from any producer, goes through `proactiveMoments` (unique key, pacing, daily cap), so the briefing, pulse, look-ahead and weekly review never repeat each other.
3. **Temporal truth.** Every signal has a validity window and can be superseded by later evidence: a payment closes a bill, a reschedule closes an appointment task, a cancellation closes its alert. See [temporal-validity.md](../temporal-validity.md) and [memory-supersession.md](../memory-supersession.md).
4. **Household-aware.** Each event resolves who it is for, where it is, who is free to take it, and travel time. A conflict arrives with a proposal, not "attendance not established".
5. **Sleep-aware and quiet by default.** Delivery windows follow the owner's sleep schedule, falling back to configured quiet hours. Ambient items batch into stacks; only time-critical items interrupt.
6. **Legible silence.** A health signal shows each source is fresh and each producer ran.
7. **Private by design.** Health and contacts are summarized on the phone, and only minimal derived values leave it, with opt-in and retention limits. Sensitive topics never appear in unrelated answers.

## 2. Layers

```text
SOURCES                UNDERSTANDING                 DECISION                    DELIVERY
Google calendars  ┐    signals (typed, superseded)   moment engine v2            morning stack (after wake)
iPhone snapshot   │    + household model             - candidates per kind       interrupts (≤ 1/h, ≤ 6/day)
mail ingest       ├──▶ + occasions (unified)    ──▶  - score and threshold  ──▶  evening look-ahead
contacts (opt-in) │    + relationships                - lead-time policy          weekly review
HealthKit (opt-in)│    + places                       - dedupe, pacing            chat answers, card actions
location, weather │                                                              FEEDBACK → thresholds
news feeds, maps  ┘
                         EVALUATION: golden-signal replay (H1) · weekly audit (H2) · canary (H4)
```

## 3. Data

Every new store is a port in `packages/persistence` with two adapters: PostgreSQL (`packages/db`, Drizzle schema and migration) and Firestore (`packages/firestore`). Both run the same contract suite. Conventions:

- Every document carries `agentId`; queries filter on it first.
- Firestore writes go through `encodeRecord`, which **drops undefined fields**. Write explicit `null` for any field you will query with `== null`; a missing field never matches.
- Mutations in owner data honour the privacy-erasure fence (`assertPrivacyErasureInactiveInTransaction`).
- Declare composite indexes in the Firestore index target (`pnpm firestore:indexes`).
- No personal data in fixtures; use the synthetic household.

### 3.1 `signals`

The invoice and payment records are portable. Workspace export retains canonical signal identities and supersession links. Firestore import uses the same owner, kind, time and subject fields as live signal reads.

```ts
interface Signal {
  id: string;
  agentId: string;
  kind:
    | 'appointment'
    | 'school-notice'
    | 'schedule-change'
    | 'bill'
    | 'renewal'
    | 'payment'
    | 'delivery'
    | 'invitation'
    | 'rsvp'
    | 'gift-received'
    | 'occasion'
    | 'vehicle-service'
    | 'travel'
    | 'weather'
    | 'news'
    | 'time-off'
    | 'commitment';
  subjectPersonIds: string[]; // who it concerns (household roles in §3.2)
  at?: string; // ISO instant the signal is about
  dueAt?: string; // deadline, if any
  window?: { start: string; end: string };
  placeId?: string | null;
  amount?: { value: string; currency: string } | null;
  sourceRefs: Array<{
    kind: 'email' | 'calendar' | 'contact' | 'health' | 'web' | 'owner';
    id: string;
  }>;
  confidence: number; // 0..1, from the extractor
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null; // a later signal that closes or replaces this one
  status: 'open' | 'resolved' | 'dismissed';
  dedupeKey: string; // stable across re-extraction of the same fact
  createdAt: string;
  updatedAt: string;
}
```

Indexes: `(agentId, status, dueAt)`, `(agentId, kind, at)`, `(agentId, dedupeKey)` unique.

The first C1 producer contract covers invoices and paid-in-full receipts. It reads admitted email evidence by ingest row ID and retains the canonical email source ID without copying the message body. Its deterministic signal ID uses agent, kind, and bill identity. Equivalent evidence retains the first committed source reference and validity start. An explicit matching payment atomically records the new fact and closes the selected bill. Producers can filter by kind, person, or a half-open event-time interval, individually or in combination. Each query is scoped to one agent and returns facts valid at the caller's as-of instant. Historical results include canonical replacement metadata. C3 owns automatic matching and integration with producers.

### 3.2 Household and places

```ts
interface HouseholdRole {
  agentId: string;
  personId: string;
  role: 'owner' | 'spouse' | 'child' | 'parent' | 'relative' | 'caregiver';
  schoolId?: string | null;
  usualResponsibilities: Array<'school-run' | 'activities' | 'medical' | 'meals'>;
  confirmedByOwner: boolean;
}

interface Place {
  agentId: string;
  id: string;
  label: string; // "Home", "School A", "Work"
  kind: 'home' | 'school' | 'work' | 'venue' | 'medical' | 'other';
  lat: number;
  lng: number;
  defaultTravelMode: 'drive' | 'walk' | 'transit';
}

interface SchoolCalendar {
  agentId: string;
  schoolId: string;
  dismissal: { normal: string; early?: string; minimumDay?: string }; // owner-local "HH:mm"
  breaks: Array<{ start: string; end: string; label: string }>;
  closures: Array<{ date: string; label: string }>;
  sourceCalendarId?: string | null;
}
```

`CalendarHouseholdItemV1` (`packages/persistence/src/calendar-household-day.ts`) grows into V2, with `eventFor: personId[] | 'unknown'`, `driving: personId | 'unknown'`, and `basis` (title prefix, attendee, calendar, owner confirmation). Keep V1 readers working until clients move.

### 3.3 Occasions, gifts, relationships

- `occasions` (existing): add `sourceRefs`, `confidence`, `confirmedByOwner`, `deceased` on the person. Duplicate kinds for one person and date merge.
- `giftLedger`: `{ personId, occasionId, ideas[], budget, orderedAt, shipBy, status }`. `shipBy` is computed from the destination's shipping lead time.
- Relationship cadence lives on the People projection (`lastContact` already exists): add `closenessTier` and `reconnectEveryDays`.

### 3.4 Device and news

- `deviceDaily`: `{ date, sleepStart, sleepEnd, asleepMinutes, wakeAt, steps, workouts, source }`. Only derived values; 30-day retention; never copied into memory automatically.
- `newsProfile`: `{ topics[], places[], sources[], mutedTopics[] }`.

## 4. Moment engine v2

Extends `PulseMomentKind` (`packages/core/src/proactive/pulse.ts:149-157`). Producers emit candidates; one selector scores, dedupes and paces them.

```ts
interface MomentCandidate {
  kind: MomentKind;
  key: string; // stable: kind + subject + start (+ revision for moved events)
  subjectPersonIds: string[];
  at: string; // the moment the candidate is about
  consequence: 0 | 1 | 2 | 3; // what happens if the owner misses it
  urgency: number; // 0..1, from time to `at` and the lead policy
  confidence: number; // 0..1, from signal confidence and source freshness
  novelty: number; // 0..1, 0 when already said or already known
  text: string; // verified facts only; a model may rewrite wording later
  card: ProactiveCard; // with actions (E4)
  sourceRefs: Signal['sourceRefs'];
}
// score = consequence × urgency × confidence × novelty × ownerPreference(kind)
```

New kinds: `leave-by`, `conflict-proposal`, `change-digest`, `weather-impact`, `occasion-lead`, `gift-ship-by`, `thank-you`, `bill-due`, `renewal`, `delivery-today`, `rsvp-pending`, `school-day-change`, `break-coverage`, `reconnect`, `news-digest`, `sleep-aware-nudge`, `commitment-closed`, `catch-up`.

**Consequence replaces calendar salience for family events.** Today a child's appointment with no location scores 0, so it can never trigger an alert. Consequence is 3 when an event involves a household member and a pickup or drop-off, is medical, or conflicts with another event of the same people. Salience remains a tiebreaker for the owner's work calendar.

Lead-time policy (defaults; owner-tunable):

| Kind                | First mention                            | Reminder                   | Channel                                |
| ------------------- | ---------------------------------------- | -------------------------- | -------------------------------------- |
| `conflict-proposal` | as soon as detected, within 14 days      | morning of                 | stack, then interrupt on the day       |
| `leave-by`          | drive time + 10 min before               | none                       | interrupt                              |
| `school-day-change` | evening before (Sunday for a whole week) | morning of                 | stack                                  |
| `break-coverage`    | 14 days before                           | 3 days before              | weekly review, stack                   |
| `occasion-lead`     | 21 days (idea), 10 days (order)          | 1 day, day of              | weekly review, stack                   |
| `gift-ship-by`      | ship-by minus 3 days                     | ship-by day                | stack                                  |
| `bill-due`          | 3 days before due                        | due day                    | stack                                  |
| `renewal`           | monthly digest                           | 3 days before              | weekly review                          |
| `delivery-today`    | morning of                               | none                       | stack                                  |
| `weather-impact`    | evening before                           | morning of                 | stack                                  |
| `change-digest`     | within 1 hour of the change              | none                       | interrupt when within 24 h, else stack |
| `rsvp-pending`      | 2 days after the invitation              | 3 days before the deadline | stack                                  |

Horizons: candidates within 6 hours may interrupt; candidates within 14 days go to stacks. Calendar diffs cover 14 days (D2). A moved event gets a new key; a cancelled event closes its earlier moments.

## 5. Delivery

| Urgency     | Channels                                                                                           | Rules                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `interrupt` | push; text only for approvals, failures and leave-now                                              | min gap 60 min, at most 6 a day, never in the sleep window except approvals the owner is waiting on |
| `ambient`   | push (silent while the app is open), batched into the next stack                                   | quiet hours, daily cap                                                                              |
| `digest`    | morning stack (after wake), evening look-ahead (non-routine evenings only), weekly review (Sunday) | assembled in code; a model writes the lead line                                                     |
| chat answer | the conversation it was asked in                                                                   | no mirroring (A4), no text (A17)                                                                    |

- The morning stack has 3–7 cards, each saying what changed, why it matters, and one next step.
- Card actions (E4): Add to calendar, RSVP, Text spouse (approval), Snooze, Done, Not useful (with a reason). Actions route through existing tools and approvals; nothing outward happens without approval.
- Feedback (useful, not useful, snooze) adjusts `ownerPreference(kind)`.

## 6. iOS device signals

- **Background refresh**: add `BGAppRefreshTask` (Info.plist `BGTaskSchedulerPermittedIdentifiers`, `fetch` background mode) to publish the calendar snapshot and a location ping, so freshness doesn't depend on the app being open (B3, B5).
- **HealthKit** (B8, opt-in): read sleep analysis, step count and workouts; summarize on the phone into `deviceDaily`; deliver via `HKObserverQuery` with background delivery plus a daily post. Usage strings must explain each type, and Settings needs a per-type off switch.
- **Contacts** (B4, opt-in): `CNContactStore` birthdays, dates and relations → People and occasions, reviewed by the owner before anything is saved.
- **New mobile routes** need: the route under `apps/web/app/api/mobile/v1`, an entry in the Firestore allowlist (`apps/web/proxy.ts`), [firestore-web-route-inventory.md](../firestore-web-route-inventory.md), the runtime support matrix (`pnpm support:matrix:write`), and `APIClient.swift`.

## 7. Evaluation and rollout

- Every new kind ships in **shadow mode** first: candidates are computed and recorded, but not delivered. The benchmark (H1, [golden-signals.md](golden-signals.md)) scores recall, precision and timing before delivery is enabled for that kind.
- Telemetry per kind (H3): produced, held (and why), delivered, dismissed, marked useful, cost.
- Model roles for synthesis are chosen by the role evaluation in [model-evaluation.md](../model-evaluation.md), by cost per successful outcome.
- Each kind has a config flag, so a noisy kind can be turned off without a deploy.
