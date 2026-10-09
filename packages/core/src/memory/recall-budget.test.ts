import type {
  GraphRecallRepository,
  GraphRelation,
  HistoryMessage,
  HistoryRecallRepository,
  HistorySegment,
} from '@assistant/persistence';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { recallKnowledgeGraph } from './graph-recall.js';
import { recallRelevantContext } from './recall.js';
import { createRecallBlock } from './recall-budget.js';
import { recallSourceRevision, recallSurfaceKey } from './recall-surfacing.js';

const EMBEDDING_SPACE_KEY = embeddingSpaceIdentityKey({
  provider: 'synthetic',
  model: 'recall-budget-fixture',
  dimensions: 2,
  revision: '1',
});
const now = new Date('2026-10-02T12:00:00Z');
const args = {
  agentId: 'owner',
  queryText: 'remember the report discussion',
  embed: vi.fn(async () => [[1, 0]]),
  exclude: { conversationId: 'current', sinceCreatedAt: now },
};

function message(id: string, text: string): HistoryMessage & { similarity: number } {
  return { id, text, conversationId: 'earlier', role: 'user', createdAt: now, similarity: 0.9 };
}

function segment(summary: string): HistorySegment {
  return {
    summary,
    conversationId: 'earlier',
    startMessageId: 'start',
    startedAt: now,
    endedAt: now,
    similarity: 0.9,
    keyMessage: { id: 'start', role: 'user', text: summary },
  };
}

function history(overrides: Partial<HistoryRecallRepository> = {}): HistoryRecallRepository {
  return {
    kind: 'history-recall-repository',
    segments: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    neighborhood: vi.fn(async () => []),
    recentWindowStart: vi.fn(async () => null),
    ...overrides,
  };
}

function relation(id: string, subjectLabel = 'Owner'): GraphRelation {
  return {
    relationId: id,
    subjectEntityId: id,
    subjectLabel,
    predicate: 'works_on',
    assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
    objectEntityId: `report-${id}`,
    objectLabel: 'Report',
    sourceMemoryId: `memory-${id}`,
    content: `Evidence ${id}`,
    evidenceQuote: null,
    createdAt: now,
    confidence: 0.9,
    validFrom: null,
    validUntil: null,
    similarity: 0.9,
  };
}

describe('recall prompt budgets', () => {
  it('counts UTF-8 bytes rather than JavaScript characters', () => {
    const block = createRecallBlock('Evidence', 15);
    expect(block.add('東京')).toBe(false);
    expect(block.text).toBe('');
    expect(block.add('éé')).toBe(true);
    expect(new TextEncoder().encode(block.text).byteLength).toBe(14);
  });

  it('rejects a summary whose grounding message is missing', async () => {
    const orphan = { ...segment('UNSUPPORTED_SUMMARY'), keyMessage: undefined };
    const result = await recallRelevantContext(
      history({ segments: vi.fn(async () => [orphan]) }),
      args,
      { embeddingSpaceKey: EMBEDDING_SPACE_KEY },
    );
    expect(result.block).toBe('');
    expect(result.sources).toEqual([]);
  });

  it('keeps excerpt identities and representation through a blended result', async () => {
    const summary = segment('SOURCE_MARKER');
    const anchor = message('start', 'SOURCE_MARKER');
    const result = await recallRelevantContext(
      history({
        segments: vi.fn(async () => [summary]),
        messages: vi.fn(async () => [anchor]),
        neighborhood: vi.fn(async () => [anchor]),
      }),
      args,
      { embeddingSpaceKey: EMBEDDING_SPACE_KEY },
    );
    expect(result.used).toBe(2);
    expect(new Set(result.sources.map((source) => source.evidence?.representation))).toEqual(
      new Set(['summary_with_excerpt', 'message_excerpts']),
    );
    expect(result.sources[0]?.evidence?.sourceMessageIds).toEqual(['start']);
    expect(result.sources[0]?.evidence?.renderedUtf8Bytes).toBeGreaterThan(0);
  });
  it('includes the trust header and separators in the hard bound', () => {
    const block = createRecallBlock('Evidence', 15);
    expect(block.add('first')).toBe(true);
    expect(block.text).toBe('Evidence\n\nfirst');
    expect(block.add('second')).toBe(false);
    expect(block.text).toHaveLength(15);
  });

  it('keeps smaller complete segment evidence when the top match cannot fit', async () => {
    const repository = history({
      segments: vi.fn(async () => [segment('Long evidence '.repeat(100)), segment('Short fact')]),
    });
    const result = await recallRelevantContext(repository, args, {
      maxChars: 210,
      embeddingSpaceKey: EMBEDDING_SPACE_KEY,
    });

    expect(result.block.length).toBeLessThanOrEqual(210);
    expect(result.block).toContain('Short fact');
    expect(result.block).not.toContain('Long evidence');
    expect(result.used).toBe(1);
    expect(result.sources).toMatchObject([{ date: '2026-10-02', label: 'Short fact' }]);
    expect(result.tier).toBe('segment');
  });

  it('never lets the first message neighborhood bypass the hard bound', async () => {
    const large = message('large', 'Long evidence '.repeat(100));
    const small = message('small', 'Short fact');
    const repository = history({
      messages: vi.fn(async () => [large, small]),
      neighborhood: vi.fn(async ({ anchor }) => [anchor]),
    });
    const result = await recallRelevantContext(repository, args, {
      maxChars: 210,
      embeddingSpaceKey: EMBEDDING_SPACE_KEY,
    });

    expect(result.block.length).toBeLessThanOrEqual(210);
    expect(result.block).toContain('Short fact');
    expect(result.block).not.toContain('Long evidence');
    expect(result.sources).toMatchObject([{ date: '2026-10-02', label: 'Short fact' }]);
  });

  it('does not repeat messages in partially overlapping neighborhoods', async () => {
    const a = message('a', 'A_MARKER');
    const b = message('b', 'B_MARKER');
    const c = message('c', 'C_MARKER');
    const repository = history({
      messages: vi.fn(async () => [a, c]),
      neighborhood: vi.fn(async ({ anchor }) => (anchor.id === 'a' ? [a, b] : [b, c])),
    });
    const result = await recallRelevantContext(repository, args, {
      embeddingSpaceKey: EMBEDDING_SPACE_KEY,
    });

    for (const marker of ['A_MARKER', 'B_MARKER', 'C_MARKER'])
      expect(result.block.split(marker)).toHaveLength(2);
    expect(result.used).toBe(2);
  });

  it('keeps graph provenance tied to complete entries inside the hard bound', async () => {
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: vi.fn(async () => [relation('large', 'Long label '.repeat(100)), relation('small')]),
      connected: vi.fn(async () => []),
    };
    const result = await recallKnowledgeGraph(
      repository,
      { agentId: 'owner', queryText: args.queryText, queryEmbedding: [1, 0] },
      { maxChars: 240 },
    );

    expect(result.block.length).toBeLessThanOrEqual(240);
    expect(result.block).toContain('Evidence small');
    expect(result.block).not.toContain('Evidence large');
    expect(result.used).toBe(1);
    const small = relation('small');
    expect(result.sources).toEqual([
      {
        date: '2026-10-02',
        label: 'Owner works_on Report',
        kind: 'knowledge_graph',
        hops: 1,
        surfaceKey: recallSurfaceKey('knowledge_graph', [small.relationId]),
        sourceRevision: recallSourceRevision([
          {
            relationId: small.relationId,
            sourceMemoryId: small.sourceMemoryId,
            assertion: small.assertion,
            validFrom: small.validFrom,
            validUntil: small.validUntil,
            content: small.content,
            evidenceQuote: small.evidenceQuote,
          },
        ]),
        relevance: 0.9,
      },
    ]);
  });

  it('keeps recorded tense, polarity, and modality visible in recalled paths', async () => {
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: vi.fn(async () => [
        {
          ...relation('former-job'),
          predicate: 'worked_at',
          assertion: {
            tense: 'past',
            polarity: 'positive',
            modality: 'asserted',
          } satisfies GraphRelation['assertion'],
        },
        {
          ...relation('possible-family'),
          predicate: 'father_of',
          assertion: {
            tense: 'present',
            polarity: 'negative',
            modality: 'possible',
          } satisfies GraphRelation['assertion'],
        },
      ]),
      connected: vi.fn(async () => []),
    };
    const result = await recallKnowledgeGraph(
      repository,
      { agentId: 'owner', queryText: args.queryText, queryEmbedding: [1, 0] },
      { maxChars: 1_000 },
    );
    expect(result.block).toContain('[past]');
    expect(result.block).toContain('[negative, possible]');
  });

  it.each([0, 20, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'avoids embedding and storage reads when budget %s cannot hold evidence',
    async (maxChars) => {
      const embed = vi.fn(async () => [[1, 0]]);
      const repository = history();
      expect(
        await recallRelevantContext(
          repository,
          { ...args, embed },
          { maxChars, embeddingSpaceKey: EMBEDDING_SPACE_KEY },
        ),
      ).toMatchObject({
        block: '',
        used: 0,
        sources: [],
      });
      expect(embed).not.toHaveBeenCalled();
      expect(repository.segments).not.toHaveBeenCalled();
      expect(repository.messages).not.toHaveBeenCalled();
    },
  );
});
