import type {
  GraphRecallRepository,
  GraphRelation,
  HistoryMessage,
  HistoryRecallRepository,
  HistorySegment,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { recallKnowledgeGraph } from './graph-recall.js';
import { recallRelevantContext } from './recall.js';
import { createRecallBlock } from './recall-budget.js';

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
    const result = await recallRelevantContext(repository, args, { maxChars: 210 });

    expect(result.block.length).toBeLessThanOrEqual(210);
    expect(result.block).toContain('Short fact');
    expect(result.block).not.toContain('Long evidence');
    expect(result.used).toBe(1);
    expect(result.sources).toEqual([{ date: '2026-10-02', label: 'Short fact' }]);
    expect(repository.messages).not.toHaveBeenCalled();
  });

  it('never lets the first message neighborhood bypass the hard bound', async () => {
    const large = message('large', 'Long evidence '.repeat(100));
    const small = message('small', 'Short fact');
    const repository = history({
      messages: vi.fn(async () => [large, small]),
      neighborhood: vi.fn(async ({ anchor }) => [anchor]),
    });
    const result = await recallRelevantContext(repository, args, { maxChars: 210 });

    expect(result.block.length).toBeLessThanOrEqual(210);
    expect(result.block).toContain('Short fact');
    expect(result.block).not.toContain('Long evidence');
    expect(result.sources).toEqual([{ date: '2026-10-02', label: 'Short fact' }]);
  });

  it('does not repeat messages in partially overlapping neighborhoods', async () => {
    const a = message('a', 'A_MARKER');
    const b = message('b', 'B_MARKER');
    const c = message('c', 'C_MARKER');
    const repository = history({
      messages: vi.fn(async () => [a, c]),
      neighborhood: vi.fn(async ({ anchor }) => (anchor.id === 'a' ? [a, b] : [b, c])),
    });
    const result = await recallRelevantContext(repository, args);

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
    expect(result.sources).toEqual([
      { date: '2026-10-02', label: 'Evidence small', kind: 'knowledge_graph', hops: 1 },
    ]);
  });

  it.each([0, 20, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'avoids embedding and storage reads when budget %s cannot hold evidence',
    async (maxChars) => {
      const embed = vi.fn(async () => [[1, 0]]);
      const repository = history();
      expect(
        await recallRelevantContext(repository, { ...args, embed }, { maxChars }),
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
