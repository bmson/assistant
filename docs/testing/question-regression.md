# Audited-question regression suite

The September 7, 2026 home-screen audit found incorrect factual answers, unsupported completion claims, repeated approvals and formatting failures. This suite turns those failures into repeatable checks through the real executor, tool dispatcher, response contract and output verifier.

## Run the CI checks

```sh
pnpm test:questions
```

This uses the repository's isolated `_test` database. It fails when the database is unavailable; it never silently skips. The question cases also run as part of `pnpm test` in the existing CI workflow. No model credential or paid API call is needed.

The corpus maps all **34 owner turns** (33 in the original home snapshot, plus the later score question) to **27 executor scenarios** and the existing application budget-approval tests. Repeated questions share scenarios; terse corrections have their own cases. Private names, orders, booking identifiers and family dates are replaced with synthetic equivalents. The birthday fixture preserves the actual shape: 56 dated people, a shared date, a deceased marker and one undated person. These are regression examples, not the original production database.

## Run the configured models

Capture model IDs, routing parameters and cost metadata from production, using a read-only transaction. This command copies neither credentials nor conversations and refuses to overwrite an existing snapshot:

```sh
pnpm eval:questions:config .workspace/question-regression/model-config-new.json
```

It uses the existing `PROD_DATABASE_URL` from the shell or ignored `.env`. Review the captured settings, then run:

```sh
pnpm eval:questions --live \
  --model-config .workspace/question-regression/model-config-new.json
```

Live mode reuses the existing `OPENROUTER_API_KEY` and actual `ModelRouter`; the configured response and verification models run their normal prompts. Without `--live`, the same runner uses scripted model outputs. Narrow a run with `--cases giants-score,birthdays-graph-incomplete`.

Every tool adapter is replaced with a local, frozen response or intercepted write. The actual dispatcher still enforces taint and approval rules. Unknown URLs fail; no real mail, calendar, reminder, notification or memory adapter is imported. Public source text is a dated snapshot: this measures reasoning over evidence, not whether today's websites are reachable.

The runner resets **only** its dedicated loopback `assistant_questions_test` database, runs each case in a transaction, captures results, and rolls that transaction back. It refuses remote hosts, non-test database names and connection-string overrides. A local lock prevents simultaneous runners from resetting the same database. Production is never a replay destination. Do not run this on a local port forwarded to production.

Default model allowance: **$5 for the run**, with a **$1 per-case cap**, the application's existing 10% owner-response allowance, and a **120-second per-case abort deadline**. The runner carries actual cost forward because transaction rollback removes each case's ledger. It stops starting cases when the remaining allowance is below $0.10 and reports those cases as not run. Use `--budget` for a different bounded allowance.

## Read the results

Outputs default to ignored `.workspace/question-regression/runs/<timestamp>/` with private file permissions:

- `report.md`: pass/fail, elapsed time, cost, approval count and concrete failed assertions.
- `summary.json`: coverage, p50/p95 elapsed time, model IDs, configuration capture time, commit, dirty-tree flag and corpus fingerprint.
- `<case>.json`: delivered answer and parts, tool ledger, intercepted saved state, verification records and per-model latency/cost.
- `prepare.log`: local database setup diagnostics.

A failed assertion or unrun case returns a nonzero exit code. Read failing answers before changing a rubric. Correctly retracting an earlier wrong score is valid; repeating that score as the result is not. Add negative grader tests whenever broadening accepted phrasing.

## What the checks prove

Assertions cover required facts, prohibited claims, executed/failed tools, task completion, approval count, exact batch counts, preserved saved details, structured card presence, leaked internal markup, closed code fences, time and cost. A tool succeeding is insufficient: the final answer must also satisfy its case's assertions.

The executor replay uses a preset plan appropriate to each scenario; it does not evaluate the planner or the application chat-triage path. Budget replies use their separate application tests because they are intercepted before model execution. Intercepted writes prove the requested arguments and receipts, not the production persistence implementation. Model grading is deterministic and case-specific, not a comprehensive factual judge. Passing once does not establish a statistical accuracy rate.

Native rendering, keyboard, scrolling, accessibility and physical-device performance still require the iOS tests and visual/device QA. The existing `AssistantMarkdownTests` cover multiline table cells; native test results should accompany UI releases.

## Add a regression

1. Add a sanitized case to `packages/tools/src/question-regression/corpus.ts`, with its audit record numbers, owner history, frozen evidence and explicit expected outcome.
2. Keep expected answers and scripted outputs out of the live model's input. Only owner history and tool fixtures may reach it.
3. Include a failed-provider or incomplete-work case when applicable. Declare expected failed tools explicitly rather than accepting any tool attempt as success.
4. Run `pnpm test:questions`, then a scoped live run. Inspect its answer, card parts, ledger and saved details.
5. Run repository validation before shipping runtime changes uncovered by a case. Retain failed reports as the baseline; do not overwrite them with a passing rerun.


## Calendar diagnostic preparation

Prepare the six diagnostic cases or six separate, development-exposed holdouts
without credentials, database setup, tool execution, or inference:

```sh
pnpm eval:questions --suite calendar-diagnostic --prepare --output /tmp/calendar-diagnostic-run
pnpm eval:questions --suite calendar-diagnostic --partition holdout --prepare --output /tmp/calendar-holdout-run
```

Each new private directory contains `preparation.json`; existing evidence is
never overwritten. Requests, history, frozen time/owner zone, synthetic outcomes,
actual registered read schemas/policy, expected evidence and independent rubrics,
and source/configuration hashes are recorded. Selected seam hashes are scoped;
the immutable commit plus dirty code inventory and diff hash identify additional
local source changes without claiming an exhaustive dependency manifest. All cases are `not_run`, with null
calls, latency, tokens and cost. Pagination cursors and causal markers survive
sanitization. Preparation success is not a behavioral pass; no paid inference
was run for this implementation. These source-reviewed holdouts are not blind.

The pack covers combined Google/iPhone reads, partial/unavailable sources,
canonical copies versus distinct overlaps, attendance uncertainty, and autumn/
spring clock changes with untrusted descriptions and irrelevant prior context.
Prior-chat or fixture-ledger privacy checks do not establish memory-retrieval
quality. Actual calendars, writes, cooperative cancellation, approval actions and
broad recall relevance remain outside this read-only pack; existing safety
regressions retain their separate coverage.

Future authorized `--live` execution uses the existing captured configuration,
budget, deadline and rolled-back dispatcher. It supplies no preset fixture plan:
production routing runs, including intentional deterministic private-read gates.
Only observed router calls are model evidence. Raw drafts/tool proposals, final
answers, response checks and available accounting are separate. Exact grounding
fallback reasons are not persisted by the current runtime and remain explicitly
unavailable; a changed draft alone does not prove contract rescue. Unknown tools
have no live-provider fallback. Captures over 64 KiB per input/output retain a
hash and preview rather than silently claiming completeness.

Missing/zero-default token usage and unsettled charges are incomplete telemetry,
not free work. This pack stops further cases after incomplete accounting because
transaction rollback would discard reservations. Reported and estimated cost
bases remain distinct. Diagnostic mutation tests check structured evidence,
forbidden proposals, privacy markers and narrow prose contradictions; they do
not certify semantic utility. Holdouts receive common safety/structure checks
and their independent rubric, not diagnostic-specific automatic credit. Every
automated pass leaves usefulness review pending. Before/after inference requires
frozen inputs/tool schedules, the same exact model/configuration and rubric, and
an agreed budget; preserve failures, not-run cases and per-case latency/cost.

Router traces omit the exact model-visible tool set, tool choice and provider
options; registered fixture schema hashes do not prove exact provider-request
parity. Router calls also do not identify every provider retry or fallback
attempt. Partial ledger coverage is incomplete. A thrown or aborted case retains
an interrupted receipt with unknown charge and null usage/cost, stops subsequent
cases, and remains in the summary even if cleanup fails. Budget preflight skips
retain a specific not-run reason. No unknown charge is treated as free allowance.
