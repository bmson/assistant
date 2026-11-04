# LLM response quality and proactivity review

A review of everything the installation can expect to come out of a model: what
is asked for, what comes back, what checks it, and what the owner ever sees. It
was commissioned to answer two questions — why answers are sometimes wrong or
badly formed, and why the assistant is quieter than its design documents claim.

Grounded in the code as of "Port task creation and durable queue dispatch behind
persistence contracts" (#127).

**Coverage.** All five planned tracks completed: the synchronous response path,
inbound signal (mail/calendar/SMS/push/location), the proactive layer,
memory/context assembly, evaluation coverage, and a full model-call inventory.

## Verdict

The engineering here is not weak. `groundReadDraft`, the unsupported-claim regex
family, `validateGroundedCard`, `enforceUrlProvenance`, the request checklist and
the fact-quarantine rules are real, code-based guarantees of a kind most
assistants do not have.

The gap between the assistant this repository describes and the one an owner
experiences is mostly not missing machinery. **It is machinery that is switched
off by default, next to one legacy surface that fires unconditionally.**

Four defaults, each individually reasonable, compound into "quiet when it should
speak, noisy when it shouldn't":

| Default                                                                                                            | Consequence                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_INGEST_MODE=direct` (`packages/config/src/index.ts:215`)                                                    | The table every mail-driven proactive surface reads stays empty — pulse mail moments, importance alerts, briefing highlights, `email.extract` all inert                                                                                                              |
| `CHAT_RECALL_ENABLED=false` in the schema (`config/src/index.ts:272`, via `booleanString` → `'false'` at `:24-27`) | Automatic recall never runs **on a local or Docker install**. Cloud Run deployments are unaffected: `deploy.sh:394-395` resolves an unset value to `true`, so a provisioned installation has recall on. Verified on the reference deployment — it was already `true` |
| `GRAPH_RAG_ENABLED=false` (`config/src/index.ts:278`)                                                              | GraphRAG and the daily `graph.curiosity` question are permanent no-ops, and nothing reports it                                                                                                                                                                       |
| `morning-brief` seeded enabled (`packages/db/src/seed.ts:196-205`)                                                 | A second, older brief fires at 07:30 — 15 minutes before `daily-briefing` at 07:45 — through the full model/tool loop, with **no self-silence clause**, so it messages every morning regardless of whether anything happened                                         |

So the three most-cited quality complaints have the same shape as each other and
as the September audit's: the capability exists, is tested, is documented as
shipped — and is off, or duplicated, in the configuration that actually ships.

Beyond the defaults, two structural findings stand:

1. **Factual grounding is strong where it was built and absent where it was not.**
   Calendar and email answers are verified word-by-word against the tool ledger.
   Web and weather answers — the categories that failed the September audit — have
   no deterministic check at all.
2. **Nothing recorded what the model actually said.** `model_calls` stored cost
   and token counts, not prompts or outputs, so no production quality question was
   answerable from data. (Addressed on this branch — see
   [reviewing what the models said](../llm-output-review.md).)

## 1. One seam, thirty surfaces

Every model call in the application goes through `ModelRouter`
(`packages/core/src/model-router/router.ts`). Its entire generative API is
`generate` (:601), `stream` (:655), `step` (:750), `object` (:870) and `embed`
(:978), over eight roles (`ModelRole`, :25).

Thirty generative call sites exist. The ones on the owner-visible path:

| Surface                  | file:line                                                          | Role     |
| ------------------------ | ------------------------------------------------------------------ | -------- |
| Chat reply (primary)     | `packages/application/src/chat-turn.ts:596`                        | draft    |
| Chat needs-action triage | `packages/application/src/chat-turn.ts:389`                        | classify |
| Agent step loop (×4)     | `packages/core/src/workflow/executor/step-loop.ts:757,813,853,882` | dynamic  |
| Planner — plan           | `packages/core/src/workflow/planner.ts:231`                        | plan     |
| Planner — trivial triage | `packages/core/src/workflow/planner.ts:215`                        | classify |
| Output verification      | `packages/core/src/workflow/output-verification.ts:142`            | rewrite  |
| Briefing compose         | `packages/core/src/workflow/briefing.ts:671`                       | draft    |
| Watch suggest            | `packages/core/src/workflow/watch-suggest.ts:72`                   | draft    |
| Email importance         | `packages/modules/src/google/email-importance.ts:169`              | classify |
| Email automated triage   | `packages/modules/src/google/email-sync.ts:331`                    | classify |
| Email extraction         | `packages/core/src/memory/email-extraction.ts:190`                 | extract  |
| Commitment extraction    | `packages/core/src/memory/commitments.ts:125`                      | extract  |

The remaining eighteen are memory, card, browse, mission, dream, improve,
self-maintenance, skill-reflect and voice surfaces.

That a single class sees all thirty is the most useful architectural fact in the
codebase for this purpose: quality instrumentation needs one seam, not thirty.

### Surfaces that contain no model at all

The two highest-frequency proactive producers are deterministic:

- `packages/core/src/proactive/pulse.ts` — the `*/20 * * * *` job. Its own comment
  at :121 reads _"What the owner is told. Deterministic: no model composes this."_
- `packages/core/src/proactive/curiosity.ts` — gaps come _"from rows, never from a
  model's imagination"_ (:13).

`calendar-salience.ts`, `arrival.ts` and `nudge-policy.ts` are likewise pure code.

This is a deliberate and defensible safety design: a code job holds no tools, so
untrusted mail cannot act, and nothing can invent urgency. It is also the likely
reason proactive messages read as templated. The improvement that preserves the
property is narrow — let a model **phrase** what deterministic code **decided**,
never let it decide. `briefing.ts` already works exactly this way (`briefing.ts:33`:
the model _"is never asked what it"_ — the notes are assembled first), so the
pattern exists in-repo and does not need inventing.

## 2. The default mail mode is the proactivity bug

`EMAIL_INGEST_MODE` defaults to `direct` (`packages/config/src/index.ts:215`,
`.env.example:204`).

The only production writer of the `email_ingest` table is `email-sync.ts:617`,
inside `processForwardedIngest` — the **forwarded**-mode path. In `direct` mode
that table is never written.

Everything mail-driven and proactive reads that table:

| Consumer                          | Reads                         | Effect in `direct` mode |
| --------------------------------- | ----------------------------- | ----------------------- |
| Pulse mail-action moment          | `pulse.ts:376`                | never fires             |
| Importance scoring                | `email-importance.ts`         | never runs              |
| Deterministic important-mail ping | `email-sync.ts:661-672`       | never fires             |
| `email.extract` memory job        | `email-extraction.ts:141-154` | walks an empty table    |
| Briefing mail highlights          | `briefing.ts`                 | nothing to highlight    |

So in the shipped default, the assistant's only reaction to mail is to drop it or
spend a sixteen-step triage task on it. The entire deterministic scoring, notify,
digest and memory pipeline is inert.

Worse, `direct` mode drops automated senders **before any model call**, on this
regex (`email-sync.ts:328`):

```
/no-?reply|notifications?@|newsletter|mailer|donotreply/i
```

That matches most airline, hotel, bank and ticketing senders — exactly the flight
and booking confirmations a personal assistant exists to notice. The message is
discarded with a `console.log`: no ledger row, nothing searchable, nothing
recoverable, nothing the owner can ever see.

`docs/anticipation-layer.md` already names this failure mode in the abstract
("an owner who forwards their inbox here has that mail dropped… the importance
alerts, briefing highlights and proposed dates all silently never happen") and
`proactiveConfigNotes` was built to warn about it. The finding here is stronger
than the doc's: it is not only forwarded inboxes that lose mail, it is the
**default configuration** that disables the pipeline.

**This is the single highest-leverage change available.** It is also a product
decision, because changing a default changes behavior for existing installs —
see the open questions.

## 3. Grounding is strong where built, absent where not

`groundReadDraft` (`response-contract.ts:1325-1516`) verifies a calendar or email
answer against the literal tool ledger: every returned event title must appear,
every stated clock time must match a real event boundary, proper-noun runs must
come from the evidence vocabulary. On failure there is a deterministic template
fallback that cannot lie. This is the best-engineered part of the system and the
model for what is missing elsewhere.

It is reached from exactly one place — `enforcePersonalReadGrounding`, called at
`response-contract.ts:2006` — and only for a `PersonalReadRequest` (calendar,
email, drive, memory, knowledge graph).

`detectLiveLookup` (`live-lookup.ts:8-66`) covers weather and general web facts.
It is imported into `finalize.ts` but has **no grounding counterpart**.
`liveLookupFailure` (:106-118) checks only that a fetch returned a non-empty body
— never that the answer matches it.

The only remaining defense is `verifyFinalOutput`, and it is weaker than it looks:

- It is gated on `canReflect` (`executor/finalize.ts:432-435`), which requires the
  deterministic contract to have found **nothing** wrong — so it runs precisely in
  the case where nothing else caught the problem.
- It runs on `rewrite`, pinned to the cheapest tier (`model-config.ts:104`), the
  same tier as bulk classification — a weaker model reviewing a stronger model's
  work.
- It skips silently on any error or budget block
  (`output-verification.ts:151-152,160-168`).

The September failures (a stale head-of-state answer, a batted-ball statistic
reported as a score) are therefore structural rather than unlucky.

### Formatting is enforced only in the test suite

`grep -c 'fence|```' packages/core/src/workflow/response-contract.ts` returns
**0**. There is no unclosed-code-fence repair, no markdown-shape check, and no
leaked-marker strip for anything but the one `[Background notice…]` echo.

The unclosed-fence and leaked-markup checks the regression suite grades on exist
only at `packages/tools/src/question-regression/harness.ts:84-88` — test-only code.
The suite therefore grades a property the runtime never enforces, which is the
worst of both worlds: a green suite implies a guarantee that does not ship.

## 4. Nothing records what the model said

`model_calls` (`packages/db/src/schema.ts:1232-1251`) stores `role`, `model`,
`input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `finish_reason` and
`openrouter_generation_id`. It does not store the prompt or the response. The
OTel span is `withSpan('model.generate', { role, model })` (`router.ts:616`) —
the same gap.

Consequences:

- No production quality question is answerable from data. "Was last week better
  than the week before" has no source.
- Regressions are invisible until an owner notices one by hand, which is how the
  September audit happened.
- A model or routing change cannot be evaluated against real traffic, only
  against the twenty-seven scripted chat scenarios in the corpus.

These prompts contain the owner's mail and calendar, so the answer is not a naive
log. It needs opt-in capture, redaction of the evidence blocks, a retention
window and local-only storage by default. But some form of it is the
precondition for every other quality improvement here: nothing can be improved
that is not first measured.

## 5. Latency and coverage on the inbound side

Gmail is well covered: Pub/Sub push with OIDC verification, a minute-cadence
scheduler fallback, a distributed lock and a durable cursor. Worst case to
awareness is seconds to a minute.

Calendar is not. There is no `events.watch` push channel, no sync-token or
snapshot table, and no diff of one read against another. Both readers — the
07:45 briefing (36h window) and the pulse (6h window) — take a fresh stateless
snapshot. Google's `status` field is not carried through `RawEvent`
(`packages/tools/src/google/calendar.ts:31-47`) at all.

So these are structurally invisible, not merely slow:

- a meeting cancelled by its organizer
- an invite declined by someone the owner is waiting on
- a recurring instance permanently moved
- the owner's own RSVP changed from another client

And an event added ten hours out falls outside the pulse's six-hour window, so it
is not mentioned until the next morning's briefing — up to about 24 hours.

The pulse is additionally gated by a 60-minute minimum gap and a six-per-day
ambient ceiling shared across every producer (`pulse.ts:53,64`), so a busy mail
morning can silence a same-day cancellation for the rest of the day.

## 6. The proactive layer: two briefs, and switches that are off

`docs/anticipation-layer.md:89-90` states that every proactive producer is
self-silencing. One is not.

Two morning briefs are seeded enabled and fire 15 minutes apart:

| Schedule                             | Cron         | How it works                                                                                                            | Silences itself? |
| ------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `morning-brief` (`seed.ts:196-205`)  | `30 7 * * *` | Full model + tool loop at `trust:'assistant'`, prompt ends "send ONE concise brief via `owner.notify` with `ping=true`" | **No**           |
| `daily-briefing` (`seed.ts:231-233`) | `45 7 * * *` | The `briefing.compose` code job — deterministic assembly, model phrases only                                            | Yes              |

So the owner is pinged every single morning by the older surface whether or not
anything happened, and then potentially again by the newer one. The two do not
share dedup state.

`morning-brief` cannot simply be disabled: `WAKE_BRIEF_SCHEDULE`
(`packages/core/src/workflow/schedules.ts:725`) points at it by name, so the
wake-on-first-app-open path fires _that_ schedule. Retiring it means moving the
wake path to `daily-briefing` first. This is a design decision, not a cleanup.

Two further surfaces are silently inert: `graph.curiosity` never runs because
`GRAPH_RAG_ENABLED` defaults false, and neither `proactiveConfigNotes` nor
`assessProactiveHealth` reports it — the exact "making silence legible" failure
the anticipation doc was written to prevent. There is also no cross-surface
dedup: the pulse and the next morning's briefing use disjoint `sourceRef`
namespaces, so one email can produce two suggestion cards.

## 7. Context assembly: recall is off, and corrections do not stick

`CHAT_RECALL_ENABLED` defaults false **in the configuration schema**, so on a
local or Docker install the model sees the recent message window and whatever it
fetches by tool call, and everything `docs/long-running-chat-memory.md` describes
is inert.

This does **not** apply to a Cloud Run deployment. `deploy.sh:394-395` resolves an
unset value to `true` before provisioning, so a deployed installation has recall
on unless its `.env` says otherwise. The reference deployment was verified as
`true`. An earlier draft of this review reported recall as off everywhere; that
was read off the schema without checking what the provisioner does with it.

Two findings hold even with recall on:

- **`memory.save` is pure append** (`packages/tools/src/builtin/index.ts:92-129`).
  Supersession happens only in a nightly consolidation capped at 12 entities per
  run (`memory/consolidation.ts:92,188`). A corrected fact and the stale one it
  corrects can both reach the model in the same window, same day — the owner
  tells the assistant they have moved, and it keeps citing the old address until
  consolidation catches up.
- **The controlled predicate vocabulary is prompt-only advice.**
  `GraphExtractionSchema.predicate` is free text (`memory/knowledge-graph.ts:51`)
  and `cleanPredicate` normalizes formatting without validating membership
  (`:184-192`), so the graph accumulates synonymous predicates that later
  traversals miss.
- **Recall telemetry measures availability, not relevance.** `recall-metrics.ts`
  and the health monitor detect recall being _down_, never recall being _wrong_,
  and the owner-facing thumbs-up/down in `recall-feedback.ts` is written and
  never read by anything.

Tool schemas (~70-80 tools, `packages/tools/src/dispatcher.ts:245-264`) are the
largest single context block on any action turn, with no cap, no measurement and
no relevance filtering.

## 8. Evaluation coverage

Better than expected in breadth, with two holes exactly where traffic is heaviest.
21 of 24 generative surfaces have scripted-model unit coverage of the actual call.
The uncovered ones are the two busiest: the chat needs-action triage
(`chat-turn.ts:389`) and the tool-less chat reply (`chat-turn.ts:596`) have **no
coverage of any kind**, because both harnesses begin execution only after a task
and plan already exist. Two step-loop retry branches that exist specifically to
catch model misbehaviour (`step-loop.ts:813,853`) are never triggered by any
fixture.

The assertion vocabulary is regex, count and exact-string over
`QuestionCase.expect` (`question-regression/harness.ts:55-116`). It structurally
cannot express "should have asked a clarifying question", "should not have spoken
at all" (an empty answer is always a failure), tone, proactive timing, or
cross-turn non-duplication — which is precisely the vocabulary the proactive
surfaces need.

Nothing requiring a model key runs in CI. There is no LLM-as-judge, no rubric and
no score anywhere: every check is binary pass/fail on hand-written assertions, so
there is no number to track over time.

## 9. What is already right

Stated plainly, because a review that lists only faults misrepresents the system:

- **`groundReadDraft`** — deterministic literal-field verification with a fallback
  that cannot lie. The model for everything else.
- **Unsupported-action-claim detection** (`claimedKinds`, `enforceResponseContract`)
  — broad, carefully tuned, code-based, correctly scoped to the current task.
- **Approval-code fabrication** — fully code-defended via `isSimulatedApprovalNotice`,
  with a forced retry before a hard fallback.
- **`validateGroundedCard`** — every card fact must appear verbatim in the evidence.
- **`enforceUrlProvenance`** — rewrite-not-block guard against invented links.
- **The request checklist** — a real ledger that overrides final text when items
  are unfinished, not a prompt reminder.
- **Planner truncation handling** — a named past bug now robustly code-defended.
- **Quarantine on extracted facts** (`email-extraction.ts:73-81`) — third-party and
  unfalsifiable claims wait for review rather than entering recall.
- **The nudge ledger** — held pings are recorded with a reason and surfaced, so
  suppression is never silent loss.

## 10. Recommendations, in order

Items 1-3 and 7 are **done and merged**; the rest are open.

1. ~~**Record model input and output**~~ — done. `LLM_AUDIT_CAPTURE`, the
   `model_call_audit` table, and `pnpm audit:llm`. Nothing else here can be
   measured without it.
2. ~~**Populate `email_ingest` in `direct` mode**~~ — done. Scores and records
   every authenticated message, automated senders included; trust semantics and
   interrupt behaviour unchanged.
3. ~~**Persist something recoverable before the automated-sender regex drops a
   message**~~ — done, by the same change.
4. **Decide the two-brief question.** Either retire `morning-brief` (moving
   `WAKE_BRIEF_SCHEDULE` to `daily-briefing` first) or give its prompt the
   self-silence clause every other producer has. Today it pings every morning
   regardless. `packages/db/src/seed.ts:196-205`,
   `packages/core/src/workflow/schedules.ts:725`.
5. **Reconcile the two recall defaults.** The schema says `false`; `deploy.sh`
   resolves an unset value to `true`. A local install and a deployed one
   therefore behave differently with no note anywhere, which is how this review
   first got it wrong. Pick one default and state it, and have
   `proactiveConfigNotes` report the effective value the way it now does for
   ingest mode. `GRAPH_RAG_ENABLED` has no such split and is genuinely off until
   the graph backfill completes.
   `packages/config/src/index.ts:272,278`, `infra/gcp/deploy.sh:394-395`.
6. ~~**Ground live web and weather answers**~~ — partly done. `ungroundedLiveFigure`
   (`packages/core/src/workflow/live-lookup.ts`) compares scorelines and
   temperatures in the draft against the text the lookup actually retrieved, and
   refuses rather than reporting a figure no source stated. Deliberately narrow:
   a general "every number must appear in the source" rule fires on figures the
   model legitimately derives, and a false positive at the last step replaces a
   correct answer with a refusal. Named entities and prose claims are still
   ungrounded — extending it means solving that without the false-positive cost.
7. ~~**Port the harness-only formatting checks out of the test suite**~~ — done.
   `gradeAuditedOutput` (`packages/core/src/model-router/audit-graders.ts`) is now
   the single implementation: `response-contract.ts` repairs what can be repaired
   without judgement before publish, and the regression harness grades with the
   same functions instead of its own regexes. The suite can no longer fail a case
   on a property the runtime does not enforce.
8. **Make the verifier unconditional on live-lookup turns**, and route it to the
   `reason` tier for `critical` turns rather than the cheapest tier.
9. **Cover the two busiest surfaces.** `chat-turn.ts:389` and `:596` have no test
   of any kind; both harnesses start after a plan exists.
10. **Supersede facts on write**, not only in a 12-per-night batch, so a
    correction the owner just made cannot be contradicted the same day.
11. **Add a calendar snapshot diff** and emit `event-cancelled` / `event-moved`
    moments; carry Google's `status` through `RawEvent`.
12. **Let a model phrase the pulse's deterministic findings** — decision stays in
    code, wording comes from the model, exactly as `briefing.compose` already does.
13. **De-duplicate pending approvals** for structurally identical gated calls
    (`dispatcher.ts` `parkForApproval`, ~:793).

## Open questions

- **Should these defaults change, or should the diagnostics just name them?**
  Changing `GRAPH_RAG_ENABLED` or the seeded `morning-brief` alters behaviour and
  cost for every existing installation.
  `EMAIL_INGEST_MODE` was resolved the other way — leave the default, make the
  mode work — and the same shape may fit here.
- **What should the eval assertion vocabulary grow into?** The proactive surfaces
  need "should not have spoken", timing and non-duplication assertions that the
  current regex/count vocabulary cannot express. The `model_call_audit` recorder
  now makes recorded production calls available as eval inputs, which is a
  different and probably better starting point than more hand-written fixtures.
- **Is `full` capture acceptable for this installation?** `redacted` keeps dates,
  amounts and scores but drops identifiers, which is enough for formatting and
  timing review. Judging whether an answer was _grounded_ generally needs the
  evidence verbatim.
