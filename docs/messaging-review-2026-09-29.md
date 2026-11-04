# Email alert review — September 29, 2026

The owner reported that the assistant was too eager to flag incoming email, and that what it asked
for afterwards was not useful. This review audited the 30 most recent messages to reach the owner's
inbox (Sep 29, 01:58–23:49 UTC) against the rules that decide what interrupts them. It then spot-checked
the handful of genuinely important messages from the day before.

This session had no access to the production database, so the stored `email_ingest` verdicts and
chat notices were not read directly. The verdicts below replay each message against the scoring
rubric and the code paths that act on it. Treat them as the behaviour the rubric produced, not as a
copy of the ledger. `pnpm audit:llm --prod --role classify` reads the actual verdicts when capture
is on.

## What the 30 messages were

| Class                                                                                         | Messages | Before                                                     | After                     |
| --------------------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------- | ------------------------- |
| Marketing, newsletters, digests, surveys                                                      |       16 | 1–2, quiet                                                 | 1–2, quiet                |
| Confirmations of one owner action (linking an app to a bank, a brokerage and a health portal) |        7 | 5 each — security/account alert, **7 pings in 21 minutes** | 3, quiet, in the briefing |
| Card payment received, wire transfer submitted                                                |        2 | 4–5 — "money moves"                                        | 3, quiet, in the briefing |
| Annual brokerage standing-instructions notice                                                 |        1 | 4 — financial, "Important" in subject                      | 3                         |
| Same-day reminder for an event already on the calendar (sent twice)                           |        2 | 4 — appointment, dated today, **2 pings**                  | 3, quiet                  |
| Small subscription receipt, shipment notice                                                   |        2 | 2–3                                                        | 2–3                       |

About 12 of the 30 cleared the interrupt threshold (4) under the old rubric. None of them needed the
owner to do anything. In the old rubric, "security and account alerts, anything where money moves,
travel and appointment confirmations" were all HIGH regardless of whether anything was asked of the
owner. Nothing in code held the model to its own `actionable` verdict.

The day before held the real positives: a person following up to ask the owner for their
availability, and a set of invitations for scheduled calls. Both should still reach the owner, and
still do. The follow-up now arrives as _"Email from ‹name›: “‹subject›” / Next: Send updated
availability"_ instead of _"Important email from ‹address›"_. The three invitations came from one
sender within a minute, so they now produce one alert instead of three.

## Where each email could reach the owner, and what changed

1. **Arrival alert** (`email-sync.ts`, importance ≥ `EMAIL_INGEST_NOTIFY_THRESHOLD`).
   - The rubric now reserves 4–5 for mail that needs the owner to _do_ something. Confirmations,
     receipts, sign-in and linked-app notices, reminders, standing notices and new bookings are 3.
     Their dates are still extracted.
   - `calibrateImportance` enforces the rule in code. A message the model marks not actionable,
     or that says "no further action is required" / "you're all set" / "nothing more you need to
     do", is held at 3. This can only lower a score, so a sender can quiet their own message but
     never raise it.
   - The alert leads with the sender's display name and a short `nextStep` written for the owner,
     instead of "Important email from" and a raw address.
   - The same sender alerts at most once per two hours, so a bank confirming three steps of one
     transfer is one ping.
2. **Pulse "second look"** (`pulse.ts`). This used to re-announce the same email as "Email needs
   attention" about an hour after the arrival alert. It now waits until the mail is at least three
   hours old. The card reads "Still open". The offer depends on who wrote:
   - For a person: "Draft a reply to ‹name›?", with a _Draft reply_ button.
   - For anything else: "Check what “‹subject›” needs from you?"

   Previously every email got "Review … and suggest next steps?", which asked the owner to
   commission a summary of mail they had already been told about.
3. **Triage task** (`context-helpers.ts`, forwarded ingest). The prompt now rules out
   `owner.notify` for confirmations of the owner's own actions, receipts, no-action sign-in notices
   and calendar reminders. A notification that does go out has to lead with what to do and by when,
   in one or two sentences. It may not restate the subject or ask something the model could look up.
4. **Briefing**. Unchanged. It still lists importance ≥ 3, so everything held back above remains
   visible once a day instead of as a ping.

## Not changed

- `EMAIL_INGEST_IMPORTANCE_THRESHOLD` (3) and `EMAIL_INGEST_NOTIFY_THRESHOLD` (4) keep their
  defaults. The tuning is in what earns a 4, not in where the line sits.
- A submitted wire transfer now scores 3, because it confirms something the owner did. If the owner
  would rather hear about every large transfer as it happens, that is better expressed as a watch
  than as a lower bar for every bank notice.
- The per-sender throttle is in memory, like the unauthenticated-sender notice. Two agent instances
  can each alert once, which beats a lost alert.

## Verification

Unit and Postgres-backed integration tests cover the calibration, the notice wording, the
pulse age window, the category-specific suggestions and the _Draft reply_ label, including a subject
that quotes the template's own tail. The Firestore pulse test gained a just-arrived message that must
not be re-announced.
