# Codebase review, round two — findings and fixes

A second full review, run after seven phases of platform change (much of it
AI-authored) had reshaped the tree. Three parallel adversarial passes —
security, AI capability, and refactor-regression — surfaced five HIGH findings
plus a tier of mediums and lows. The top five were verified first-hand by
reading the exact code paths before anything was changed; four of them live in
code written during those seven phases, which is the point of reviewing your own
recent work adversarially. Everything feasible was fixed, in four phased commits
plus this one. Each finding carries a regression test.

- Phase A — five HIGH findings (security + correctness): `7727947`
- Phase B — AI capability: `006f52f`
- Phase C — measurement + medium security/correctness: `ed625e9`
- Phase D — lows, docs, and this review: this commit

Every phase was gated on `pnpm lint` (including `pnpm check:boundaries`),
`pnpm typecheck`, the full vitest suite against a real Postgres with pgvector,
and `pnpm build`.

---

## Phase A — HIGH severity

**Email replies had no trust filter on the recipient (SEC-H2).**
`deliverEmailFinal` resolved the reply target from the _earliest_ `email_triage`
task on the conversation, and `conversationForThread` binds a thread regardless
of trust. An authenticated-but-untrusted stranger could seed the origin task on
a thread, and later owner-trust output on that same thread — a scheduled or
mission final, an approval notice — would then be addressed to _them_. Fixed by
adding `eq(tasks.trust, 'owner')` to the origin-resolution query: the reply
recipient now comes only from the earliest **owner-trust** email task, and
delivery returns "no owner-trust origin" rather than guessing when none exists.

**A dropped channel completed silently instead of failing (REG-H1).** The
delivery loop iterated only the _installed_ channels, so an owner-facing task
whose owning channel module had been uninstalled completed as `done` with
nothing delivered — the pre-refactor null-object used to throw. Fixed by making
module ownership explicit: metas now declare `deliversTaskTypes`, `install.ts`
builds a `channelUnavailable(taskType)` map over _all_ definitions (installed or
not), and `deliverFinal` throws for an owner-trust task whose owning channel is
absent instead of reporting a false success.

**`compact()` could delete the tool result it had just produced (AI-A1).** The
context compactor's leading-`tool`-message skip could advance past the newest
message, collapsing `[user, assistant(big tool-call), tool(result)]` to
`[user]` — losing the freshly created doc/sheet URL, forcing either a duplicate
create or a "here's what I would have written" non-answer, and persisting a
blind window. Rewritten to walk in atomic groups (an assistant tool-call plus
its tool results is one indivisible unit), to never return an empty tail, and,
when the newest group alone busts the token budget, to keep the group and
replace only its oversized tool-call `input` with an `{ elided: true, note }`
stand-in — the real arguments are durable in `tool_calls.args`. The three-message
reproduction is pinned in `util.test.ts`.

**`Authentication-Results` parsing ignored comments and quoted strings
(SEC-H1).** `gmailSenderAuthenticated` split the top-most `Authentication-Results`
header on `;` without accounting for RFC 5322 comments or quoted strings — and
the code's own fixture showed attacker-controlled envelope-from text landing
inside an SPF `(...)` comment. A `;` inside a quoted MAIL FROM local-part could
inject a synthetic `dkim=pass header.d=<owner>` clause and forge sender
authentication. Fixed with a small backslash-aware tokenizer that strips
balanced `(...)` comments and `"..."` quoted strings before the split; forged
fixtures are in `email-sync.test.ts`.

**Loopback bypass was defeatable with spoofed headers (SEC-H3).** Next preserves
a client-supplied `X-Forwarded-For` (`??=`), so with `AUTH_LOCALHOST_BYPASS` on
and the port exposed, `Host: localhost` + `X-Forwarded-For: 127.0.0.1` is
byte-for-byte indistinguishable from a genuine local request. Header-based
loopback detection is _fundamentally_ unsound behind a proxy — there is no
header a real client cannot also set. Rather than claim a fix the transport
cannot deliver, this was treated honestly: the docstring now states the real
limitation (a best-effort tripwire, not a boundary), the app logs a startup
warning when the bypass is on in production, `.env.example` carries a security
note, and a test named for the known limitation pins the behavior. The sound fix
needs the socket peer address (a custom server), recorded as deferred below.

---

## Phase B — AI capability

The theme, again, was the assistant under-serving its own model:

- **The chat path was not prompt-cached (AI-A5).** `cacheHinted` (OpenRouter
  ephemeral cache breakpoints) was applied only in `stepOnce`; the owner's
  streaming chat turn — the highest-frequency call — re-billed the full system
  prompt every turn. `stream`, `generate`, and `object` now route through the
  same cache-hint shape when `messages` are present.
- **Taint gutted competence on the path that most needs it (AI-B1).** Taint
  stripped the skills block from every untrusted email task at step 0 — throwing
  away learned, assistant-authored procedure exactly where it helps most. Skills
  are assistant-authored, not owner-private, so they now survive taint; only
  free-text personal facts stay gated behind `!tainted`. The dispatcher's
  taint-approval gate is unchanged.
- **`documents.search` had no relevance floor (AI-B2).** Unlike recall (0.75) and
  skills (0.72), document search returned its top-k with no similarity threshold,
  so an unrelated question got back confident passages from a filed PDF. Added a
  `minSimilarity` floor (~0.7) as a SQL filter, still returning `similarity`.
- **A budget-blocked triage was mislabeled trivial (AI-B8).** The planner treated
  `!triage.ok` (a classify call that failed, e.g. on budget) the same as
  `trivial`, silently downgrading real work. Split the two: only an explicit
  `trivial: true` short-circuits; a failed classify proceeds to planning.
- **Forced tool use kept an incompatible reasoning option (AI-A7).** When
  `toolChoice` forces a tool (`'required'` or `{ type: 'tool' }`), the model call
  now omits the `openrouter.reasoning` provider option — costless if the
  incompatibility is a non-issue, and it prevents a dead-letter loop if it is
  real.
- **Email-triage budget did not match its step count (AI-B4).** Sixteen steps
  were enqueued against a default `$0.50` budget, so the hard cap landed around
  step six with ~10 steps unusable. Enqueue now passes an explicit `$1.20`
  budget so the step count and the spend cap agree.

---

## Phase C — measurement + medium security/correctness

- **`response_checks` now records every terminal path (AI-A2).** The quality
  table was written only from the successful-prose finalize path, so the failures
  it exists to measure — step-cap, forced-no-tool, artifact failure, budget
  stalls — were never recorded. `recordQualitySignals` moved into the single
  finalize funnel (`finalizePendingResponse`, covering first-pass and resume) and
  now records the _actual_ terminal status.
- **The skill-deprecation loop became reachable (AI-A3).** Skill-outcome
  recording was guarded on the fresh `response_checks` insert (`.returning()` +
  `inserted.length > 0`) so it runs exactly once per terminal task, letting
  `failureCount` climb and the three-strikes deprecation actually fire.
- **Boot validation now runs at boot (SEC-M1).** `buildDeps()` — which runs
  `installModules` composition validation — was only reached on first request in
  the queue-driver path. It is now called unconditionally at startup, so a
  composition mistake fails the process at boot in production, not on first
  traffic.
- **`deploy.sh` / `release.sh` injection (SEC-M3/M4).** `envval()` now rejects a
  value containing `|` (the `--set-env-vars` delimiter) with a fatal error rather
  than letting it split into extra variables; `release.sh` switched to gcloud's
  custom-delimiter `--substitutions "^@@^..."` form so a substitution value
  containing a comma cannot inject another key.
- **gappssmtp hyphen collision (SEC-M2).** The default-DKIM reverse mapping
  (dots↔hyphens) is lossy, so `mail-example.com` could claim `mail.example.com`'s
  default-DKIM identity. Restricted to reject a `fromDomain` that is not an
  unambiguous single-dot, hyphen-free domain.
- **The barrel bypass is now a boundary violation (REG-M4).** `check-boundaries`
  already forbade relative sibling-module imports; it now also fails a bare
  `from '@assistant/modules'` import from inside a module directory, closing the
  other way one module could reach another's internals. Verified against a
  planted violation.
- **Orphaned deterministic task kinds fail cleanly (REG-L10).** A confirmation
  task whose owning (google) module is disabled used to fall through to the model
  executor. Metas now declare `taskKinds`; `taskKindUnavailable(kind)` reports the
  orphan, and the task-runner cancels it with a clear reason instead of running
  it on the wrong path.

---

## Phase D — lows and documentation

- **Location replay when `capturedAt` is absent (SEC-L1).** The HMAC covers only
  the body, so a captured signed ping stays valid forever unless its embedded
  timestamp is checked. `locationPingFresh` now fails closed when `capturedAt` is
  missing (previously it accepted and stamped receipt time, which let a captured
  body replay hours later and re-assert a stale location as current). The owner's
  Shortcut requirement — send a live `capturedAt` — is documented in
  `docs/operations.md`.
- **Twilio config-probe oracle (SEC-L2).** A missing `TWILIO_AUTH_TOKEN` returned
  a distinguishable `501`, letting an unauthenticated caller learn whether Twilio
  was configured. The route now returns the same `403` whether the token is unset
  or the signature is bad; the operator learns of a missing token from
  `pnpm config:check` / `/ready`, not from the public endpoint.
- **Tool-label coverage pin (REG-L8).** `ui.ts` hand-imports each module's labels;
  a new module that declares `ui.toolLabels` in its meta but is never wired into
  that list would ship labels the web UI cannot render. A test now asserts the
  aggregate covers exactly the union of every meta's declarations.
- **Documentation corrected (REG-L11).** `docs/architecture.md`: `oneShotToken`
  routes authenticate inside the handler, not in the mounter; `/internal/gmail/sync`
  answers `200`-skip (not `404`) so the scheduler stays green; the browser
  canaries import the module barrel. Stale `apps/agent/src/...` paths in
  `docs/anticipation-layer.md` and `docs/complex-workflow-test-matrix.md` now
  point at the relocated `packages/modules/src/{google,sms}/` files.
  `docs/platform-review.md`'s AgentDeps note gained a clarifier that the proposed
  contract has since landed (per-module clients now reach consumers through
  `InstalledModuleSet.requireExports`).
- **Dead surface trimmed (REG-L12).** The unused `syncMailboxOnce` export is now
  file-private, and `@assistant/modules`' barrel was trimmed to the symbols an
  external consumer actually imports — a module's own plumbing is reached through
  relative imports inside `packages/modules`, keeping REG-M4's bypass surface
  minimal.

---

## Verified sound (probed, kept as-is)

The reviews probed these hard and found them correct; they were left unchanged:

- **SSRF guards** — redirect, DNS-rebind, and IP-literal-encoding shapes all
  still blocked.
- **One-shot callback tokens** — single-use, constant-time compared, and
  correctly scoped per launch.
- **The taint gate** — untrusted context propagates and launders closed; the
  dispatcher's approval floor holds under taint.
- **Purge accounting** — retention sweeps preserve segment-anchoring messages and
  approval/cost-referenced tool calls past their cutoff by design.
- **Dispatcher invariants** — the owner-only auto-send rule, budget reservation
  before execution, and idempotent ledger reconciliation are intact.

---

## Deliberately deferred

- **Socket-based loopback detection.** The sound fix for SEC-H3 needs the TCP peer
  address, which requires a custom Next server; header-based detection cannot be
  made sound behind a proxy. Phase A hardened and documented the tripwire; the
  real boundary is this follow-up.
- **jelly-ui SRI/vendoring.** Snapshotting the unversioned upstream nav widget
  into `public/` needs a networked machine (this environment's egress policy
  blocks the origin); the CSP pin from round one still contains it meanwhile.
- **Mid-run model escalation.** Raising the model tier when a task stalls near its
  step cap (rather than only at enqueue) is a capability project, not a fix.
- **Golden-harness expressiveness (B12).** The step-cap message and tool-error
  recovery fixtures still need `maxSteps` on `GoldenFixture` and non-hardwired
  ledger outcomes before they can be pinned.
- **Response-contract research-evidence widening (B6).** Broadening what counts as
  evidence for an external-action claim is a measurement-first change, sequenced
  after the harness work.
- **Planner plan-model upgrade.** Swapping the `plan` role's model (deepseek was
  kept for structured-output reliability) is deferred to the eval harness so the
  change is measured, not guessed.
