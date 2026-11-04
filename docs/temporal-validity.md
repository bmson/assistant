# Temporal validity

The store records when a fact stopped being true. Retrieval now reads it.

`memories.validUntil` is a timestamp, written by nightly consolidation from validity a fact states
explicitly ("2019–2023", "since March"). `knowledge_graph_relations.valid_until` is text, because the
wording it is quoted from is usually partial ("2019", "March"). Both answer the same question, and
[`packages/core/src/memory/validity.ts`](../packages/core/src/memory/validity.ts) is the one place
that answers it.

## The distinction this protects

Between a fact the assistant _knows_ and a fact that is _still true_. Those had been treated as the
same thing in two places:

- **The owner card** filled its per-domain slots by importance alone. A former employer with
  importance 5 took the slot from the current one and then answered "where do I work".
- **The gap detector** counted `worked_at` as satisfying `works_at`, and `born_in` as satisfying
  `lives_in` — so the one case where the assistant most obviously should have asked was the case it
  stayed quiet in.

Same mistake twice: the past standing in for the present.

## Partial precision

A year means the whole year. `statedPeriodEnd` returns the **end** of a stated period, so "2019"
lapses on 2020-01-01 rather than 2019-01-01, "2019-03" on 2019-04-01, and "2019-03-15" at the end of
that day. Reading a year as its first day would call a fact lapsed for the twelve months it actually
covers — the more damaging direction, because it hides something true rather than keeping something
stale a little longer.

Wording the parser cannot read counts as current, for the same reason: an unreadable date is a gap in
what the assistant understands, not evidence that something ended.

## What changed

**Owner card** (`compileOwnerCard`). Auto-selection now considers only facts that are still current.
A lapsed fact stays in the store, counts toward the omitted total the footer reports, and remains
reachable through `memory.recall` — it just stops competing for a slot it would then answer from.

A **pinned** fact is different: pinning is the owner saying "always tell it this", so a pinned fact
makes the card whether or not it has lapsed. It is labelled rather than dropped.

Validity now reads plainly on every shape. The card previously rendered a span only when `validFrom`
was set, so a fact recording only an END — exactly the rows this is about — appeared unmarked and
read as current:

| Stored                     | Reads as                               |
| -------------------------- | -------------------------------------- |
| from and to, lapsed        | `(past: 2019-01-01–2023-06-01)`        |
| to only, lapsed            | `(past: until 2023-06-01)`             |
| from only                  | `(since 2024-03-01)`                   |
| from and to, still running | `(since 2024-03-01, until 2027-01-01)` |
| to only, still running     | `(until 2027-01-01)`                   |

**Gap detector** (`graph-gaps.ts`). `SATISFIED_BY` is present tense only: `lives_in` is satisfied by
`lives_in`, and `works_at` by `works_at` or `studies_at`. The past-tense forms are gone. A relation
whose own `valid_until` has closed no longer satisfies anything either — the same mistake recorded in
the validity columns instead of the predicate name.

The equivalents existed to avoid over-interrogating the owner. That concern is real and already
answered somewhere better: `proactive/curiosity.ts` asks at most one question per run, runs at most
once a day, and never re-asks a gap it has already put. Pacing is enforced there; treating a
birthplace as a residence was never pacing, it was a wrong answer.

## Nothing is erased

A lapsed fact keeps its row, its provenance, and its place in explicit recall. This is about what
gets offered as _current state_, not about deleting history — the same principle supersession
follows, where a replaced fact expires but is never deleted
([memory supersession](memory-supersession.md)).

## Not covered

- **`memory.recall` ranking.** It already flags a lapsed result `unconfirmed`, which the tool
  description tells the model to treat as unsettled, but a lapsed fact still occupies one of the
  requested slots. Changing retrieval ranking is a larger question than reading a column, so it is
  left alone here.
- **Displaying current, historical, and conflicting claims separately in the UI.** The People and
  knowledge pages already read `validFrom`/`validUntil`; grouping them into distinct sections is
  presentation work, tracked in
  [knowledge-graph-improvements](knowledge-graph-improvements.md).
- **Conflicting claims are not resolved.** Two live facts that disagree both stay, by design.
