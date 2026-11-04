# Memory supersession

A durable fact is retired in two places: immediately, by the write that contradicts it, and nightly,
by consolidation. Both use the same precedence rule and the same provenance. Neither ever deletes a
fact — a superseded row expires and records what replaced it.

## Why the write-time check exists

`memory.save` is an append. Before this check, the only thing that retired a stale fact was the
nightly consolidation sweep, which reviews a bounded number of entities per run
(`MAX_WINDOWS_PER_RUN`). An owner could say "I've moved to Reykjavik", watch the assistant agree and
save it, and still be told their old address the next morning — both facts were live, and both were
eligible for the same recall window.

The correction was never lost; it was late. The write-time check closes that window for the case the
owner is most likely to notice: a fact they just corrected.

## What happens on a save

Only a `knowledge` write from an owner- or assistant-trust task runs the check. An `experience`
episode records that something happened and a later episode does not falsify it, and a quarantined
save is still awaiting review.

1. **Candidates.** Live, unquarantined `knowledge` facts about the _same subject_, ordered by
   embedding distance, above `SUPERSEDE_SIMILARITY_FLOOR` and capped at `MAX_SUPERSEDE_CANDIDATES`.
   Subject scoping is the precision lever: two facts about different people cannot contradict each
   other, and "about no one" is its own bucket rather than a wildcard.
2. **Nomination.** One bounded `classify` call names the candidates the new fact cannot coexist
   with. The prompt asks for same-attribute conflicts only — a new home city replaces the old home
   city; where someone lives and where they work both stay; an explicitly historical statement
   replaces nothing — and says to prefer leaving a fact alone when unsure.
3. **Decision.** The model only nominates. Which nominations are acted on is decided by
   `pickWinner`, the rule consolidation already uses: owner-confirmed beats everything, then
   confidence, then newest. A low-confidence extraction therefore cannot expire a fact the owner
   confirmed by hand, whatever the model claims.
4. **Retirement.** Each retired fact gets `expiresAt = now()` and `supersededById` pointing at its
   replacement. An already-superseded fact is left to its first replacement, so a concurrent save
   cannot overwrite that provenance.
5. **Owner card.** Recompiled only when something was actually retired — the card is a snapshot of
   the live facts that is injected into prompts wholesale, so without this the retired text keeps
   answering.

## Failure behaviour

The check fails open. A budget stop, a provider outage, or an unparseable verdict leaves the save
exactly as it was — appended, with consolidation still due to catch it that night. The tool result
reports the save either way. Losing a correction's _timeliness_ is the bug this closes; losing the
correction itself would be a worse one, so nothing here can fail a `memory.save`.

When a write does retire something, the tool result carries `replacedEarlierFacts` so the assistant
can say it updated a fact rather than silently storing a second version of it.

## Where the code lives

| Piece                                                           | Location                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| Portable contract (types, bounds, repository interface)         | `packages/persistence/src/memory-supersede.ts`              |
| PostgreSQL adapter (candidate query, retirement)                | `packages/db/src/memory-supersede-repository.ts`            |
| Policy and orchestration (`supersedableIds`, the classify call) | `packages/core/src/memory/supersede.ts`                     |
| Precedence rule shared with consolidation                       | `pickWinner` in `packages/core/src/memory/consolidation.ts` |
| Call site                                                       | `memory.save` in `packages/tools/src/builtin/index.ts`      |

The repository is wired in the agent composition root. There is no Firestore adapter yet, so this
domain remains among those gating Firestore runtime activation; see
[the migration status](firestore-implementation-status.md).

## Not covered

Write-time supersession runs on `memory.save` only. Facts arriving through background extraction,
bulk import, the knowledge-graph projection, and the owner's own Profile page still rely on nightly
consolidation. The Profile path is the most natural next one to cover — an owner-typed correction is
the most explicit correction there is — but it currently takes an embedding-only port and would need
a wider one to reach a model.
