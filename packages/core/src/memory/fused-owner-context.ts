import type { OwnerCommitment, SituationDecisionContext } from '@assistant/persistence';
import {
  type ContextCandidate,
  fuseContextCandidates,
  lexicalContextScore,
} from './context-fusion.js';
import type { RecallSource } from './recall.js';
import { recallSourceRevision, recallSurfaceKey } from './recall-surfacing.js';

export async function fuseOwnerContext(input: {
  queryText: string;
  rankedContext: ReadonlyArray<ContextCandidate>;
  decisions?: ReadonlyArray<SituationDecisionContext>;
  commitments?: ReadonlyArray<OwnerCommitment>;
  isSuppressed?: (sourceKey: string, sourceRevision: string) => Promise<boolean>;
  limit?: number;
  maxBytes?: number;
}) {
  const candidates: ContextCandidate[] = [];
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
    };
  });
  const commitments = (input.commitments ?? []).map((commitment) => {
    const source: RecallSource = {
      date: commitment.updatedAt.toISOString().slice(0, 10),
      label: `${commitment.kind}: ${commitment.title}`.slice(0, 80),
      kind: 'commitment',
      surfaceKey: recallSurfaceKey('commitment', [commitment.id]),
      sourceRevision: recallSourceRevision({
        id: commitment.id,
        updatedAt: commitment.updatedAt.toISOString(),
        status: commitment.status,
        contentHash: commitment.contentHash,
        title: commitment.title,
        nextAction: commitment.nextAction,
        dueAt: commitment.dueAt?.toISOString() ?? null,
      }),
    };
    const description = [
      `[${commitment.kind}; ${commitment.status}] ${commitment.title}`,
      commitment.dueAt ? `due ${commitment.dueAt.toISOString().slice(0, 10)}` : '',
      commitment.nextAction ? `next: ${commitment.nextAction}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    const lexical = lexicalContextScore(input.queryText, `${description} ${commitment.details}`);
    source.relevance = lexical;
    return { source, score: lexical, text: description };
  });
  for (const candidate of [
    ...input.rankedContext.map((entry) => {
      const lexical = lexicalContextScore(input.queryText, entry.text);
      return { ...entry, score: entry.score * 0.8 + lexical * 0.2 };
    }),
    ...decisions,
    ...commitments,
  ]) {
    const key = candidate.source.surfaceKey;
    const revision = candidate.source.sourceRevision;
    if (!key || !revision || (input.isSuppressed && (await input.isSuppressed(key, revision))))
      continue;
    candidates.push(candidate);
  }
  return fuseContextCandidates(candidates, { limit: input.limit, maxBytes: input.maxBytes });
}
