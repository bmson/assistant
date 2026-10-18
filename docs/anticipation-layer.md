# Anticipation layer: watchers + a standing briefing

Design for the assistant acting *before* it is asked. Two capabilities, one shared discipline:

1. **Watchers** — durable, owner-defined triggers ("tell me if X emails", "watch this page for a
   change") that fire when a real-world event matches explicit criteria.
2. **The briefing** — a standing, scheduled digest (calendar conflicts, things that need the owner,
   mission/goal deltas, watcher hits, suggested next actions) delivered in the owner's voice.

Status: **Phase 1 shipped** — notify-tier email watchers (the `watches`/`watch_fires` tables, the
`watch.create`/`watch.list`/`watch.cancel` tools, the `matchEmailWatches` pass on the inbound-mail
hook, and the expiry reaper). **Phase 2 shipped**: the briefing exists as the `briefing.compose`
code job (`packages/core/src/workflow/briefing.ts`), on a daily schedule and self-silencing on a
quiet day; the **`suggestions` table and surface are built** — the briefing proposes, and accepting
creates ordinary approval-gated work; and the **`suggest` tier of watchers is built** — a firing
email watch hands a bounded trigger excerpt (`watch_fires.excerpt`) to the `watch.suggest` code job
(`packages/core/src/workflow/watch-suggest.ts`), which drafts the proposal with one model call
holding no tools at all. Phases 3–4 are otherwise unchanged.
This document is the source of truth for the design.

**Shipped since:** the proactive surfaces grew past the briefing. The `push`
module (`packages/modules/src/push`) delivers owner notices and approval pings
over APNs to the iOS app (`POST /api/mobile/v1/devices` registers tokens; the
module composes into the owner-notifier fan-out next to SMS). A wake-up path
fires the `morning-brief` schedule early on the first app-open of the day
(`maybeFireWakeBrief` in `packages/core/src/workflow/schedules.ts`, triggered
by `POST /api/mobile/v1/activity/foreground`). A seeded `tomorrow-check`
schedule (19:30) looks one day ahead for calendar surprises and dated email
obligations. Background location collection remains paused. A separate, opt-in
**Generic arrival nudges** setting uses foreground pings only: after a confirmed
three-minute stop at a new place, it can create one generic owner-day task. The
task contains an opaque owner-scoped ping reference that expires after five
minutes, and delivery uses a fixed location-free message without model calls or
location tools. Expired work is cancelled and terminal tasks clear the reference.
Current-location answers explicitly requested by the owner remain available.
Other proactive work surfaces to the owner as a notice, and anything outward
still goes through the approval spine.

**Shipped since (the during-the-day layer).** The three daily touchpoints were
all built to self-silence, and together they could leave the assistant mute for
days: an unanswered invitation sat on the calendar and an actionable email sat
in the ledger with nothing said until the next morning, if then. Four changes
close that:

- **The briefing reaches the phone.** `runBriefing` delivered through
  `postOwnerNotice`, which only writes a conversation row — so the flagship
  proactive feature was discoverable solely by opening the app. It now also
  calls `notifyOwner` with a deterministic headline (`briefingHeadline`) at
  `ambient` urgency. `ExecutorDeps.notifyOwner` carries an `urgency` field for
  this; omitted it stays `interrupt`, so dead-letter and budget-stall pings are
  unchanged.
- **Calendar salience** (`packages/core/src/proactive/calendar-salience.ts`).
  `briefingHasNews` counted overlaps and nothing else, so a day holding a
  flight or an unanswered invite read as routine. A pure, deterministic scorer
  over an unanswered RSVP, a physical location, an unusual hour, an outside
  organizer, size and duration now feeds a `calendarSalient` count into the same
  predicate. No model decides importance — every point is a fact the provider
  stated, which is the no-fabricated-urgency rule applied to the calendar.
- **The pulse** (`packages/core/src/proactive/pulse.ts`, the `pulse.check` code
  job on a `*/20 * * * *` schedule). Asks whether anything is worth saying *now*
  — a salient event inside its lead time, actionable high-importance mail
  nothing picked up, a commitment coming due — and delivers at most one thing
  per firing. Bounded structurally, not by prompt: the new `proactive_moments`
  table gives idempotency (`moment_key` unique per agent, claimed *before*
  anything is posted, so concurrent sweeps cannot both speak) and pacing (one an
  hour, and a daily ceiling the owner tightens with the ping limit they already
  have). A code job, so it holds no tools and cannot act outward; it proposes
  through the ordinary suggestion surface.
- **Curiosity** (`packages/core/src/proactive/curiosity.ts` +
  `memory/graph-gaps.ts`, the `graph.curiosity` job at midday). The knowledge
  graph only ever grew by overhearing. This computes *structural* gaps from rows
  — a well-connected entity missing a predicate its kind normally carries, a
  relation extraction hedged on, a person with no contact link — and asks one
  question a day. Deliberately a notice and not a suggestion: accepting a
  suggestion enqueues a task, and a question's answer is data, not work. The
  reply is captured by the existing `memory.extract` → `memory.graph_sync` path,
  so the loop closes with no new machinery, and a gap asked once is never asked
  again.

**Reversible self-only writes, extended.** `calendar.update_event` and
`calendar.cancel_event` were flat `risk: 'approval'` with a note in the source
saying the attendee check "would need an async risk fn; revisit if it gets
annoying". They now take an explicit `ownerOnly` argument: it earns the
autonomous tier and the `ownerVisibleOnly` flag exactly as `create_event`'s
zero-attendee shape does, and `execute` then *fetches the event and refuses*
if it has any attendee. The declared flag buys the tier; the fetch is what makes
the claim true. Adding an attendee in the same call contradicts the claim and
stays gated. `sendUpdates=none` on the verified path.

**Making silence legible.** Every producer here is self-silencing — including
`morning-brief` (`packages/db/src/seed.ts`), the older full-model-loop brief
that shares the wake path with the anticipation layer's own `daily-briefing`;
its prompt carries the same "say nothing on a quiet day" instruction as the
rest — so a broken pipeline and a quiet week look identical. Two surfaces tell
them apart:
`proactiveConfigNotes` (`packages/modules/src/diagnostics.ts`, printed by
`pnpm config:check`) names settings that are valid but leave the assistant mute,
and `assessProactiveHealth` (`packages/core/src/proactive/pipeline-health.ts`,
the "Noticing" card in Settings) reports what actually arrived. The failure they
exist for: `EMAIL_INGEST_MODE` defaults to `direct`, so an owner who forwards
their inbox here has that mail dropped as unauthenticated (forwarding breaks SPF
alignment) or as automated, `email_ingest` stays empty, and the importance
alerts, briefing highlights and proposed dates all silently never happen.

**The nudge policy (shipped).** Every out-of-band ping carries an urgency:
`ambient` (a briefing or a watch hit — things the owner did not just ask for;
generic arrival nudges use the bounded foreground flow) or `interrupt` (an approval waiting, a stall in requested
work). Ambient pings pass through quiet hours and a daily cap
(`notification_prefs` + the `proactive_pings` ledger;
`packages/core/src/proactive/nudge-policy.ts`), enforced at one choke point on
the phone legs in the agent's composition root. Interrupt pings are never
gated — the owner is the one waiting on them — and a held notice still posts
to the dashboard, so suppression is never loss. Both knobs are off by default
and set in Settings → Notifications.

> **One deliberate deviation from the invariant below.** Forwarded-mail ingest
> (`EMAIL_INGEST_MODE=forwarded`) lets an email-triggered task create a calendar event with **zero
> attendees** without an approval, via a predicate form of the `ownerVisibleOnly` flag
> (`packages/tools/src/google/calendar.ts`). Such a write sends no invitation, reaches no third
> party, and is trivially reversible — the same reasoning that already exempts `owner.notify` — but
> it is nonetheless untrusted content causing a write, so it is recorded here rather than left to be
> discovered in a diff. It is confined to that one argument shape: the moment an attendee is present,
> `sendUpdates=all` mails them and the call is gated like any other outward action. Extending it to
> anything with a third-party sink is a redesign, not an increment. It deliberately reuses the two pieces of machinery that already exist for exactly this
shape of work — the application-confirmation *watch* and the goal-automation *schedule* — and copies
their security discipline verbatim rather than inventing a new one.

## Goal / non-goals

**Goal.** Turn the assistant from purely reactive (it acts when the owner writes to it, or when a
mission it already owns wakes) into *anticipatory*: it surfaces the thing the owner would have wanted
to know, and — only within pre-authorized, frozen bounds — acts on it, without being prompted each
time.

**Non-goals.**

- **Not a general "if-this-then-that" engine that lets the model synthesize outward actions from
  untrusted triggers.** An autonomous action from a watcher is only ever an *exact bundle the owner
  froze and approved when the watch was created* (the application-confirmation rule, generalized).
  Everything else a watcher can do is *surface to the owner* — a notice or a suggestion — never an
  outward side effect.
- **Not a new autonomy tier.** Watchers and the briefing run under the existing trust/taint gate,
  the existing approval spine, and the existing budget guard. If a capability would need a new
  exception to those, it is out of scope.
- **Not always-on polling of the whole inbox/web.** Watchers are bounded (expiry, max-fires,
  explicit match criteria) and the briefing runs on a cadence, not a hot loop.
- **Not a replacement for missions.** A mission is open-ended work the assistant *performs*. A
  watcher is a *condition* it waits on. They compose (a watcher can hand off to a mission) but they
  are different primitives.

## The bad version we are explicitly avoiding

The tempting version is a rules UI where the owner writes "when I get an email about my flight, book
a cab" and the model reads the email and does whatever it decides. That collapses the entire
security model: the trigger is **untrusted content**, and we would be letting untrusted content
choose and parameterize an outward action. The application-confirmation flow already solved this the
right way — the owner approves *every literal argument of the future action up front*, the untrusted
email only *selects which frozen bundle fires* (authenticated sender + opaque token), and execution
is **deterministic and never routes through the model**
(`packages/modules/src/google/application-confirmations.ts`). This design generalizes that solution;
it does not relax it.

## What already exists (this design mostly wires it together)

| Capability | Where | Reused as |
| --- | --- | --- |
| Owner-approved *watch* holding every frozen future side-effect arg | `applications.watch_confirmation` (`packages/tools/src/applications.ts:151`), `application_confirmations` table (`packages/db/src/schema.ts:383`) | The prototype for the general `watches` row + the `frozen_action` tier. |
| Deterministic match of untrusted inbound mail → frozen action | `processApplicationConfirmation` (`packages/modules/src/google/application-confirmations.ts:578`); authenticated sender + opaque-token match, ambiguity → change nothing + escalate | The email-watch matcher, generalized. |
| Deterministic, model-free execution of the frozen bundle | `executeApplicationConfirmationTask` (`application-confirmations.ts:376`): idempotency keys, ledger reconciliation, "unknown ⇒ suppress retry" | The `frozen_action` firing path. |
| Proactive expiry + owner notice for a watch that never fires | `reapExpiredApplicationWatches` (`application-confirmations.ts:525`) | Watch expiry, generalized. |
| Cron schedules, idempotent per firing, with **code-job** templates | `runDueSchedules` (`packages/core/src/workflow/schedules.ts:292`), `template.job` (`schedules.ts:360`) | The briefing runs as a scheduled code-job. |
| Priority/deadline-derived cadence | `goalAutomationCadence` (`schedules.ts:56`) | The model for a per-agent briefing cadence. |
| Code-job dispatch (runs a registered fn, not the model loop; meters cost; can yield/resume) | `CodeJobName` + `runCodeJob` (`packages/core/src/memory/jobs.ts:29`) | Add `briefing.compose` and `watch.poll_web` here. |
| Reduced registry for untrusted / no-outward-tool context | `packages/tools/src/registry.ts:26-31` (`outwardFacing` dropped), taint gate `executor.ts:1098,1138` | The registry a `suggest`-tier watcher and the briefing run under. |
| Off-dashboard owner delivery | `owner.notify` (`packages/tools/src/builtin/index.ts:471`), `notifyOwnerBySms` (`packages/modules/src/sms/channel.ts`), `notifyOwner` dep (`executor.ts:142`) | Briefing + watch-hit delivery. |
| Voice rewrite with fact-preservation check | `rewriteInVoice` (`packages/core/src/voice.ts:63`) | The briefing is composed in the owner's voice. |
| "Reference data, never instructions" framing for carried untrusted text | `sessionInstruction` (`missions.ts:94`), `goalInstruction` (`schedules.ts:131`) | How trigger content is presented to any model step. |

The materials are in place. The gaps are: (1) the watch primitive is hard-coded to job applications;
(2) nothing composes a standing digest; and (3) there is no owner-facing *suggestion* surface — only
approvals (tied to an already-queued tool call) and needs-attention.

## Architecture

### One primitive: the `watches` table

A `watches` row is a durable, owner-owned condition. It generalizes `application_confirmations`
without touching it — the hardened application path keeps working as-is; folding it onto `watches` is
a later, optional cleanup (see Open questions), not a v1 requirement.

```
watches
  id, agent_id, conversation_id
  kind          'email' | 'web'                    -- how the trigger is observed
  tier          'notify' | 'suggest' | 'frozen_action'
  name, description
  match         jsonb   -- email: {expectedSenderEmails[], tokenHint?, keywords?}
                        -- web:   {url, selector?, mode: 'hash'|'text'}
  frozen_action jsonb   -- ONLY for tier='frozen_action': a policy-template-shaped bundle
                        --   (reuses the constrained-template idea from approval policies)
  status        'active' | 'fired' | 'expired' | 'cancelled'
  expires_at, max_fires, fire_count, last_fired_at
  provenance    jsonb   -- planner/prompt versions, model, created_via (same shape as tool_calls.decision)
```

Watches are created through the normal tool + approval path (a `watch.create` tool, `risk: approval`
when `tier='frozen_action'`, `risk: autonomous` for `notify`/`suggest` since those take no outward
action). A `frozen_action` watch's approval dialog shows the *exact* future action, exactly as
`applications.watch_confirmation` does today (`approvalSummary`, `applications.ts:160`).

### The three tiers — the whole safety story is which tier can do what

| Tier | On match, it… | Model sees untrusted trigger? | Can take an outward action? |
| --- | --- | --- | --- |
| `notify` | posts a notice + `owner.notify` | no | no |
| `suggest` | drafts a *suggestion* (reduced registry, taint-on) and surfaces it | yes, as **reference data only** | no — the owner accepting the suggestion creates a normal, approval-gated task |
| `frozen_action` | runs the frozen bundle deterministically (no model) | **no** | yes, but only the exact pre-approved bundle |

This table is the design. The invariant it encodes: **untrusted content can select and it can
inform the owner, but it can never author an outward action.** `frozen_action` fires a bundle the
owner already read and approved; `suggest` produces text the owner must still act on; `notify` is
inert. A watcher never widens the registry the trigger's trust level would otherwise allow.

### Matching

**Email watches.** Extend the inbound-mail hook that already runs `processApplicationConfirmation`
(driven from `email-sync`) to also run a general `matchWatches` pass over `kind='email'` rows. Same
gate: only `input.authenticated` mail (receiver-authenticated, From-aligned SPF/DKIM/DMARC —
`ApplicationConfirmationInput.authenticated`) is eligible. Candidate = sender ∈
`expectedSenderEmails`; refine by `tokenHint` (opaque-token hash match, reuse
`confirmationTokenHashes`, `application-confirmations.ts:53`) and/or owner-supplied `keywords`.
Ambiguity (a `frozen_action` match against >1 watch) copies the existing rule exactly: **change
nothing, mark needs-attention, tell the owner** (`reportAmbiguous`, `application-confirmations.ts:93`).

**Web watches.** A new scheduled code-job `watch.poll_web` fetches each active `kind='web'` row's
URL through the **existing sandboxed `web.fetch`** (public-read, egress-restricted — the same worker
that already blocks WebRTC and arbitrary egress), extracts the configured selector/text, hashes it,
and fires on change from the stored hash. Polite polling: honor `ETag`/`Last-Modified`, exponential
backoff on failure, and a per-watch min interval. A transient fetch failure must **not** count as a
change.

> **Status: built (notify-tier v1).** The `notify`-tier web watch ships. The owner creates one with
> the `watch.web` tool (`packages/tools/src/watches.ts`) — `{ url, mode, pattern?, intervalMinutes }`
> — and `pollDueWebWatches` (`packages/modules/src/watches/web-watches.ts`) runs as a **sweep step**,
> claiming due rows atomically (bump `next_poll_at`, so a concurrent instance claims none), fetching
> through `fetchPublicWebPage`, and firing through the shared `recordWatchFire`. Detection
> (`webWatchOutcome`, `packages/tools/src/web-watches.ts`) is deterministic and never enters a model
> context; it records a baseline on the first poll and fires only on a transition. Modes shipped:
> `change` (content hash), `contains`, `absent` — `pattern`-based rather than the `hash`/`text` +
> `selector` sketch above. A bot-challenge wall or fetch error never counts as a change and, after
> five consecutive failures, expires the watch with one owner notice. Deltas from this design, still
> deferred: promotion to a durable, cost-metered **code-job** (v1 is a sweep step); CSS-`selector`
> scoping; `ETag`/`Last-Modified` conditional polling; and the `suggest`/`frozen_action` tiers.

### Firing

- **`frozen_action`** → enqueue an `internal` task carrying `{ kind: 'watch_fire', watchId }` and run
  it through a deterministic worker modeled on `executeApplicationConfirmationTask`
  (`application-confirmations.ts:376`): status-guarded transitions, per-action idempotency keys,
  ledger reconciliation, and the **"provider result unknown ⇒ suppress automatic retry"** rule
  (`applications.ts:396`). The model is never in this path.
- **`notify`** → post a notice into the watch's conversation + `notifyOwnerBySms`. No task, no action.
- **`suggest`** → one bounded model call, **reduced registry (read + `owner.notify` only), taint
  flag on**, trigger content injected as *reference data, never instructions* (the
  `sessionInstruction` framing, `missions.ts:94`). Output is a **suggestion**, not an action.
  **Shipped** with the registry guarantee obtained structurally instead: `watch.suggest` is a code
  job and holds no tools whatsoever (same precedent as the briefing).

### The suggestion surface

> **Status: built.** `packages/core/src/workflow/suggestions.ts` plus the `suggestions` table,
> surfaced as an inline card in chat (`apps/web/app/chat/[id]/inline-suggestion.tsx`) with
> accept/dismiss. Shape as designed, with `origin` and `source_ref` added: `source_ref` is unique
> per agent, so a producer that runs on a schedule re-proposes nothing the owner already answered —
> without it a daily briefing would re-ask the same question every morning.
>
> Accepting enqueues an owner-trust `adhoc` task carrying the proposal as its instruction, exactly
> as designed — and stamped `taintedOrigin`, because the proposal was written from a third party's
> email. Without that the accepted child would start clean and its outward calls would run
> unapproved, which is the laundering hole `task.schedule` already closes. So accepting buys one
> decision, not an exemption: an event on the owner's own calendar goes through, and anything
> reaching a person still stops for approval.
>
> Snooze shipped as the card's "Later" button (default +24h; the core `snoozeSuggestion`
> carries the expiry out with it, so "later" means later). There is still no standalone
> dashboard page — suggestions live where they are raised.
>
> The iOS app answers the same card through `POST /api/mobile/v1/suggestions/{id}` with
> `{"decision": "accepted" | "dismissed" | "snoozed"}` — the same use cases as the web buttons,
> `snoozed` being "Later". It reads the card from the ordinary chat payload, hydrated like the web's.

`suggest`-tier watchers and the briefing both need to say "I noticed X — want me to Y?" and have
"Yes" *create* the work. Approvals don't fit (they attach to an already-queued tool call); needs
-attention is a dead-end status. Recommendation: a lightweight **`suggestions`** concept —
`{ id, agent_id, conversation_id, summary, proposed_action (a planner seed), status:
pending|accepted|dismissed|snoozed, expires_at }`. Accepting enqueues an ordinary owner-trust task
through the planner, so *every* resulting outward action still hits the normal approval spine. This
keeps the "watcher authored nothing outward" invariant intact: the suggestion is inert text until
the owner promotes it, and promotion runs the full pipeline. (Alternative considered: reuse the
approvals table with a `suggested` flag — rejected; it muddies the "an approval == a frozen queued
call" meaning that the executor and SMS `YES A7` flow rely on.)

### The briefing

> **Status: built.** `runBriefing` (`packages/core/src/workflow/briefing.ts`) runs as the
> `briefing.compose` code job on the seeded `daily-briefing` schedule. Deltas from the design below:
> its inputs are the `email_ingest` ledger (what arrived and how the importance pass scored it),
> upcoming dates lifted from those rows, `needs_attention` tasks, pending approvals, the next 36
> hours of calendar with deterministic conflict pairs (via a `calendarReader` the composition root
> supplies from the google module — absent without it), goal deltas in the window, watcher hits, and
> still-open suggestions. Routine calendar events and open suggestions are context, never a reason
> to deliver (`briefingHasNews` is the pure predicate); a conflict is. Voice rewrite is deliberately
> not applied: the assistant is its own identity, so the briefing speaks in the assistant's voice,
> not the owner's. It is seeded **enabled** rather than off, which is safe precisely because of the
> no-fabricated-urgency rule below: with nothing to report it delivers nothing, and while mail
> ingest is off there is nothing to report at all. The "composed under a reduced registry" guarantee
> is obtained more strongly than designed — a code job holds no tools whatsoever.

A per-agent standing **schedule** whose `taskTemplate.job = 'briefing.compose'` — a new
`CodeJobName` (`memory/jobs.ts:29`). It reuses everything: idempotent firing
(`schedule:<id>:<next_run_at>`), cost metering to the task, retry/dead-letter machinery.

The job:

1. **Assembles structured inputs** — today+next-N-days calendar and conflicts, `needs_attention`
   tasks, pending approvals (count + summaries), mission/goal progress *deltas since the last
   briefing*, watcher hits, and open suggestions. These are owner-privileged, mostly non-tainted
   sources.
2. **Composes** with one bounded model call under a **read-only + `owner.notify` registry** and the
   voice profile (`rewriteInVoice`, `voice.ts:63`). Running with no outward tools reachable is the
   structural guarantee the briefing can't be steered into an action — the same mechanism untrusted
   tasks already rely on (`registry.ts:26`).
3. **Delivers** into the primary thread + `owner.notify`.

Two disciplines carried over from elsewhere in the codebase:

- **No fabricated urgency.** The briefing may claim only what the structured inputs support — the
  response-contract stance (`packages/core/src/workflow/response-contract.ts`) applied to a digest.
  Empty day ⇒ a one-line "nothing needs you," or skip entirely (owner setting). No inventing a
  reason to ping.
- **Taint isolation.** If the briefing summarizes email subjects/senders, that content is tainted;
  it may inform the owner-facing digest but must never reach the voice-sample store or any outward
  tool. Since the briefing's only output is *to the owner* and it holds no outward tools, this is
  satisfied by construction — but the test matrix pins it (no tainted content reaches
  `writing_samples`).

Cadence comes from an owner setting (default: weekday morning in `agent.timezone`, mirroring
`goalAutomationCadence`'s `15 9 * * *` daily shape). Default **off** until the owner opts in.

## Hard properties (the acceptance bar)

1. **No autonomous outward action outside a frozen, owner-approved bundle.** Only `frozen_action`
   watchers act, and only the exact bundle approved at creation. Enforced in code (deterministic
   worker + policy-template-shaped `frozen_action`), not prompt.
2. **Untrusted trigger content never becomes an instruction.** `frozen_action` execution never
   routes through the model; `suggest`/briefing model steps run with a reduced registry and inject
   trigger content as reference data only.
3. **No false positives.** A watcher fires only on an explicit, owner-set match (authenticated
   sender + opaque token/keywords; a real content-hash change). Ambiguous ⇒ change nothing +
   escalate.
4. **Idempotent + at-least-once safe.** Same discipline as schedules and confirmations:
   `externalEventId` dedupe, status-guarded transitions, ledger reconciliation, unknown-provider ⇒
   suppress retry.
5. **Bounded.** Every watch has an expiry and a max-fire count; the briefing and web polling respect
   the per-task/daily/monthly budget guard. A misconfigured or hostile watcher cannot exceed its
   fire cap or its budget.

## Phased rollout

- **Phase 1 — `notify`-tier email watchers. ✅ Shipped.** `watches` + `watch_fires` tables,
  `watch.create`/`watch.list`/`watch.cancel` tools, the `matchEmailWatches` pass wired into the
  existing inbound-mail hook (side-effect only — it never short-circuits normal triage), and an
  expiry reaper on the sweep. Zero autonomous action ⇒ lowest risk, immediate "it noticed" value.
  Firing is idempotent per (watch, message) via the `watch_fires` unique index.
- **Phase 2 — the briefing + suggestion surface. ✅ Shipped.** `briefing.compose` code-job,
  `suggestions` table and inline surface (with snooze), and `suggest`-tier email watchers
  (`watch.suggest` code job; `watch_fires.excerpt` carries the bounded trigger text). The
  per-agent cadence setting remains owner-side schedule editing (pause/resume in Settings).
- **Phase 3 — web-change watchers.** `watch.poll_web` code-job over sandboxed `web.fetch` with
  polite polling.
- **Phase 4 — `frozen_action` tier, generalized.** Lift the application-confirmation execution
  discipline into a general frozen-bundle worker; optionally reimplement `application_confirmations`
  on top of `watches` (behind tests, no behavior change).

## Regression contract (test matrix)

A watcher/briefing scenario is "supported" only when the ledger, task/watch state, provider result,
and owner-visible output all agree — the same bar as `docs/complex-workflow-test-matrix.md`.

| Scenario | Required outcome |
| --- | --- |
| Authenticated mail matches one `notify` watch | One notice + one owner ping; no task, no outward call; fire_count increments once |
| Match is replayed / late / from a forged (unauthenticated) sender | Accept once; ignore replays and unauthenticated mail; change nothing |
| Authenticated mail matches >1 `frozen_action` watch | Change nothing, mark needs-attention, tell the owner (parity with `reportAmbiguous`) |
| `frozen_action` fires | Exactly the approved bundle runs, once; idempotent under redelivery; provider-unknown suppresses retry |
| `suggest` watcher on untrusted mail | Produces a suggestion only; the model step has no outward tool in registry; accepting it runs the full approval pipeline |
| Web watch, content changes once | Fires once per distinct change; transient fetch failure never fires; egress sandbox intact |
| Watch window closes with no match | Reaped to `expired` with an owner notice (parity with `reapExpiredApplicationWatches`) |
| Briefing, ordinary day | Digest composed only from the structured inputs; no outward tool reachable; delivered to owner in voice |
| Briefing, empty day | One-line "nothing needs you" or skip per setting; no fabricated urgency |
| Briefing taint | No tainted email content reaches `writing_samples` or any outward tool |
| Cost | Briefing + web polling respect per-task/daily ceilings; a watcher cannot exceed max_fires or budget |

## Rejected alternatives

- **A model-driven rules engine** ("when X, do whatever you think"). Rejected: lets untrusted
  triggers author outward actions. The frozen-bundle + suggestion split is the whole point.
- **Autonomous model workflows on watch fire.** Rejected for the same taint reason; autonomous fire
  is `frozen_action`-only.
- **The briefing as a mission.** A mission is stateful open-ended *work*; the briefing is a
  stateless recurring *render*. A scheduled code-job is the right primitive and reuses more.
- **Suggestions reusing the approvals table.** Rejected: an approval means "a concrete tool call is
  queued and frozen"; a suggestion has no queued call yet. Overloading it weakens the SMS `YES A7`
  and executor invariants.

## Open questions

- **Suggestion surface:** dedicated `suggestions` table (recommended) vs. an approvals subtype.
- **Fold `application_confirmations` into `watches` now or later?** Recommend later (Phase 4), behind
  tests, no behavior change — do not disturb the hardened flagship path in v1.
- **Web-watch politeness + robots:** default min interval, `robots.txt` honoring, and whether web
  watches are owner-only by trust (recommend yes).
- **Briefing default cadence and opt-in:** weekday-morning default, off until opted in — confirm.
