# Live conversation and proactive-system audit — 7 November 2026

## Evidence reviewed

Read-only inspection after renewed Google Cloud authentication, starting
2026-11-08 05:48 UTC (7 November, Pacific time). Deployment:
`assistant-agent-00803-ned`, Firestore `assistant-production`, installation `assistant`.
The stored owner timezone is `America/Los_Angeles`; the UTC environment default does
not override that record.

- Latest 500 primary-thread messages, October 1–November 7 local time.
- All 1,750 retained email-ingest rows, 2,300 email-observer work rows,
  304 occasions, 293 commitments, schedules and goals.
- Recent source/delivery evidence: 140 ingested emails and 18 recorded accepted
  proactive pings in the seven-day sample. An accepted ping is not proof of device receipt.
- 577 primary-thread task records, with tool-ledger inspection of the November 2
  dentist-draft sequence and November 6–7 restaurant requests.
- Bounded job-history samples, service configuration, current phone-calendar cache
  availability and current location-signal freshness. The general latest-task scan hit
  its 1,000-row cap in approximately fourteen hours, so it is not a seven-day task census.

Raw transcripts and source details stay in ignored, local `.artifacts/proactive-audit/`
files. The production inspection made no data/configuration changes and invoked no models.

## Main conclusion

The assistant has substantial information, but its background readers exclude newly
admitted mail, some promised work never becomes an executed tool call, and source
coverage does not match what it tells the owner. More frequent messages alone would
amplify those defects.

## Verified findings

### 1. Email observation and email use are disconnected

All 140 recent ingest rows were at `message_persisted`. Across the full ledger,
460 direct-mode rows had durably admitted sources: 419 automated bodies and 41
conversation messages. Independent observers had run, but direct ingress never uses
the forwarded-only `completeForwardedIngest` transition. Briefing, pulse, extraction,
obligation and health readers required `complete`, excluding those admitted sources.

The latest extraction jobs consequently reported zero pending messages; the November 7
briefing reported zero mail scanned. Automated-source bodies also live in
`emailObserverSources`, while extraction only looked in conversation messages.

**Local fix:** shared source-readiness rules in both drivers admit authenticated,
durably scored direct sources independently of observer side effects. Extraction reads
the canonical automated body with owner/source identity checks. This makes the existing
backlog eligible without rewriting records, replaying observers or recharging scoring.

**Read-only proof against production with the changed readers:** 460 pending extraction
rows, 23 emails in the current briefing window, and successful body reads for the first
three candidates. No extraction/model call was run against production.

### 2. Automated direct routing misreports normal no-op work as unknown

419 direct-routing observer rows were `unknown` with `observer_error`. The handler
required a conversation before checking whether the source was automated; automated
sources intentionally have no conversation.

**Local fix:** determine the automated no-op before requiring a conversation. Existing
unknown receipts remain historical records; they have not been blindly retried.

### 3. Dates and personal knowledge need stronger grounding

Recent school and soccer messages were scored with 2025 dates despite arriving in
November 2026; stated weekdays fit 2026. The scoring prompt supplied neither the current
date nor the message receipt time. Some ordinary sports reminders were labeled security.

The occasion table contains 258 unconfirmed, non-quarantined assistant-origin rows;
243 rows have consolidation provenance, many assigning different recurring dates to
the owner's contact. These are not 258 verified personal occasions.

**Local fixes:** pass provider receipt time to the classifier, instruct date resolution
against that time, and distinguish an actual security event from an account/login
footer. Upcoming-occasion tools and the briefing now require owner provenance or owner
confirmation. Existing uncertain records remain available for review. Correcting
historically extracted dates requires source-grounded reconciliation, not a blanket
2025→2026 rewrite. Prompt improvements still need live-model date-quality evaluation.

### 4. The conversation repeatedly loses the owner's requested scope

- **October 20–21:** the owner explicitly requested phone-shared work events in the
  briefing. The assistant said they were already included; subsequent briefings omitted
  them. A follow-up work-calendar answer used the wrong day/time offset; after correction
  the assistant asked the owner to clarify instead of completing the fresh lookup.
- **October 24:** a request for things happening in San Francisco was answered from
  private calendars. Clarification asking for city events produced an inbox dump,
  another calendar answer using the wrong year, and repeated asks to restate the request.
- **November 2:** the owner asked for a dentist rescheduling email, then explicitly
  requested a saved Gmail draft. The latter turns have **no draft-tool call at all**.
  “Did you send it?” caused a broad mailbox search, not an action-receipt check. The
  assistant's explanations about personal-mailbox write permissions were not established
  by a failed draft tool call in those turns.
- **November 6–7:** after-game dinner requests produced a neighborhood search/list,
  then successive public-read approvals and a bot-challenge failure. The eventual
  answer still lacked verified opening hours and child suitability.

These examples support a practical response contract: retain the requested source,
date and household context; complete the requested reversible preparation; answer
status questions from execution receipts; and verify useful details rather than end
with another offer to investigate. This change addresses proactive source gathering
and follow-through, not every historical chat-routing defect.

### 5. Active data and configuration do not cover the whole life picture

- `EMAIL_INGEST_MODE` is absent from the live service and therefore defaults to `direct`.
  The forwarded-mode archived-mail improvement from the first audit is not active in
  this deployment. Mailbox mode needs to be explicitly reconciled at release.
- GraphRAG is disabled. Recent graph jobs say “knowledge graph: disabled”; enabling a
  schedule alone does not enable graph recall/curiosity.
- No current phone-calendar sharing record or legacy `phone-calendars:v1:<owner>` cache
  was present at inspection. A current phone sync/selection is needed for work-calendar
  coverage; a server change cannot reconstruct absent EventKit data.
- An active job-offer-monitoring goal has an explicitly disabled runner and stale progress
  from August. Its current relevance and owner pause decision need reconciliation.
- Both retired `morning-brief` and replacement `daily-briefing` schedules remain enabled.
  Their existence is not evidence of complete coverage, and parallel producers need
  explicit reconciliation.
- Location pings exist, including a recent iOS foreground ping, but ambient jobs report
  no fresh location and clear their snapshots. This does not support continuous location
  awareness.

### 6. Open work is remembered but not usefully followed through

The only two open commitments in the complete 293-row set describe the same unsaved
dentist draft, extracted on different nights. Both are undated. The near-deadline pulse
therefore cannot help.

**Local fix:** the briefing surfaces undated promises/waiting-on items after two days,
other undated open loops after a week, and deduplicates identical displayed commitments.
This supplements the previously added personal dates and due/overdue commitments.

## Broader proactive review

The new twice-daily `life-awareness` workflow gathers durable reference context, one
relevant public topic, recent conversations, 14-day calendar coverage and recent/all-mail
searches. It explicitly checks missing work/phone sources and connects family logistics,
preparation, obligations, plans and public developments.

The live approval history exposed a flaw in the first proposed workflow: researching
after reading email would immediately trigger the tainted-session egress gate. The
review now researches before external-source reads. A narrowly bound dispatcher rule
lets the exact shipped, non-external-origin schedule fetch only URLs returned by a
successful search in that same task. New searches under taint, changed URLs, modified
instructions and external-origin schedules remain gated. This reuses the existing
owner public-search-followup discipline rather than granting arbitrary web access.

Notice relevance, cross-source reasoning and cross-run deduplication remain model-driven;
the scheduler, exact-URL rule, source-readiness checks and budgets are enforced in code.

## Health and validation

The health query also required undeployed index shapes. Its email scan now uses the
existing descending date index, and ping counts use the existing owner/delivered/date
index. The changed health reader successfully queried production: **23 scored emails
in 24 hours, 140 in seven days, one pulse moment in 24 hours, three accepted phone pings,
zero held pings and three active push registrations** at inspection.

Regression coverage includes source-readiness parity on PostgreSQL/Firestore, canonical
automated-body extraction, automated routing, briefing/health visibility, occasion
provenance, commitment deduplication and the narrowly scoped public-read capability.
The tests use isolated PostgreSQL and the Firestore emulator; no test writes to production.
Targeted suites passed after correcting two test fixtures (a newsletter mislabeled as
travel and a trusted-human sender used for an automated-mail case) and an invalid mock
memory domain. The final full workspace typecheck, architecture-boundary check and
migration check passed. Changed TypeScript files pass Biome with existing warnings;
the repository-wide lint command still encounters the pre-existing nested-worktree
configuration described in the initial audit.

## Release state and remaining acceptance

Changes are local, uncommitted and **not deployed**. Authentication is working.
The repository's release preflight explicitly refuses local deployment: BASIC5 requires
the protected paired agent/web GitHub `main` workflow with a full source SHA. The
read-only preflight was run and returned that refusal; the gate was not bypassed.

After the protected release, verify backlog reduction, actual briefing mail counts,
one useful multi-source observation, repeat suppression and notification receipts.
Resync the selected phone work calendars, reconcile mailbox mode and paused goal/schedule
intent, and review graph/occasion quality before claiming complete personal awareness.
