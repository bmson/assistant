# Golden-signal benchmark

The measure of the program: given one realistic week of a household's calendars, mail, weather and device data, which of the things a diligent human assistant would raise does the assistant raise, on time, without noise? H1 builds the harness; H2 adds scenarios every week from real misses.

## Privacy rule

**Fixtures are synthetic.** The scenarios below are modelled on a real household's week, but every name, place, amount and date is invented or generalized. Never paste real email, calendar entries, contacts, health data or production exports into this repository; it is public. The owner's real-data audit (H2) runs inside the owner's installation, and only its scores leave it.

## Synthetic household

| Role           | Fixture ID    | Details                                                                           |
| -------------- | ------------- | --------------------------------------------------------------------------------- |
| Owner          | `owner`       | Works weekdays; joins evening meetings with another time zone; on an on-call rota |
| Spouse         | `spouse`      | Own calendar, shared with the owner; runs a weekend market stall                  |
| Child A        | `childA`      | 12, middle school; sports club                                                    |
| Child B        | `childB`      | 7, elementary school; swim lessons; day camp during breaks                        |
| Owner's parent | `parent`      | Lives nearby; birthday on day 0                                                   |
| Grandparent    | `grandparent` | Lives abroad; turns 89 on day 27; gifts need international shipping               |

Time zone `America/Los_Angeles`. Day 0 is a Wednesday. The harness resolves relative times such as `D+1T08:05` against a base date chosen per run.

## Fixture format

```jsonc
{
  "version": 1,
  "timeZone": "America/Los_Angeles",
  "baseWeekday": "wednesday",
  "household": [{ "id": "childA", "role": "child", "age": 12, "schoolId": "school-middle" }],
  "places": [{ "id": "home", "kind": "home", "lat": 37.7, "lng": -122.4 }],
  "calendars": [
    {
      "id": "family",
      "class": "household",
      "events": [
        { "id": "e1", "title": "Child A - Medical", "start": "D0T14:50", "end": "D0T15:20" },
        {
          "id": "e2",
          "title": "Child B: School conference",
          "start": "D0T15:10",
          "end": "D0T15:30",
          "location": "School (elementary)"
        }
      ]
    }
  ],
  "mail": [
    {
      "id": "m1",
      "receivedAt": "D-7T10:00",
      "from": "club@example.org",
      "subject": "Practice moved",
      "body": "…"
    }
  ],
  "weather": {
    "daily": [{ "day": "D+1", "code": 63, "precipitationProbability": 91, "min": 8, "max": 13 }]
  },
  "device": { "sleep": [{ "night": "D-1", "asleep": "D-1T23:10", "wake": "D0T06:42" }] },
  "expected": [
    {
      "id": "S03",
      "kind": "conflict-proposal",
      "subjects": ["childA", "childB"],
      "deliverWithin": ["D0T06:42", "D0T09:00"],
      "channel": "stack",
      "mustMention": ["overlap", "who is free"]
    }
  ],
  "mustStayQuiet": [{ "id": "S14", "about": "paid bill", "forbidKinds": ["bill-due"] }]
}
```

Put fixtures in `packages/tools/src/proactive-benchmark/fixtures/` next to the question-regression harness.

## Harness (H1)

1. Load a fixture into the Firestore emulator, or the disposable PostgreSQL target, through the normal persistence ports.
2. Advance a fake clock in 20-minute ticks across the week. On each tick, run the code jobs exactly as the scheduler would: `pulse.check`, `ambient.refresh` (with fixture weather), `briefing.compose`, the evening look-ahead, `email.extract`, and any new producer.
3. Run model tasks such as `life-awareness` and `tomorrow-check` with scripted models only; make no provider calls. Model wording is not scored.
4. Capture every delivered moment from the `proactiveMoments` ledger and the notifier legs.
5. Score the results and write `benchmark-result.json` plus a Markdown summary.

**Scoring.**

- **Recall**: expected moments delivered inside their window, divided by expected moments.
- **Precision**: delivered moments that match an expectation, divided by delivered moments. Unmatched deliveries are listed for review; a reviewer may add them as new expectations.
- **Timing**: a delivery counts only inside `deliverWithin`.
- **Quiet violations**: any forbidden kind delivered for a `mustStayQuiet` scenario.
- **Channel**: a moment that interrupts when it should batch, or the reverse, scores half.

Run it in CI with no network. Record the baseline before Phase 3 starts; the phase-3 gate is recall ≥ 70% and precision ≥ 70%.

## Scenarios

Modelled on one real week. Production on Nov 18, 2026 raised one of them (S17).

| ID  | Signal (source)                                                                                      | Expected                                                                   | Window and channel                     |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| S01 | Owner's parent's birthday today (spouse's calendar)                                                  | `occasion-lead` day-of: "call them"                                        | Morning stack                          |
| S02 | Grandparent abroad turns 89 on D+27                                                                  | `gift-ship-by` about D+13 (international shipping), then T-1 and day-of    | Weekly review, stack                   |
| S03 | Child A medical appointment 14:50 (no location) overlaps Child B school conference 15:10 (at school) | `conflict-proposal` naming who is free, plus `leave-by` for the conference | Morning stack; leave-by interrupt      |
| S04 | Early dismissal all week at the elementary school (all-day school-calendar event)                    | `school-day-change` with the pickup time                                   | Evening before the week, then mornings |
| S05 | School break D+5 to D+9; public holiday D+8; day camp D+5 to D+7 only                                | `break-coverage`: "D+9 has no cover"                                       | D-9 (T-14), weekly review              |
| S06 | Spouse's evening event D+1 17:45–21:15 overlaps owner's 20:05 work meeting                           | `conflict-proposal`                                                        | Evening before                         |
| S07 | Child A student-led conference D+1 14:30 at school, inside the owner's work block                    | Heads-up and `leave-by`                                                    | Evening before; interrupt              |
| S08 | Store delivery moved to D+1 (email)                                                                  | `delivery-today`: "is someone home?"                                       | D+1 morning stack                      |
| S09 | Rain 100% D0, 91% D+1, 75% D+3; spouse's outdoor market stall D+3 to D+4                             | `weather-impact`                                                           | Evening before                         |
| S10 | D+5 09:00 specialist appointment across town vs Child B camp drop-off 08:45 elsewhere                | `conflict-proposal` with travel times                                      | D+3, then the morning of               |
| S11 | Owner on call: secondary D+11, primary D+15                                                          | Week-ahead note against family plans                                       | Weekly review                          |
| S12 | Car service overdue (six reminder emails) and a missed dealer appointment                            | `vehicle-service` once, with a booking link                                | Weekly review                          |
| S13 | Phone bill ready (due D+14); toll statement                                                          | `bill-due`                                                                 | T-3                                    |
| S14 | Lab bill paid (payment confirmation)                                                                 | **Stay quiet**; close the "bill to pay" fact                               | —                                      |
| S15 | Domain price change; cloud storage renews D+29                                                       | `renewal`                                                                  | Monthly digest                         |
| S16 | Sports practice moved 16:30 → 17:30, new field (email, D-7)                                          | `change-digest`, classified as a schedule change, not security             | Within 1 hour of arrival               |
| S17 | A training session cancelled (calendar)                                                              | `calendar-cancelled`                                                       | Within 20 minutes                      |
| S18 | Party invitation awaiting RSVP                                                                       | `rsvp-pending` with one-tap RSVP                                           | 2 days after arrival                   |
| S19 | Weekend party: spouse away, owner takes both children (email thread)                                 | Add to calendar and logistics; **no** redundant reply to the host          | When the thread settles                |
| S20 | Relatives sent a gift card                                                                           | `thank-you`                                                                | Within 3 days                          |
| S21 | Owner rescheduled the dentist by email                                                               | `commitment-closed` for the open "email the dentist" items                 | Same day                               |
| S22 | School art order deadline D+2 (newsletter)                                                           | School deadline                                                            | T-2                                    |
| S23 | "Anniversary lunch" on last year's calendar                                                          | Anniversary stored and confirmed (a data check, not a moment)              | —                                      |
| S24 | Three unread emails from Child A's teachers                                                          | `mail-action`                                                              | Next morning                           |
| S25 | National holiday abroad on D+13, plus international shipping cutoffs                                 | Holiday plus shipping lead time                                            | T-21                                   |
| S26 | Parents' association meeting tonight 19:30 (video call)                                              | Optional reminder                                                          | 30 minutes before                      |
| S27 | Wake at 06:42 (sleep data)                                                                           | Morning stack after wake                                                   | Within 15 minutes of wake              |
| S28 | Personal news: home city, home country abroad, technology                                            | `news-digest`, at most 5 items                                             | Morning stack                          |

S14 tests quiet; S19 tests both an action and restraint; S23 checks data. The remaining 25 scenarios each expect a delivered moment.

## Running the replay

With a local PostgreSQL test server and the Firestore emulator running, set `TEST_DATABASE_URL` to the loopback PostgreSQL connection and `FIRESTORE_EMULATOR_HOST` to the emulator address. Run `pnpm test:proactive-replay`. The command writes a Markdown scorecard and JSON evidence in `.artifacts/proactive-replay/`.

The current slice measures delivery timing for S13, S16, S17 and S24, and suppression after a source-matched payment for S14. It reads durable cards and ledger acknowledgments from a simulated push service. S13 measures each unpaid source on arrival day and again three days before its due date. Its same-day arrival control and S14's pre-payment setup confirm that a bill can be delivered. S24 checks an early sweep before the minimum source age, three next-morning sweeps, and a repeat sweep while the mail is still recent. Those controls and the generic-mail control are excluded from recall and precision.

In the frozen timing run at `a9961850f5e99b4e848f2b0af4e889ee92987018`, both S13 invoices stayed quiet on their arrival-day sweep at +4 hours. Each produced one exact-source notice at 09:01 owner-local time three days before it was due, 11 days after arrival. The same-day control produced one notice at 13:01. In S14, the wrong receipt left the invoice due, and the matching receipt closed it without a new notice. Both storage drivers recorded 7 of 7 on-time deliveries with zero quiet violations across the five covered scenarios.

The scorecard distinguishes replay validation from product results. S13's lead-time findings are recorded as product outcomes, while the fixture and same-day control remain required in CI. The scorecard lists each scenario and driver. A covered case has replay evidence with a pass or fail result. An implemented case without evidence is awaiting evidence. The remaining scenarios are unimplemented. Production recall remains unmeasured.

## Adding scenarios (H2)

The weekly audit in the owner's installation compares sampled real data with delivered moments and lists the top misses. For each miss, write a **synthetic** scenario that reproduces its shape (who, when, which source, expected kind, window) and add it here with a new `S` number. Never copy the original text.
