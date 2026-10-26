import type { getAgent } from '../chat.js';

type Db = Parameters<typeof getAgent>[0];

import type { ExecutionPersistence } from '@assistant/persistence';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import type { ModelRouter } from '../model-router/router.js';
import type { RecallMode } from '../workflow/owner-intent.js';
import { assembleDiscussionFrame, type DiscussionTurn } from './discussion-frame.js';
import { fuseOwnerContext } from './fused-owner-context.js';
import { recallKnowledgeGraph, recallWithGraphFallback } from './graph-recall.js';
import { recallRelevantContext, recentWindowStart } from './recall.js';
import { readSituationDecisionContext } from './situation-context.js';

/** Shared bounded recall used before planning and, for legacy paths, before a model step. */
export async function retrieveOwnerContext(input: {
  db?: Db;
  persistence?: ExecutionPersistence;
  router: ModelRouter;
  taskId: string;
  agentId: string;
  conversationId: string;
  queryText: string;
  eligibilityText: string;
  mode: Extract<RecallMode, 'automatic' | 'continuation'>;
  sinceCreatedAt?: Date;
  graphEnabled: boolean;
  discussionTurns?: ReadonlyArray<DiscussionTurn>;
}) {
  const { persistence, router, taskId, agentId, conversationId, graphEnabled } = input;
  const frame = assembleDiscussionFrame({
    currentText: input.queryText,
    turns: input.discussionTurns ?? [],
  });
  if (!frame.available) throw new Error('Complete current request exceeds retrieval frame budget');
  const queryText = frame.queryText;
  const embeddingSpace = await router.embeddingSpace();
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  const isSuppressed = persistence?.recallSurfacing
    ? async (sourceKey: string, sourceRevision: string) => {
        const suppressed = await persistence.recallSurfacing?.suppressed(agentId, [sourceKey], {
          [sourceKey]: sourceRevision,
        });
        return suppressed?.has(sourceKey) ?? true;
      }
    : undefined;
  // Resolve each legacy PostgreSQL fallback only when that port is absent. A
  // complete portable persistence adapter must not need a SQL connection.
  const historyRepository = persistence?.history ?? input.db;
  if (!historyRepository) {
    throw new Error('History recall storage is not configured');
  }
  const since =
    input.sinceCreatedAt ??
    (await recentWindowStart(historyRepository, conversationId, 20, agentId)) ??
    new Date();
  const layered = await recallWithGraphFallback({
    graph: graphEnabled
      ? async () => {
          const [queryEmbedding] = await router.embed([queryText], {
            taskId,
            expectedSpace: embeddingSpace,
          });
          const graphRepository = persistence?.graph ?? input.db;
          if (!graphRepository) {
            throw new Error('Knowledge graph recall storage is not configured');
          }
          return {
            graph: await recallKnowledgeGraph(
              graphRepository,
              {
                agentId,
                queryText,
                queryEmbedding,
              },
              { isSuppressed, limit: 8 },
            ),
            queryEmbedding,
          };
        }
      : undefined,
    history: (queryEmbedding, graph) =>
      recallRelevantContext(
        historyRepository,
        {
          agentId,
          queryText,
          embed: (values, embedOpts) =>
            router.embed(values, {
              taskId,
              ...(embedOpts ?? {}),
              expectedSpace: embeddingSpace,
            }),
          exclude: { conversationId, sinceCreatedAt: since },
        },
        {
          taskId,
          limit: 12,
          ...(graph.used > 0 ? { maxChars: 1200 } : {}),
          queryEmbedding,
          embeddingSpaceKey,
          isSuppressed,
        },
      ),
    onGraphError: (err) => {
      console.error('executor knowledge graph recall failed — falling back to chat recall', err);
    },
    onHistoryError: (err) => {
      console.error('executor history recall failed — continuing without it', err);
    },
  });
  const situations = await readSituationDecisionContext({
    db: input.db,
    persistence,
    agentId,
    discussionFrame: queryText,
    limit: 16,
  });
  const fused = await fuseOwnerContext({
    queryText,
    eligibilityText: input.eligibilityText,
    mode: input.mode,
    rankedContext: layered.rankedContext,
    decisions: situations.decisions,
    isSuppressed,
    limit: 8,
    maxBytes: 2600,
  });
  return {
    ...layered,
    block: fused.block,
    sources: fused.sources,
    rankedContext: fused.selected,
    situationDecisionStatus: situations.status,
    situationDecisions: situations.decisions,
    discussionFrame: frame,
  };
}
