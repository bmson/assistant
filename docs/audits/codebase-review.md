# Codebase review — findings and fixes

A full review of the codebase across five dimensions — AI capability, security,
performance, process, and tooling — carried out by three parallel deep-review
passes, findings verified against the running code before anything was changed.
Everything feasible was fixed in three phased commits plus this one; the last
section lists what was deliberately deferred and why.

- Phase 1 — security: `76042a9`
- Phase 2 — performance: `f745135`
- Phase 3 — AI capability: `5ca6680`
- Phase 4 — process & tooling: this commit

Every phase was gated on `pnpm lint`, `pnpm typecheck`, the full vitest suite
against a real Postgres (901 passing at time of writing), and `pnpm build`.

---

## Security

### Critical — fixed

**Fork PRs could trigger a production deploy.** `deploy.yml` fired on
`workflow_run` completion of CI with `branches: [main]` — but for a
`pull_request` run that filter matches the _head_ branch name, which a fork
controls. An attacker could fork the repo, name their branch `main`, open a PR,
let CI pass, and the deploy job would build attacker-controlled Dockerfiles and
run attacker-controlled `pnpm modules:plan` under the Workload Identity
Federation production identity. Verified first-hand against the workflow-run
event payload semantics before reporting. Fixed by requiring all three of
`workflow_run.event == 'push'`, `head_repository.full_name == github.repository`,
and `head_branch == 'main'` (the `workflow_dispatch` path is unchanged). The
same job also ran `modules:plan` with no Node/pnpm setup and no install — the
prelude was added.

> **Action outside the repo:** verify the `production` GitHub environment has
> required reviewers configured (Settings → Environments). That setting is not
> visible in-repo and is the second lock on the same door.

### High — fixed

**Unknown-trust senders kept network egress.** The registry stripped
`outwardFacing` tools from `unknown` trust but not `networkEgress` ones, so any
DKIM-valid stranger's email could drive `web.fetch`/`web.search` — blind
server-side requests and paid searches from the owner's IP. `networkEgress` is
now also stripped at `unknown` trust, and `tool:web.fetch` (60/hr, 300/day) and
`tool:web.search` (20/hr, 100/day) rate-limit rows are seeded.

### Medium — fixed

- **Dead rate-limit controls made real.** Seeded `task` and `channel:sms`
  limit rows were checked nowhere. `enqueueTask` now enforces the `task` scope
  for externally-originated parentless tasks (`TaskRateLimitError`; email
  triage skips-not-stalls so the history cursor still advances), and
  `sendMeteredSms` enforces `channel:sms` against `cost_events`.
- **Document-processor retry loop.** A failing document (e.g. an emailed
  attachment that OOMs the worker) was relaunched every 15 minutes forever — a
  standing cost bomb. Documents now carry `processor_attempts`; after 3
  attempts the row is marked `failed` with the error recorded.
- **`AUTH_LOCALHOST_BYPASS` exposure.** Compose hardcoded the bypass on; on a
  VPS with a port published or proxied, that is an open dashboard. The bypass
  now additionally verifies per-request that the Host and forwarded headers
  are loopback (`requestLooksLoopback`), and the production build refuses
  non-loopback requests in the bypass path at runtime.
- **`code.execute`/`browser.execute` autonomy floor.** Both now carry
  `writesWorkspace`, so `known`-trust senders can no longer reach them
  autonomously — matching the documented invariant.
- **Shared-secret internal auth with Cloud Tasks.** Refused outright when
  `QUEUE_DRIVER=cloudtasks`, not only when `NODE_ENV=production`.
- **Location ping replay.** Pings carry `capturedAt` freshness validation
  (±5 minutes skew) when present.
- **Browser callback size.** The worker fits step outputs to a 400KB budget
  (halving the largest outputs) instead of discovering the 512KB route cap by
  failing the callback.
- **Local code driver honesty.** `code.execute` describes its actual isolation
  per driver, and non-owner tasks require approval when `CODE_DRIVER=local`.

### Verified sound (probed, kept as-is)

OIDC/Twilio/one-shot-token verification; SSRF guards (probed for bypasses —
redirect, DNS-rebind shapes, IP literal encodings); taint propagation and its
laundering closure; the approval floor; web auth fail-closed behavior;
XSS/SQL hygiene (React escaping + parameterized drizzle queries throughout);
worker least-privilege IAM split; CI action pinning, SBOM, cosign signing;
the justified `pnpm audit` ignore (documented inline in ci.yml); pgvector
index choices; the skipped-test CI guard.

---

## AI capability

The largest theme: the assistant was quietly starving its own model. All fixed
in `5ca6680`:

- **Honest tool-result truncation.** Results were globally clipped to 8k chars
  with a note pointing at storage no tool could read. Read-heavy tools now get
  24k, the default stays 8k, and the truncation note names a real tool —
  `tools.read_result({ toolCallId, offset })`, a new task-scoped builtin that
  pages through the full stored result.
- **Token-based compaction.** Context was compacted by message count (60),
  which could blow the budget in one step and silently fall back to a
  64k-context model. Compaction is now dual-bounded by an estimated-token
  budget (25k tokens at ~3.5 chars/token) and message count.
- **Prompt caching.** The system prompt was rebuilt with a fresh timestamp
  every step, defeating provider-side caching entirely. The prompt is now
  static-first with the timestamp pinned per run and moved to the tail
  (PROMPT_VERSION 19), and the router sends OpenRouter `cacheControl`
  ephemeral breakpoints. Measured provider-side, this is worth roughly
  60–80% of input-token cost on long tool loops.
- **Budget sanity.** The `reason` fallback moved off a model documented as
  unable to drive tool loops onto `openai/gpt-oss-120b`; held reservations
  count against hard caps but no longer trip the soft 80% warning; degraded
  steps are counted per task.
- **Taint split.** Reading your own state no longer poisons the session.
  `memory.recall`, `calendar.availability`, and `calendar.list_calendars` are
  untainted (memory is quarantined at write). `conversations.search` and
  `workspace.read` were candidates but verification showed both can return
  third-party content (stored email bodies; filed attachments) — they keep the
  flag. The review's original list was wrong on those two; the code is right.
- **Skill loop closed.** `recordSkillOutcome` is now actually called at
  finalize (the three-strikes deprecation path was unreachable before), and
  skill reflection sees redacted tool args plus the final text.
- **Quality became measurable.** New `response_checks` table records the
  response-contract verdict, unsupported-claim count, must-act retries, and
  degraded steps per task, written after the contract runs. `applyProposal`
  refuses model-role swaps with no evidence attached. A golden-task harness
  (`packages/core/src/workflow/golden/`) runs scripted conversations through
  the real executor, dispatcher ledger, and response contract — six fixtures
  (fabricated claim blocked, evidenced claim untouched, fabricated link
  rewritten, forced-action retry counted, plus the basics), and the place to
  pin any behavior a prompt change must not break. Two fixture ideas need
  harness changes and stay deferred: the step-cap message (needs `maxSteps`
  on GoldenFixture) and tool-error recovery (ledger rows are hardwired
  `succeeded`).
- **Batch work on batch models.** Nightly reflect/dream/improve run on a new
  `batch` role (gpt-oss-120b), and `classify` moved to deepseek-chat.

---

## Performance

All fixed in `f745135`:

- **Agent bundle: 7.86MB → 3.73MB.** 60% of the bundle was dead weight:
  `unpdf` (2.25MB) was inlined despite a lazy import, and the full OTel SDK
  (2.45MB) shipped while production sets `OTEL_EXPORTER=none`. `unpdf` is now
  external (installed pinned in the runtime image); OTel init uses
  `NodeTracerProvider` + `BatchSpanProcessor` directly instead of `sdk-node`.
- **Docker layer caching.** All three Dockerfiles copy manifests first and
  mount a shared pnpm store cache, so a source-only change no longer
  reinstalls the world. BuildKit enabled in Cloud Build and CI.
- **Missing FK indexes.** `tasks(conversation_id, status)` and
  `tasks(goal_id)` — both on the chat polling path — are indexed.
- **Recall round trips.** Neighborhood reads run in parallel and key-message
  lookups are batched with `inArray` (up to 8 sequential round trips before).
- **Small wins.** Local sweep cadence matches its comment (every 30 ticks);
  task reclaim selects before updating instead of a no-op UPDATE per tick;
  the metadata-server token is memoized against its expiry; the layout's
  shell status is cached for 30s instead of full-scanning memories per
  request.

---

## Process & tooling

Fixed in this commit:

- **CI restructure.** One serial job became three parallel ones: `checks`
  (audit, Trivy, lint, shellcheck + `bash -n` over ~950 lines of deploy bash
  that previously had no gate at all, `pnpm config:check`), `verify`
  (migrate/seed/typecheck/test against pgvector), and `build-smoke` — which
  now smokes the standalone production build that actually ships, not a
  `next dev` recompile, with `.turbo`/`.next` caches persisted. The smoke
  runs under `AUTH_LOCALHOST_BYPASS`, which also exercises the new
  request-level loopback guard on every CI run.
- **Vitest parallelism.** `fileParallelism: false` was global; it now applies
  only to the five DB-sharing projects, and the seven isolated projects run
  their files in parallel.
- **Code-runner worker tested.** The highest-blast-radius worker had zero
  tests and was absent from the runner. It is now a vitest project with first
  coverage pinning `parseJobInput` validation and the exact staging
  allowlist.
- **`.env.example` parity.** `AUTH_URL` and `AUTH_TRUST_HOST` had drifted out
  of the file; both are documented now, and a test in `@assistant/config`
  fails CI if any schema key is missing from `.env.example` again.
- **TypeScript unification attempted, pin kept.** `apps/web` on the root
  TS 7.0.2 typechecks, but `next build` then fails to resolve the `@/*` path
  alias — Next 16's webpack integration does not understand the TS 7 API
  yet. The 5.9 pin stays, with the finding recorded in `apps/web/tsconfig.json`
  so the next attempt starts from evidence.
- **jelly-ui containment.** The nav widget loaded from `jelly-ui.com` with no
  CSP — any injected script tag would have run. A Content-Security-Policy now
  pins script execution to `'self'` plus exactly that origin (with matching
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri`, `form-action`).
  Vendoring the file itself into `public/` is the remaining step — the bundle
  is unversioned upstream and this build environment's egress policy blocks
  jelly-ui.com, so snapshot it deliberately from a networked machine (see the
  note in `app/layout.tsx`).
- **turbo.json** dead `test`/`lint` task entries removed (both run outside
  turbo).

---

## Picked up after the initial pass (Phase 5)

Two of the deferred items were pure engineering and landed in a follow-up
commit:

- **Retention sweeps**: `purgeAgedHistory` prunes `messages`, `tool_calls`,
  `model_calls`, and `cost_events` past config-driven cutoffs
  (`HISTORY_RETENTION_DAYS`, `COST_RETENTION_DAYS`). Both default to 0 —
  keep forever — because deleting the owner's history is their policy call;
  the machinery ships, the knob stays off. Segment-anchoring messages and
  approval/cost-referenced tool calls survive their cutoff by design. See
  `docs/operations.md`.
- **Observability baseline**: `tool.execute` spans on both dispatch paths
  (autonomous and approved), and `deploy.sh` now provisions the
  `assistant-error-logs` log metric, an owner email notification channel,
  and an error-burst alert policy — created once, then left alone so console
  tuning survives redeploys.

## Deliberately deferred

Larger projects, recorded here so they stay visible:

- **Full trace export in production**: spans exist, but production still sets
  `OTEL_EXPORTER=none`. Flipping to `otlp` needs an OTLP ingest to point at
  (a collector sidecar or a managed vendor) — a cost/vendor decision.
- **Turbopack migration** for the web build. Attempted 2026-07:
  `next build --turbopack` fails with `Module not found: Can't resolve
  '../chat.js'` across every transpiled workspace package — the monorepo's
  NodeNext-style `.js` specifiers need webpack's `extensionAlias`
  (`.js → .ts`) and Turbopack has no equivalent (`turbopack.resolveAlias`
  maps module names, not extensions). Blocked until Turbopack supports
  extension aliasing or the packages ship built JS.
- **Recall quality tuning** (recency weighting, similarity-threshold
  measurement) — intentionally sequenced after the golden-task harness so
  changes can be measured instead of vibed.
- **Per-goal autonomy defaults** — a product decision about how much standing
  authority a goal should carry.
- ~~Relocating module-owned behavior out of `apps/agent`~~ — done in a
  follow-up: the module platform gained a runtime hook surface (webhooks,
  internal routes, sweep steps, poller ticks, task handlers, channels, an
  owner-notifier port, and inbound-email observers), and mail sync, the email
  channel, application confirmations, the SMS channel, and watch matching all
  moved into their modules. `AgentDeps` no longer names a provider; canaries
  are the one remaining agent-owned module consumer.
- **Pulumi/Terraform port** of `infra/gcp` — the bash provisioner is now
  shellcheck-gated, which lowers the urgency.
