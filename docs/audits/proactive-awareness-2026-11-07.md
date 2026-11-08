# Proactive awareness audit — 7 November 2026

Base commit: `728e88488ab4865fe79274019252b36ca4baafca`; implementation is an uncommitted working-tree change.

## Objective and evidence

The owner wants the assistant to notice what matters across email, calendars, people,
birthdays, work, family, travel, current surroundings and relevant news, and connect
those sources before being asked.

This was the initial source-code audit, performed while Google Cloud authentication was
expired. Authentication has since been restored and the [live conversation audit](proactive-live-audit-2026-11-07.md)
records the production evidence, additional fixes and remaining release requirements.

## Findings and changes

| Finding | Evidence | Implemented response |
| --- | --- | --- |
| Inbox-only ingestion misses filtered/auto-archived received mail. | `packages/modules/src/google/email-sync.ts`: history filter, message admission, recovery scan and Gmail watch all required INBOX. | Forwarded-mail observation now includes archived received mail at each boundary. Own outbound mail, sent/drafts, spam and trash remain excluded. Direct assistant correspondence retains its inbox semantics. |
| A low importance score permanently skips memory extraction, even for logistics or personal correspondence. | `packages/core/src/memory/email-extraction.ts`: importance below 3 was stamped as visited without extraction. | Personal and logistics categories now qualify independently of the importance score, within the existing batch/cost limits. This applies to future unprocessed rows; previously stamped rows are not backfilled. |
| Saved birthdays/anniversaries do not wake the daily briefing. | `BriefingInputs` and `briefingHasNews` had no personal dates. Occasion reads existed only elsewhere. | Both storage drivers supply occasions. The briefing selects source-established dates within their configured lead windows (capped at 30 days), compares dates in the owner's timezone, and renders up to six personal dates. |
| Old or undated promises can disappear from proactive attention. | Pulse focuses on near-term due dates; briefing had no commitment input. | Briefing now reads source-eligible open commitments, showing up to five due within a week, overdue, or undated and unchanged for a week. Resolved/dismissed and still-snoozed obligations are excluded. Text says “still open in your records,” not that the owner certainly failed to act. Reads are bounded to the newest 60 eligible commitments. |
| No standing review joins the broader sources. | Briefing is a deterministic digest with a 36-hour calendar horizon; pulse has a six-hour calendar horizon; goal deltas include only recent updates. | A shared `life-awareness` schedule runs at 11:00 and 17:00 in the owner's timezone. It directs the existing tool executor to review memories, active goals including unchanged work, 30-day occasions, 14-day calendars, recent all-mail searches and relevant older threads, then research up to three grounded public topics/destinations. |
| “Aware of my surroundings” can be overstated. | Background location collection is paused; current ambient context expires. | The new review uses fresh available ambient context and confirmed plans separately. It must not turn a calendar destination or old location ping into a claim about where the owner currently is. |

The new schedule is seeded on PostgreSQL and created once by the Firestore maintenance
sweep for existing installations. Existing schedules with the same name, including
paused or owner-edited ones, are preserved. Initial execution is the next scheduled
time, not an immediate sweep-time notification. Each run has a $0.50 task budget and
also uses the existing installation budgets.

The review is a **model-driven workflow**, not a new deterministic no-tools code job.
Its instruction requests source/date-backed observations, specific relevance, one
ambient owner notification with up to three items, comparison with prior notices,
and silence when nothing new merits attention. Those selection and cross-run dedupe
behaviors are prompt-level; the existing executor/tool policies, scheduler occurrence
idempotency, budget checks and phone notification policy remain structural. The
deterministic briefing additions do not rely on the model to discover birthdays or
old commitments.

## Remaining coverage gaps

- Only connected/readable services are visible. The configured Gmail account may
  contain forwarded copies rather than the owner's complete mailbox. No additional
  mailbox or social/relationship integration is connected by these changes.
- Initial Gmail setup establishes a history baseline; it does not import the full
  historical mailbox. New received mail and stale-cursor recovery now have broader
  coverage in forwarded mode. A deliberate historical backfill still needs a durable
  coverage/cursor workflow and a measured backlog budget.
- The awareness review is bounded by its budget and provider paging. It can report
  partial coverage; it cannot truthfully promise it read every message on every run.
- News requires the search module and useful recorded interests/plans. Source-grounded
  relevance and notification quality need live-model evaluation after deployment.
- Relationship maintenance needs a durable last-meaningful-contact signal to support
  reliable “you haven't spoken recently” observations. Memory or a missing email alone
  does not establish this.
- Broad location-triggered planning requires a working, owner-configured location
  signal. This change does not resume background tracking.

## Initial live-audit checklist (completed in the follow-up)

Read the recent primary conversation, scheduled task/tool receipts, schedule enabled
states, email-ingest/extraction lag, connected calendar coverage, source failures and
notification delivery/suppression records. Compare each source-backed opportunity with
what the assistant actually said. Separate unseen input, missing reasoning, stale facts,
repeated notices, and delivery failures. Then verify the deployed review makes useful
connections on realistic work/family/travel examples rather than repeating the agenda.

## Acceptance cases

- A birthday today in UTC+14 is shown today, even while UTC is still December 31.
- A quarantined occasion or unresolved date inference is not presented as an established birthday.
- An overdue promise or old undated school form appears without new mail/calendar activity.
- Resolving or snoozing that commitment removes it from the briefing.
- A low-scored travel confirmation still becomes recallable; personal claims retain their source trust.
- Archived received mail reaches the existing durable observation path exactly as inbox mail does.
- Concurrent Firestore sweeps create one review schedule; an owner pause/edit survives later sweeps.
- A due review creates one ordinary scheduled task, and the same occurrence does not fire twice.

These automated cases validate selection and wiring, not the quality of a real model's
cross-source reasoning or receipt of a phone notification.

## Local validation

Targeted PostgreSQL and Firestore-emulator suites cover the daily briefing, email
extraction, forwarded-mail admission/history/watch coverage, schedule lifecycle and
maintenance sweep. The initial sweep regression exposed a fixture-clock/wall-clock
mismatch; schedule creation now receives the sweep's wall clock and the rerun passed.
The full workspace typecheck, architecture boundaries, migration journal, runtime support
matrix and iOS card-contract checks passed. Changed-file Biome checks have no errors
(one pre-existing test warning).
The repository-wide `pnpm lint` command is blocked by the pre-existing nested root
configuration at `.worktrees/calendar-release-validation/biome.json`.

Changes are local and have not been deployed. The live audit is complete; deployment
requires the protected GitHub release workflow. Live-model notification quality remains
to be validated after release.

Initial implementation source fingerprints, before the live-audit follow-up (SHA-256):

```text
0dd01e2c125f35c169050cff31569e021dcaeff13a9278d24b89995773a17c97  packages/persistence/src/proactive-awareness.ts
eaf32daaff03d30f6fb87115b0951e37c8e5bedbb17f9bd35f00363c36208614  packages/core/src/proactive/life-context.ts
ced80bd6decff1821682b88f1237c4bf395c2e1cbf5419ec1b742e402e870914  packages/core/src/workflow/briefing.ts
23c571556e64be58c8fe2f021eccd6dea86a3ae69c503ee024fe12b7d222b801  packages/core/src/memory/email-extraction.ts
398b4c41260ea989a185fe2ebafcd3ca2c11cbb9f6a3c59e6ab1b2fd71648c56  packages/modules/src/google/email-sync.ts
f00d244765e3e7aec5901596702d20bbfe18f9f70b47199049de3fcdcaec5c9f  apps/agent/src/awareness-schedule.ts
```
