# Long-running chat: one thread + auto-recall

Design for a single, effectively forever-running chat that never grows the model context without
bound. The live prompt stays a bounded recent window; older discussion is reached back into on
demand through the pgvector store we already populate. "Topics" are a soft, derived label over the
one thread — **not** separate hidden conversations behind a router.

Status: **All phases (1–4) are implemented** — auto-recall, topic segments, the single-thread UI,
and the "recalled from earlier" transparency affordance. See the rollout section for what shipped
where.

## GraphRAG extension

GraphRAG adds a second, explainable retrieval path over **durable personal memories**. It does not
replace conversation segments, message recall, or the memory library: every graph relationship is
extracted from exactly one active source memory, and the source fact remains the evidence the model
receives.

- `knowledge_graph_entities` holds canonical people, organizations, projects, places, events, dates,
  and topics. Person nodes link to existing contacts when names resolve — on an exact name or alias
  match, or on an unambiguous short-name prefix ("Anna" ≡ "Anna Jónsdóttir"), the same rule contact
  dedup uses. An ambiguous prefix links nothing rather than guessing.
- Date entities carry a canonical key (`date:2026-03-06`, `date:2026-03`, `date:--03-06`, `date:2026`)
  rather than the extractor's wording, so "Friday", "next Friday" and "2026-03-06" are one node.
  Relative wording resolves against the **source memory's own timestamp**, never the current time, so
  a re-extraction lands on the same node forever. Wording that denotes no fixed date takes its edge
  down with it: an unmergeable "some point next quarter" node is worse than no edge.
- A display label is only replaced by a better one — a contact's name and a canonical date always
  win; otherwise a properly-cased or longer spelling wins and ties keep what is stored. Extraction
  used to rewrite the label every run, so a name flip-flopped with whichever run went last.
- `knowledge_graph_relations` holds only direct, source-backed triples; it never stores a relationship
  inferred by traversal. `knowledge_graph_sources` checkpoints the source content hash so edits are
  re-extracted and forgotten/deleted memories cascade away.
- The offline `memory.graph_sync` job backfills and reconciles graph sources in small batches
  (`GRAPH_SYNC_BATCH_LIMIT`, default 25, twice an hour). It is never on the response hot path. Its
  run summary reports what the run spent, and the review page prices the remaining backlog from
  recent actuals rather than a hardcoded per-source figure.
- The nightly `memory.graph_date_backfill` job re-canonicalizes existing date entities from labels
  the graph already holds, folding duplicates together through the same merge path owner-driven
  merges use. It makes **no model calls** and is budgeted at zero. Sources whose dates only an
  anchored extraction prompt can resolve are counted, not queued: re-reading them costs one call
  each, so it is an explicit control on the review page. A blanket extraction-version bump was the
  alternative and was rejected — it would re-extract the whole corpus and, because recall gates on
  the version, take every existing edge out of recall until the backlog drained.
- A transient extraction failure retries after 15 minutes, 1 hour, then 6 hours. A fourth failure
  quarantines that unchanged source instead of spending every scheduler run on it; a source edit or
  extraction-version change starts a fresh attempt. The daily deterministic health check tells the
  owner about quarantined/stale graph work, an indexing backlog of two or more sync batches, and
  recurring final-response quality failures; durable alert state suppresses duplicate daily notices
  and sends a weekly reminder until resolution.
- Every recalled direct edge carries a contiguous quote from its source fact proving its endpoints
  and predicate. When this extraction contract changes, sources are versioned and rebuilt offline;
  legacy edges stay out of graph traversal until they have the new evidence.
- The extractor works from the typed predicate registry in
  `packages/core/src/memory/predicate-vocabulary.ts` — the same registry the review page's
  add-relationship form draws its suggestions from, so extracted and owner-authored edges share one
  wording. Predicates read subject → object (`Gunnar father_of Anna`), carry kind-pair applicability
  plus inverse/symmetric metadata, and are grouped as family, biography, work and education, and
  events. A relationship with a stated span (a job, a course, a marriage) stores it as
  `valid_from`/`valid_until` canonical date keys on the edge itself, copied only from wording present
  in the evidence quote — an unquoted or unparseable span is dropped, never the edge — and recall
  renders the span on the path so time-aware questions have the dates to reason over.
- Evidence grounding matches on whole words, not substrings: "Ann" cannot ground a fact about
  "Anna", and a predicate word cannot ground itself inside a longer word. Endpoints, predicate
  words, evidence quote, and qualifier wording all follow the same word-boundary contract.
- Merges and owner-authored facts are single transactions. Merging enforces that both entities
  belong to the agent (the function is exported, so it cannot trust callers), and afterwards
  removes the self-loops and duplicate semantic edges the repoint created — keeping the
  owner-reviewed edge when duplicates disagree.
- The review page's "active" edges are exactly the recall-eligible ones (ready checkpoint, current
  hash and extraction version, live embedded memory, quoted evidence). The audit list still shows
  every source-backed edge, flagging any the graph cannot currently traverse as "Not in recall".
- A recall query first has to clear the existing semantic-similarity threshold against a source memory.
  Only then can it follow incoming/outgoing relationships up to two hops. The injected block contains
  the original evidence facts and labels every two-hop connection as context, not a conclusion.
- Graph results and conversation recall share one query embedding and a bounded prompt budget. Any
  graph failure falls through to the existing vector/segment recall path.
- Both recall entry points emit privacy-preserving counters (graph attempt/failure, candidates used,
  history availability/tier, and source count), never query text, embeddings, memory text, or recall
  blocks. A failure in one retrieval layer preserves evidence from the other; the health monitor
  raises an owner alert when GraphRAG or conversation recall repeatedly falls back within 24 hours.
  These operational counters are automatically purged after 90 days; they do not follow the owner's
  conversation-history retention policy.

Graph retrieval is guarded by both `CHAT_RECALL_ENABLED` and `GRAPH_RAG_ENABLED` (both default
false), and inherits owner-private, untainted-context gating. Reply provenance carries
`kind: "knowledge_graph"` and an optional hop count so web and iOS can say when the graph informed a
response.

### Owner review and curation

`/profile/knowledge` is the owner-only review surface. It deliberately draws a **local map** around
one selected entity instead of an unbounded global canvas, then lists the underlying connections with
their source memory, extraction confidence, source trust, and review time. The owner can:

- confirm an extracted relationship or mark it stale; stale edges remain auditable but are excluded
  from GraphRAG recall;
- rename an entity's display label without changing its extraction identity, change its kind
  (retype), or merge duplicate entities; aliases record the old canonical keys so future syncs keep
  using the chosen entity. Dates cannot be retyped — their identity is the canonical date key, not
  a label — and a retype that would collide with an existing entity declines in favour of a merge;
- add a relationship manually only with an owner-written source note. That note is saved as a normal,
  owner-confirmed durable memory and is the relationship's evidence — never a graph-only assertion.
  The form adapts to the chosen kinds: dates use structured day/month/yearly inputs that can never
  fail to parse, other kinds search-and-pick existing entities (a typed name that matches nothing is
  created), and the predicate field suggests the vocabulary for the chosen kind pair.

The selected entity's connections have four views behind a switcher. **Explorer** (the default) is
a vertical outline grouped by predicate family — the registry's family/biography/work/events
groups, with custom predicates under Other — where each row shows direction, predicate, the linked
entity, its span, and review state, and a toggle folds one more hop in underneath. An outline
rather than a tree: a row on its own ancestor chain is never re-expanded, so cycles stay finite.
**Map** is the interactive radial SVG (pan/zoom, select-to-act toolbar, per-kind arc sectors with
"+N more" pills) kept as the spatial overview. **Paths** is the managed flowchart: up to eight
curated chains out from the entity, each continuing at most one hop and never revisiting an entity
in its own chain, rendered as plain vertical lists of links — no layout math, no overlap. **Details**
is the complete compact table of active connections (direction, predicate, entity, type, dates,
status). All four draw from the same recall-eligible query and state their true totals; review
actions stay with the evidence cards below. Entity lists page and report their true totals; the
sidebar filters by entity kind; the merge target is found by searching the whole graph rather than
picking from a fixed prefix of it.

Relationship review state is keyed to the source-memory relationship fingerprint. Re-extracting a
changed memory refreshes the direct edge while retaining a matching owner decision.

## Goal / non-goals

**Goal.** The owner keeps talking in one continuous chat. When the current message relates to
something discussed long ago (outside the recent window), the relevant earlier discussion is pulled
back into context automatically, summarized, without the owner having to search for it.

**Non-goals.**

- Not a literal forever-context — we never hand the model an ever-growing message list (see below).
- Not a topic router that files each message into a hidden per-topic conversation. We considered it
  and rejected it (see _Rejected: hidden threads + router_).
- Not a change to how untrusted (email/SMS-from-strangers) tasks build context — recall is
  owner-privileged only.

## The bad version we are explicitly avoiding

A single ever-growing prompt fails three ways: unbounded cost, unbounded latency, and _context rot_
— models get **worse** with very long, low-signal context, not better. The whole point of this
design is bounded live context + retrieval, never "just keep appending."

## What already exists (this design mostly wires it together)

| Capability                          | Where                                                                                                                                                        | Reused as                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Bounded live window                 | `apps/web/app/api/chat/route.ts` (`MODEL_HISTORY_LIMIT = 40`, `boundedModelHistory`); executor `.slice(-20)` at `packages/core/src/workflow/executor.ts:487` | The live context. Unchanged.                                                    |
| Per-message embeddings + HNSW index | `packages/db/src/schema.ts:133-155` (`messages.embedding vector(1536)`, async backfill index)                                                                | The recall store.                                                               |
| Semantic search over past chats     | `conversations.search`, `packages/tools/src/builtin/index.ts:428-468`                                                                                        | The retrieval query, promoted from a model-invoked tool to automatic injection. |
| Durable-fact recall + owner card    | `memory.recall` (`builtin/index.ts:105-160`), `getOwnerCard`, consolidation in `packages/core/src/memory/`                                                   | Complementary; recall of _episodes_ is what this adds.                          |
| Trust gating of private context     | `executor.ts:1057-1058,1072` (`privilegedTask && !state.untrustedContext`)                                                                                   | The gate recall must copy.                                                      |

The materials are in place. The gap is: (1) `conversations.search` only fires if the _model chooses_
to call it — we want relevant history injected automatically; and (2) the retrieval unit (isolated
messages) is too noisy to inject blindly.

## Architecture

### One thread, soft segments

Everything stays in one `conversations` row. A **segment** is a contiguous run of messages on one
topic within that thread — a derived index, never a separate conversation. Wrong segment boundaries
only slightly degrade retrieval; they can never misfile the live conversation. That reversibility is
the entire reason we prefer this over a router.

### Retrieval unit — segments, not lone messages

Injecting individual matched messages is noisy: `"yes, do that"` embeds poorly and means nothing out
of context. Two tiers:

- **Tier 1 (ship first, no schema change).** Match the incoming message against existing
  `messages.embedding`. For each hit, expand to its _neighborhood_ (the matched message ± a few
  adjacent messages in the same conversation) and dedupe overlapping neighborhoods. Inject the
  neighborhood, not the lone line.
- **Tier 2 (durable answer).** A `conversation_segments` table holds a rolling summary + one
  embedding per segment. Recall matches _segment-summary_ embeddings and injects the summary
  (optionally plus 1–2 verbatim key lines). Summaries retrieve far better than raw turns and are
  cheaper to inject.

### Automatic recall, each owner turn

Before building the model context:

1. Embed the incoming user message (injected embed fn, same pattern as tools' `deps.embed`).
2. Retrieve top-K segments/neighborhoods that are **older than the live window** and score **≥ τ**
   cosine similarity.
3. If nothing clears τ, inject nothing. A fresh topic must not drag in stale, loosely-related
   history — "no false memories" is a hard property, not a nicety.
4. Build a compact **Relevant earlier context** block: per segment, a dated one-line summary and at
   most 1–2 verbatim lines. Hard-cap the whole block (≈ K ≤ 5 segments, ≤ ~1.5–2 KB).
5. Inject via `buildSystemPrompt` extras (same mechanism as `ownerCard`, `chat.ts:73-79`) or as a
   leading system chunk. Recommend the extras path so both chat routes share it.

### Window exclusion (critical)

Recall must exclude anything already in the live tail — match only messages with `createdAt` older
than the oldest message in the current window (or by segment non-overlap). Re-injecting recent
context wastes the budget and teaches the model nothing.

### Trust gating (critical)

Recall injects owner-private history, so it runs **only** when `privilegedTask && !untrustedContext`
(mirror `executor.ts:1057-1058,1072`). An email-triage or unknown-sender task never receives it.

### Shared implementation point

Put the logic in core — e.g. `packages/core/src/memory/recall.ts`, `recallRelevantContext({ db,
agentId, conversationId, queryText, window, embed, trust })` → a bounded string block or `null`.
Both callers use it:

- **Streaming path:** `apps/web/app/api/chat/route.ts` — after `boundedModelHistory` (~line 215),
  feed the block into `buildSystemPrompt(agent, { ownerCard, recall })` at ~line 299.
- **Executor path:** `packages/core/src/workflow/executor.ts` — system assembly at line 1070; the
  query is the latest user turn from the window built at line 487.

## Schema

Tier 1 needs **no** schema change (reuses `messages.embedding`).

Tier 2 adds one table (sketch):

```
conversation_segments
  id                uuid pk
  agent_id          uuid → agents
  conversation_id   uuid → conversations
  start_message_id  uuid → messages
  end_message_id    uuid → messages
  summary           text
  embedding         vector(1536)          -- hnsw vector_cosine_ops, matches existing dim
  message_count     int
  started_at        timestamptz
  ended_at          timestamptz
  created_at / updated_at
  -- index: (agent_id, conversation_id, started_at); hnsw on embedding
```

Optional convenience: a nullable `messages.segment_id`. Not required if ranges live on the segment
row.

## Segmentation (soft, offline)

Segments are computed by the existing maintenance/consolidation pass (`packages/core/src/workflow/
maintenance.ts`, `packages/core/src/memory/consolidation.ts`), never on the hot path. Boundary
heuristic, cheapest first:

1. **Time gap** — a long quiet gap starts a new segment.
2. **Embedding drift** — cosine distance between consecutive message-windows crossing a threshold.
3. **LLM boundary/summary pass** (low cadence) — the `classify`/`extract` roles already exist; use
   them to place boundaries and write the rolling summary.

Start with (1)+(2) to bootstrap, layer (3) for summary quality. Re-segmentation is idempotent and
safe to re-run.

## Failure modes & mitigations

| Risk                                         | Mitigation                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Recall miss feels like amnesia               | Keep `conversations.search` available as an explicit tool; Tier-2 summaries lift recall over raw-message matching. |
| Irrelevant history injected (distraction)    | τ threshold + hard K/byte caps; inject nothing when nothing clears τ.                                              |
| Re-injecting recent context                  | Window-exclusion by `createdAt`/segment non-overlap.                                                               |
| Leaking private context into untrusted tasks | Gate on `privilegedTask && !untrustedContext`.                                                                     |
| Embedding lag on new messages                | Recall only needs _older_ messages, which are already backfilled; recent turns are in the live window regardless.  |
| Wrong segment boundaries                     | Soft degradation only — never misfiles the live thread (the router failure mode we avoided).                       |

## UX (phase 3 — implemented)

`/chat` opens one canonical **primary** thread by default: it redirects to `/chat/{primaryId}`,
resolved by `getOrCreatePrimaryConversation()` (`packages/core/src/chat.ts`), which is _sticky_ — the
primary is un-archived and returned if it exists, else the most recent non-goal chat is promoted,
else a fresh thread is created. The flag lives on `conversations.is_primary` with a partial unique
index (one primary per agent). The full list of threads stays reachable at `/chat/all` (a new
"All chats" nav item); "New chat" still spawns separate threads that recall stitches back in. The
main thread can't be archived (guarded in `apps/web/app/chat/actions.ts`); archive/restore of other
threads is unchanged. When recall fires, the assistant turn shows a "↩ Recalled from earlier"
affordance (Phase 4).

## Integration with goals, tasks, retries, approvals

Recall is additive context injection — it does not touch the task state machine, so everything that
runs on tasks keeps working unchanged:

- **Async / running tasks** carry a `conversationId` (`schema.ts:170`) and post their result back
  into that conversation (`chat.ts:254-263`). Work kicked off from the primary thread reports into
  the primary thread.
- **Retries** are task-level and crash-safe — `attempt`, `maxSteps`, the `lockedUntil` lease, and
  the checkpointed `state.contextWindow` (`schema.ts:192-197`). They resume from checkpoint
  independent of how the chat window is assembled. Recall never rewrites history or gates execution.
- **Approvals, budget guards, missions** all hang off a task → conversation. Unchanged.

**Seam — autonomous work runs in its own threads today.** A goal creates a separate conversation
titled `"Work: {goal.title}"` with `metadata.goalId` (`apps/web/app/goals/actions.ts:112-121`); a
mission reports progress into _that_ conversation (`packages/core/src/workflow/missions.ts:240-251`),
not the primary chat. Two ways to reconcile with "one discussion":

- **A (default).** Keep work threads separate but reachable. The primary thread's auto-recall spans
  all threads (embeddings are channel/thread-agnostic), so asking about a goal in the primary thread
  surfaces the mission's latest update — without a chatty mission flooding the main feed.
- **B (implemented, per-goal opt-in).** A goal with `goals.mirror_to_primary` set also has its
  mission `report()` updates mirrored — as a short labeled copy — into the Notifications thread, so
  background progress is discoverable without interrupting the primary conversation's flow (the
  column predates that destination; it now means "mirror to my activity stream").
  `mirrorGoalUpdateToNotifications` (`chat.ts`) is called from mission `report()` (`missions.ts`);
  it no-ops unless the goal opted in, and the work chat still keeps the full record. Toggled from
  the goal create/edit forms. Off by default so a noisy mission never spams uninvited.

Identity is already unified independent of this — one agent, one owner card (`chat.ts:73-79`), one
voice profile — so it already _talks_ like one person. Single-thread + recall adds the continuous
_memory_ to match.

## Rejected: hidden threads + router

Auto-creating a conversation row per topic behind one UI, with a classifier routing each incoming
message, was considered and rejected. A misrouting classifier fragments one topic across threads or
merges two unrelated ones — and it does so on the _live_ conversation where the mistake is visible
and hard to undo. It adds a stateful failure mode for the same user-visible outcome that retrieval
already delivers. Retrieval, not physical thread-splitting, is what makes an old discussion resurface.

## Cost

One embed call per owner turn (already metered through the cost ledger, `cost_events` source
`embedding`). Tier 2 adds periodic summary generation in the offline pass. Injected recall is capped,
so per-turn model cost stays bounded — this design _reduces_ worst-case cost versus any
grow-the-prompt approach.

## Rollout

- **Phase 0 — this doc.** ✅
- **Phase 1 — recall layer, no schema change. ✅ Implemented.** `recallRelevantContext()` +
  `recentWindowStart()` in `packages/core/src/memory/recall.ts` over existing message embeddings
  (neighborhood + dedupe), pulling only from owner/assistant-trust threads. Injected via a `recall`
  extra on `buildSystemPrompt` (`chat.ts`), wired into the streaming path
  (`apps/web/app/api/chat/route.ts`) and the executor chat-turn path
  (`packages/core/src/workflow/executor.ts`, gated on `privilegedTask && !untrustedContext`). Behind
  the `CHAT_RECALL_ENABLED` flag (off by default). Covered by
  `packages/core/src/memory/recall.test.ts` (window exclusion, similarity threshold, trust filter,
  neighborhood expansion, dedup). Behind the `CHAT_RECALL_ENABLED` flag (off by default); turn it on
  and measure recall hit-rate and injected size.
- **Phase 2 — segments. ✅ Implemented.** `conversation_segments` table (migration `0015`) with
  rolling summaries + embeddings, produced by the `chat.segment` code job
  (`packages/core/src/memory/segmentation.ts`, registered in `jobs.ts`, scheduled nightly at 21:00 in
  `seed.ts`). Boundary detection is time-gap + embedding-drift against a running centroid; the
  trailing group is held back until it settles so an in-progress topic isn't split. Recall now
  prefers segment summaries and falls back to message neighborhoods for un-segmented conversations
  (`recall.ts`, `RecallResult.tier`). Covered by `segmentation.test.ts` (boundary split, idempotency,
  settle) and `recall-segments.test.ts` (segment tier + window exclusion).
- **Phase 3 — single-thread UX. ✅ Implemented.** `/chat` → sticky primary thread; the list moved to
  `/chat/all`. `conversations.is_primary` + `getOrCreatePrimaryConversation()`; the main thread is
  archive-protected. Covered by `primary-conversation.test.ts` (create/sticky/un-archive/promote).
- **Phase 4 — transparency affordance. ✅ Implemented.** `recallRelevantContext` returns `sources`
  ({date, label}); the assistant reply persists them as a custom `recall` message part
  (`assistantMessageParts` in `chat.ts`) — no migration, and model history still rebuilds from
  `messages.text`, never parts. Wired on both paths: the streaming route (`finishTask`, plus an
  `x-recall` response header for the live turn) and the executor (`state.recall`, checkpointed, into
  `persistFinalConversationOnce`). The chat client renders a "↩ Recalled from earlier: {date} ·
  {label}" chip on assistant turns and a live note from the header. Covered by `chat-parts.test.ts`
  and `sources` assertions in the recall tests.

## Test plan

- Unit: window-exclusion drops in-window messages; τ threshold with no qualifying history injects
  nothing; trust gate omits recall for untrusted tasks; byte/K caps hold.
- Integration: raise a topic, bury it under 50+ unrelated turns, raise it again → the earlier
  discussion is injected and the answer reflects it.
- Negative: a genuinely new topic injects nothing (no false-memory bleed).

## Open questions

1. ~~Segment boundaries: heuristic-only vs LLM pass.~~ **Resolved:** shipped heuristic boundaries
   (time-gap + embedding-drift) with an LLM-generated summary per segment, plus a naive summary
   fallback when the model is unavailable. Revisit boundary quality once there is real usage.
2. ~~Primary-thread migration.~~ **Resolved:** `getOrCreatePrimaryConversation()` promotes the most
   recent non-goal chat to primary (so an existing owner keeps their real main thread), or creates a
   fresh one; the primary is then sticky.
3. τ and K defaults — still guessed (τ = 0.75, K = 4). Tune from a measurement pass with the flag on.
4. ~~Autonomous-work threads — recall-only vs route-into-primary.~~ **Resolved:** option A is the
   default (recall spans all owner threads); option B ships as a per-goal `mirror_to_primary` opt-in
   that mirrors mission updates into the Notifications thread. Off by default.
