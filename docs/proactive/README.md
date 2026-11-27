# Proactive assistant program

Engineering companion to the proactive-assistant plan. It gives a coding agent what it needs to pick up one work item cold: how the system behaves today, where each defect lives, the target design, and a brief per item with acceptance criteria.

The product plan itself (goals, priorities, decisions, the owner's real-data benchmark) is kept privately by the owner. **This repository is public: nothing in these documents, in fixtures, or in commit messages may contain the owner's personal data.** Use the synthetic household in [golden-signals.md](golden-signals.md).

## Documents

| Document                               | Read it when                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [current-system.md](current-system.md) | Before touching any proactive code: schedules, sources, producers, delivery, costs, and every known defect with its root cause |
| [target-design.md](target-design.md)   | Before adding a collection, a moment kind, a delivery rule or a device signal                                                  |
| [phase-0-briefs.md](phase-0-briefs.md) | Working on a Phase 0 item (A1–A5, A7, A10, A11, A13, A15–A17, H4)                                                              |
| [backlog.md](backlog.md)               | Working on any later item; promote it to a full brief first                                                                    |
| [golden-signals.md](golden-signals.md) | Building or extending the benchmark (H1, H2), or writing fixtures                                                              |

General repository rules are in the root [`AGENTS.md`](../../AGENTS.md). Package boundaries are in [architecture.md](../architecture.md); the anticipation design that the pulse and briefing came from is in [anticipation-layer.md](../anticipation-layer.md).

Already merged and reflected here:

- **#910** connected admitted mail and life context to the proactive readers. It added the `life-awareness` review, owner-confirmed occasions and open commitments in the briefing, and the mail-readiness fix. Background is in the Nov 7 [awareness audit](../audits/proactive-awareness-2026-11-07.md) and [live audit](../audits/proactive-live-audit-2026-11-07.md).
- **#934** admitted the estimated-cost routes in Firestore mode (part of A9).

## How to work an item

1. Read the item's brief and the sections of `current-system.md` it links to.
2. Re-verify every `file:line` reference against current `main`; the briefs were written against `dca4009` (Nov 18, 2026).
3. Implement behind the existing seams: persistence ports in `packages/persistence`, both drivers (`packages/db` for PostgreSQL with a Drizzle migration, `packages/firestore` for Firestore), and the shared contract suite when the port has one.
4. Add the tests the brief names. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:firestore` when Firestore code changed.
5. One item per pull request. In the description: the item ID, what changed, how it was verified, and what remains.
6. Update the item's row below.

Never test against the production installation. Use the Firestore emulator, the disposable PostgreSQL target that `pnpm test` allocates, and scripted-model tests.

## Phases

| Phase                        | Weeks | Gate to leave the phase                                                                                                                                                  |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Unblock                   | 1     | Brief delivered 7 of 7 days; no reply leaks into the primary chat; cost holds under 25% of the daily cap; email extraction above 0 per day; no texts for routine answers |
| 1. See                       | 2–3   | Household calendars connected; weather every day; occasions confirmed by the owner; QA data purged                                                                       |
| 2. Understand                | 3–5   | Email classification at least 90% correct on a labelled sample; at least 95% of family events matched to a person; paid bills close themselves                           |
| 3. Act like a chief of staff | 5–7   | Benchmark recall at least 70% and precision at least 70%; morning stack arrives after wake                                                                               |
| 4. Know you                  | 7–9   | Sleep-aware delivery; daily news digest without approvals; weekly reconnect suggestions                                                                                  |
| 5. Learn and plan            | 9–10+ | Recall at least 80%; at least 70% of delivered cards marked useful                                                                                                       |

Critical paths: A1 → A11 → C2 → D7 (money) and B2 → C6 → D3 (conflict proposals).

## Engineering handoff · 2026-11-19

- Budget visibility, parked-work recovery, and briefing continuity. [A1 settlement](https://github.com/bmson/assistant/pull/949), [A2 wake](https://github.com/bmson/assistant/pull/954), [A3 watchdog](https://github.com/bmson/assistant/pull/960), [A3 recovery window](https://github.com/bmson/assistant/pull/970), [A10 legacy brief retirement](https://github.com/bmson/assistant/pull/956).
- Chat isolation, checklist deduplication, and self-repair pacing. [A4 private replies](https://github.com/bmson/assistant/pull/948), [A5 checklist](https://github.com/bmson/assistant/pull/944), [A7 pacing](https://github.com/bmson/assistant/pull/947), [A15 originating turn](https://github.com/bmson/assistant/pull/965), [A15 read isolation](https://github.com/bmson/assistant/pull/969).
- Intake health, local time, weather evidence, and urgent delivery. [A11 mail pipeline](https://github.com/bmson/assistant/pull/957), [A13 owner time](https://github.com/bmson/assistant/pull/952), [A13 Pulse time](https://github.com/bmson/assistant/pull/968), [A16 weather](https://github.com/bmson/assistant/pull/945), [A17 urgent SMS](https://github.com/bmson/assistant/pull/950), [H4 canaries](https://github.com/bmson/assistant/pull/966).

The Phase 0 gate requires seven actual days of evidence covering daily briefing delivery, chat isolation, cost holds under 25% of the daily cap, extraction on days with eligible mail, and zero texts for routine replies. Record owner and household opt-ins before using their optional sources or delivery channels.

The local H1 replay at `2dda415724793cb713f7489baabbcd8fea8fd400` covered six of 28 synthetic scenarios on both PostgreSQL and Firestore. Five passed, and S08 recorded a missing revised-date stack item. Each driver measured 7/8 recall, 7/7 precision, and zero quiet violations. The remaining 22 scenarios are unimplemented. Production recall remains unmeasured. [H1 replay](https://github.com/bmson/assistant/pull/972), [D7 bill timing](https://github.com/bmson/assistant/pull/974), [scorecard and coverage](golden-signals.md#running-the-replay).

## Status board

Status values: `open`, `in progress`, `in review`, `done`. Size: S ≤ 1 day, M 2–4 days, L 1–2 weeks.

| ID  | Item                                                                   | Phase | Size | Depends on | Status                                                        |
| --- | ---------------------------------------------------------------------- | ----- | ---- | ---------- | ------------------------------------------------------------- |
| A1  | Reconcile cost holds; holds scoped to their period                     | 0     | L    | —          | in review (settlement and period-specific Costs warning)      |
| A2  | Wake parked work when caps change; honest parked notice                | 0     | M    | —          | in review (cap-change wake and recorded spend/holds notice)   |
| A3  | Outage watchdog and "while I was away" digest                          | 0     | M    | H4         | in review (outage alert and recovery by source receipt time)  |
| A4  | Stop mirroring secondary-chat replies into the primary chat            | 0     | M    | —          | in review (private answer-ready push)                         |
| A5  | Checklist dedupe ignores trailing punctuation                          | 0     | S    | —          | in review                                                     |
| A6  | Guard against promises without a tool call                             | 2     | M    | —          | in review (cancel and delete receipt checks)                  |
| A7  | Self-repair cadence respects its daily limit                           | 0     | S    | —          | in review (keep follow-ups due at the daily dispatch limit)   |
| A8  | Truthful "Needs you" count; archive needs_attention in Firestore       | 1     | M    | —          | in review (consistent counts and attention archival)          |
| A9  | Firestore parity for every route the phone calls                       | 1     | M    | —          | in review (native route and method checks)                    |
| A10 | Retire `morning-brief` in Firestore                                    | 0     | S    | —          | in review                                                     |
| A11 | Email pipeline: verify #910, census, stall alert                       | 0     | M    | —          | in review (forwarded extraction, census and stall alerts)     |
| A12 | Isolate QA from production; purge QA data                              | 1     | M    | —          | in review (owned disposable smoke target and QA inventory)    |
| A13 | Owner time zone in every card                                          | 0     | S    | —          | in review (owner time in calendar, briefing and Pulse cards)  |
| A14 | Brief calendar answers                                                 | 1     | M    | —          | in review (compact agenda and calendar recovery)              |
| A15 | Each turn answers its own message                                      | 0     | M    | —          | in review (originating turns and independent read requests)   |
| A16 | Weather plausibility                                                   | 0     | S    | —          | in review (daily, current and hourly snow evidence)           |
| A17 | Texts only for urgent items                                            | 0     | S    | —          | in review (urgent SMS quota and retry checks)                 |
| B1  | Calendar connection health and warning                                 | 1     | S    | —          | open                                                          |
| B2  | Household calendar setup and classification                            | 1     | M    | B1         | open                                                          |
| B3  | Reliable iPhone calendar snapshots                                     | 1     | M    | —          | open                                                          |
| B4  | iPhone Contacts import (opt-in)                                        | 4     | M    | C4         | open                                                          |
| B5  | Places and home-place weather fallback                                 | 1     | M    | —          | open                                                          |
| B6  | Weather at each outdoor event's place and time                         | 1     | S    | B5         | open                                                          |
| B7  | News profile and feeds; public reads without approval                  | 4     | M    | —          | open                                                          |
| B8  | HealthKit sleep and activity (opt-in)                                  | 4     | L    | G2         | open                                                          |
| B9  | Mail coverage and ingest health                                        | 1     | M    | A11        | open                                                          |
| C1  | Typed `signals` store                                                  | 2     | L    | —          | invoice/payment contract in review                            |
| C2  | Email taxonomy v2 and extractors                                       | 2     | L    | A11, C1    | in review (#910, plus authenticated practice-change evidence) |
| C3  | Close obligations by evidence                                          | 2     | M    | C1, C2     | open                                                          |
| C4  | People cleanup                                                         | 1     | M    | —          | in review (chat and extraction identity safeguards)           |
| C5  | Rebuild occasions                                                      | 1     | M    | C4         | open (#910: only confirmed occasions surface)                 |
| C6  | Household model and who-an-event-is-for                                | 2     | L    | B2         | open                                                          |
| C7  | Time-off and coverage model                                            | 2     | M    | C6         | open                                                          |
| C8  | Relationship cadence                                                   | 4     | M    | C4         | open                                                          |
| D1  | Moment framework v2 (scoring, horizons, lead policy)                   | 3     | M    | C1         | open                                                          |
| D2  | 14-day change detection and change digest                              | 3     | M    | D1         | open                                                          |
| D3  | Conflict proposals                                                     | 3     | L    | C6, D1     | open                                                          |
| D4  | Leave-by with live traffic                                             | 3     | M    | B5, D1     | open                                                          |
| D5  | Weather impact on outdoor events                                       | 3     | M    | B6, D1     | open                                                          |
| D6  | Occasions and gifts                                                    | 3     | M    | C5, D1     | open                                                          |
| D7  | Money: bills, renewals, unusual charges                                | 3     | M    | C2, C3     | in progress (owner-local bill timing and payment evidence)    |
| D8  | School: early dismissal, closures, breaks, forms                       | 3     | M    | C6, C7     | open                                                          |
| D9  | Home and car: deliveries, maintenance                                  | 3     | S    | C2         | open                                                          |
| D10 | Weekly reconnect suggestions                                           | 4     | S    | C8         | open                                                          |
| D11 | Personal news digest                                                   | 4     | M    | B7         | open                                                          |
| D12 | Sleep-aware delivery                                                   | 4     | M    | B8         | open                                                          |
| D13 | Proposed situation packs                                               | 5     | M    | C7         | open                                                          |
| D14 | Grounded dream anticipations become moments                            | 5     | S    | D1         | open                                                          |
| E1  | Morning stack on wake                                                  | 3     | M    | D1         | open                                                          |
| E2  | Evening look-ahead as a code job                                       | 3     | M    | D1         | open                                                          |
| E3  | Weekly review and monthly renewals                                     | 5     | S    | E1         | open                                                          |
| E4  | Card actions                                                           | 3     | M    | —          | open                                                          |
| E5  | Proactive settings and Noticing health card on iOS                     | 3     | M    | H4         | in progress (source and producer health on the phone)         |
| E6  | Internal notices out of the owner's chats                              | 3     | S    | A4         | open                                                          |
| E7  | Per-person and per-day views                                           | 4     | M    | C6         | open                                                          |
| E8  | Actionable push notifications                                          | 4     | M    | E4         | open                                                          |
| E9  | More shows only meaningful automations                                 | 3     | S    | A10        | in review (native Automations list)                           |
| F1  | Tools: `memory.forget`, `contacts.update`, `occasions.update`/`delete` | 2     | M    | —          | open                                                          |
| F2  | Routing: topic watches, digests, cancel and delete paths               | 2     | M    | —          | open                                                          |
| F3  | Reply integrity                                                        | 2     | M    | A4         | open                                                          |
| F4  | Dictated email bodies stay verbatim                                    | 2     | S    | —          | open                                                          |
| F5  | Follow-up context and spoken register                                  | 5     | M    | A15        | open                                                          |
| F6  | Model evaluation for proactive jobs                                    | 4     | M    | H1         | open                                                          |
| F7  | Relative dates in every calendar and mail path                         | 2     | S    | —          | in review (spelled day and week intervals)                    |
| G1  | Sensitive-topic filter                                                 | 4     | M    | —          | in review (booking lookup and briefing candidate)             |
| G2  | Health data minimization                                               | 4     | M    | —          | open                                                          |
| G3  | Permissions live in policy, not memory                                 | 5     | S    | —          | open                                                          |
| G4  | Household consent and visibility                                       | 5     | S    | B2         | open                                                          |
| H1  | Golden-signal benchmark harness                                        | 3     | L    | —          | in progress (6 of 28 measured on both drivers)                |
| H2  | Weekly missed-signal audit                                             | 5     | M    | H1         | open                                                          |
| H3  | Proactive telemetry                                                    | 5     | M    | —          | open                                                          |
| H4  | Daily canary                                                           | 0     | S    | —          | in review (25% alert and overall iPhone health status)        |
