# Reasoning and context review refactor

Base: `12dedc5e9ee0708a05fff2aa1f74c8f80dc0ca50`. Isolated branch:
`codex/reasoning-context-refactor`. No integration or release is included.

## Evidence and scope

Read-only investigation used the primary checkout's
`.workspace/playbook-review/implementation-progress.json`, specifically
`latestVerifiedReleaseStatus`, and the recovered source-bound reports in
`.workspace/playbook-review/production-evidence-recovery-20261018`.
The deployed base is unmeasured. The last measured source, `d66f91b4`, passed
14/30 cases with all user dimensions at least 9, including 0/6 abstract cases.
These historical grades do not qualify this change.

Six fictional prompts and complete replies are frozen in
`packages/core/src/workflow/fixtures/reasoning-d66.json`. Each original answer
file was rehashed against the independently graded report before copying its
text. The fixture retains its original answer-file hash and source SHA; it
contains no real owner context or live account data.

| Failure class | Observed problem | Local change |
| --- | --- | --- |
| Rates and causation | Starts/submissions called abandonment; traffic volume offered as an explanation of a normalized rate | Share explicit numerator/denominator and confound criteria between drafting and review |
| Total budget | A venue alone above the entire budget supposedly fits after cutting other spending; invented food price | Share component/total arithmetic, unknown extras and availability checks |
| Hard deadlines | Missing Thursday design milestone followed by a claim that no hard deadline was broken | Require checking each original deadline and explicit renegotiation |
| Invented facts | Fictional surnames, venue availability and prior artifacts asserted without support | Share source/unknown/proposal distinctions; exclude assistant claims from the owner-fact corpus |
| Owner corrections | Accessibility priority became indoor-only; retained constraints and artifacts were invented | Preserve more bounded owner context, latest-turn precedence, and compatible-fact reuse criteria |

## Implementation boundary

`reasoning-criteria.ts` owns the five existing audit criteria. Both scenario
drafting and reasoning verification consume them; the base system prompt
version advances to 45. No new reviewer, model role, schema fields, tool access,
or review loop is introduced.

`buildReviewContext` produces the bounded request, a valid JSON context snapshot,
and exactly the same owner excerpts for deterministic source checks. Owner turns
and assistant reference text have separate budgets, so assistant prose cannot
evict recent owner corrections. Excerpts preserve their beginning and end;
omitted turns and truncated text are explicit. Request and context limits remain
4,000 characters each. The snapshot contains at most six owner turns and two
assistant turns; size pressure first removes assistant context, then oldest
owner turns. It reads no historical store or private account.

The audit now describes the **returned candidate**: the draft for `publish`,
or `revisedText` for `revise`. Previously a changed revision could bypass a
missing or failed audit, and the second revision could retain a declared defect
if its text changed. Either unresolved audit now consumes the existing single
correction, then yields an incomplete response if still unresolved. A missing
usable replacement and a collapsed answer cannot clear that gate. Scenario
failure does not claim that an unrelated retrieved page failed summarization.

The existing finalization contract still checks revisions. The executor test
confirms that unresolved reasoning reaches the checkpoint as `needs_attention`,
with an incomplete/blocked contract signal, rather than completed work. The
two-call maximum, token limits, source checks, ordinary rewrite routing and
provider/budget best-effort behavior remain in place.

## Local validation

- Repository lint passed, including architecture boundaries, migration checks,
  runtime support matrix and iOS card parity. It reported 137 existing warnings
  and 11 informational findings; unrelated files were not modified.
- Full workspace typecheck passed (14 packages plus scripts). Core typecheck
  was repeated after the final executor test update and passed.
- The final eight-file targeted run passed 637 tests with no skips. This covers
  frozen and varied reasoning cases, bounded context, owner intent, read intent,
  output verification, response contracts, finalization and simulation no-tool
  execution.
- The two existing self-review golden tests passed; the 55 other tests in that
  file were intentionally excluded by the name filter.
- `git diff --check` passed.

All test model responses were scripted. The standard test runner installed its
outbound-request blocker. The initial default database preparation failed
because nothing was listening on its local port; a new temporary loopback-only
PostgreSQL instance on port 56791 then supported allocated disposable test
databases and normal cleanup. No existing database was reset. Local logs are
under `/tmp/assistant-reasoning-refactor-pg-20261018/`; those ephemeral files are
supplementary, not production evidence.

## Remaining limits and integration

These tests verify context retention, enforcement of reported audit defects,
bounded calls, failure propagation and existing action boundaries. They do not
show that a model will identify every bad rate, budget assumption, deadline or
invented fact. The varied corrected answers are reference responses from the
test author, not new model generations. The prompt changes need a fresh,
source-bound semantic evaluation when paid admission is actually authorized.

Context remains bounded: facts in omitted middles or older turns can be absent.
Chronological owner precedence is guidance to the model, not a deterministic
semantic reconciliation engine. A model can still falsely report that an audit
passes. If the first optional review is unavailable, the previously checked
draft is retained; this is not semantic verification. Stricter candidate audit
enforcement may expose more incomplete replies instead of publishing defects.
Full repository tests, production build, new native validation and live answer
grading were not performed for this workstream.

No paid production model call, budget/counter/hold change, personal goal,
schedule, notification, external message, shared-tracker update, merge,
deployment or main push was made. The primary checkout stays at the base SHA
and clean. The graph repair worktree was not edited. Only this isolated branch
is intended to be pushed for a draft PR, for review by the integration chat.
