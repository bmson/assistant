import type { SituationDecisionContext } from '@assistant/persistence';
import type { RecallMode } from '../workflow/owner-intent.js';
import {
  type ContextCandidate,
  fuseContextCandidates,
  lexicalContextScore,
} from './context-fusion.js';
import type { RecallSource } from './recall.js';
import {
  eligibleAutomaticRecallCandidates,
  situationDecisionRecallMeaning,
} from './recall-eligibility.js';
import { recallSourceRevision, recallSurfaceKey } from './recall-surfacing.js';

export async function fuseOwnerContext(input: {
  queryText: string;
  eligibilityText: string;
  mode: RecallMode;
  rankedContext: ReadonlyArray<ContextCandidate>;
  decisions?: ReadonlyArray<SituationDecisionContext>;
  isSuppressed?: (sourceKey: string, sourceRevision: string) => Promise<boolean>;
  limit?: number;
  maxBytes?: number;
}) {
  if (input.mode !== 'automatic' && input.mode !== 'continuation') {
    return fuseContextCandidates([], { limit: 2, maxBytes: input.maxBytes });
  }
  const candidates: Array<ContextCandidate & { meaning: string }> = [];
  const decisions = (input.decisions ?? []).map((decision) => {
    const text = `${decision.scope} choice in “${decision.packTitle}” [pack ${decision.packId}, version ${decision.packVersion}]: ${decision.outcome} “${decision.option}” because ${decision.reason}`;
    const lexical = lexicalContextScore(input.queryText, text);
    const relevance = decision.relevance / (decision.relevance + 3);
    const source: RecallSource = {
      date: decision.packUpdatedAt.slice(0, 10),
      label: `${decision.outcome}: ${decision.option}`.slice(0, 80),
      kind: 'decision',
      surfaceKey: recallSurfaceKey('situation_decision', [decision.packId, decision.decisionId]),
      sourceRevision: recallSourceRevision({
        packId: decision.packId,
        decisionId: decision.decisionId,
        packVersion: decision.packVersion,
        outcome: decision.outcome,
        option: decision.option,
        reason: decision.reason,
        scope: decision.scope,
      }),
      relevance,
    };
    return {
      source,
      score: relevance * 0.7 + lexical * 0.3,
      text,
      meaning: situationDecisionRecallMeaning(decision),
    };
  });
  // Automatic and continuation recall intentionally omit open commitments
  // until a trusted structured work-purpose signal exists. Explicit owner-list
  // requests are handled separately by the executor's purpose-gated openLoops.
  const mapped = [
    ...input.rankedContext
      .filter((entry) => entry.source.kind !== 'commitment')
      .map((entry) => {
        const lexical = lexicalContextScore(input.queryText, entry.text);
        return {
          ...entry,
          score: entry.score * 0.8 + lexical * 0.2,
          meaning: entry.meaning ?? '',
        };
      }),
    ...decisions,
  ];
  for (const candidate of mapped) {
    const key = candidate.source.surfaceKey;
    const revision = candidate.source.sourceRevision;
    if (!key || !revision || (input.isSuppressed && (await input.isSuppressed(key, revision))))
      continue;
    candidates.push(candidate);
  }
  const eligible = eligibleAutomaticRecallCandidates(
    input.eligibilityText,
    candidates.map((candidate) => ({
      id: candidate.source.surfaceKey as string,
      sourceRevision: candidate.source.sourceRevision as string,
      meaning: candidate.meaning,
    })),
  );
  const eligibleIdentity = new Set(
    eligible.candidates.map((candidate) => `${candidate.id}\u0000${candidate.sourceRevision}`),
  );
  const selectedPool = candidates.filter((candidate) =>
    eligibleIdentity.has(`${candidate.source.surfaceKey}\u0000${candidate.source.sourceRevision}`),
  );
  // Keep automatic surfaced context at two sources; caller-provided values can
  // lower the cap for tests or specialized callers, never raise it.
  return fuseContextCandidates(selectedPool, {
    limit: Math.min(2, input.limit ?? 2),
    maxBytes: input.maxBytes,
  });
}
