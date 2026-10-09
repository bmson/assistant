import type { GraphRecallRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { recallKnowledgeGraph, recallWithGraphFallback } from './graph-recall.js';

const graphResult = {
  block: 'Graph evidence',
  used: 1,
  candidates: 1,
  sources: [
    { date: '2026-08-24', label: 'Graph fact', kind: 'knowledge_graph' as const, hops: 1 as const },
  ],
};

describe('recallWithGraphFallback', () => {
  it('shares a successful graph embedding with standard recall and preserves both provenances', async () => {
    const history = vi.fn(async (embedding: number[] | undefined) => {
      expect(embedding).toEqual([0.1, 0.2]);
      return {
        block: 'Earlier discussion',
        sources: [{ date: '2026-08-23', label: 'Chat fact', kind: 'chat' as const }],
      };
    });

    const result = await recallWithGraphFallback({
      graph: async () => ({ graph: graphResult, queryEmbedding: [0.1, 0.2] }),
      history,
    });

    expect(history).toHaveBeenCalledOnce();
    expect(result.block).toBe('Graph evidence\n\nEarlier discussion');
    expect(result.sources).toEqual([
      ...graphResult.sources,
      { date: '2026-08-23', label: 'Chat fact', kind: 'chat' },
    ]);
    expect(result.graphFailed).toBe(false);
    expect(result.historyFailed).toBe(false);
  });

  it('continues with standard recall when GraphRAG or its embedding fails', async () => {
    const outage = new Error('graph database unavailable');
    const onGraphError = vi.fn();
    const history = vi.fn(async (embedding: number[] | undefined) => {
      expect(embedding).toBeUndefined();
      return {
        block: 'Earlier discussion remains available',
        sources: [{ date: '2026-08-23', label: 'Chat fact' }],
      };
    });

    const result = await recallWithGraphFallback({
      graph: async () => {
        throw outage;
      },
      history,
      onGraphError,
    });

    expect(onGraphError).toHaveBeenCalledWith(outage);
    expect(history).toHaveBeenCalledOnce();
    expect(result.block).toBe('Earlier discussion remains available');
    expect(result.graph.used).toBe(0);
    expect(result.graphFailed).toBe(true);
    expect(result.historyFailed).toBe(false);
  });

  it('does not invoke the graph layer when it is disabled', async () => {
    const history = vi.fn(async () => ({ block: '', sources: [] }));

    const result = await recallWithGraphFallback({ history });

    expect(history).toHaveBeenCalledWith(undefined, expect.objectContaining({ used: 0 }));
    expect(result).toMatchObject({ block: '', sources: [], graph: { used: 0 } });
    expect(result.graphFailed).toBe(false);
    expect(result.historyFailed).toBe(false);
  });

  it('keeps graph evidence and reports telemetry when history recall fails', async () => {
    const outage = new Error('vector index unavailable');
    const onHistoryError = vi.fn();

    const result = await recallWithGraphFallback({
      graph: async () => ({ graph: graphResult, queryEmbedding: [0.1, 0.2] }),
      history: async () => {
        throw outage;
      },
      onHistoryError,
    });

    expect(onHistoryError).toHaveBeenCalledWith(outage);
    expect(result).toMatchObject({
      block: 'Graph evidence',
      sources: graphResult.sources,
      graphFailed: false,
      historyFailed: true,
      history: { block: '', sources: [], tier: 'none', used: 0 },
    });
  });
});

describe('current graph context eligibility', () => {
  it('omits future, expired, and ambiguous validity intervals before rendering', async () => {
    const relation = (id: string, validFrom: string | null, validUntil: string | null) => ({
      relationId: id,
      subjectEntityId: `s-${id}`,
      subjectLabel: 'Owner',
      predicate: 'works_at',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: `o-${id}`,
      objectLabel: `Company ${id}`,
      sourceMemoryId: `m-${id}`,
      content: `Owner works at Company ${id}`,
      evidenceQuote: `I work at Company ${id}`,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      confidence: '0.99',
      validFrom,
      validUntil,
      similarity: 0.99,
    });
    const rows = [
      relation('current', null, null),
      relation('future', '2999', null),
      relation('expired', null, '2000'),
      relation('uncertain', 'often', null),
      relation('overflow', null, '2026-13'),
      relation('inverted', '2024', '2023'),
    ];
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: async () => rows,
      connected: async () => [],
    };
    const result = await recallKnowledgeGraph(repository, {
      agentId: 'owner',
      queryText: 'where do I work',
      queryEmbedding: [1],
    });
    expect(result.block).toContain('Company current');
    expect(result.block).not.toContain('Company future');
    expect(result.block).not.toContain('Company expired');
    expect(result.block).not.toContain('Company uncertain');
    expect(result.block).not.toContain('Company overflow');
    expect(result.block).not.toContain('Company inverted');
  });

  it('filters expired, future, malformed, and inverted connected edges for current questions', async () => {
    const relation = (id: string, validFrom: string | null, validUntil: string | null) => ({
      relationId: id,
      subjectEntityId: `s-${id}`,
      subjectLabel: 'Owner',
      predicate: 'works_at',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: `o-${id}`,
      objectLabel: `Company ${id}`,
      sourceMemoryId: `m-${id}`,
      content: `Owner works at Company ${id}`,
      evidenceQuote: `I work at Company ${id}`,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      confidence: '0.99',
      validFrom,
      validUntil,
      similarity: 0.99,
    });
    const current = relation('current-seed', null, null);
    const expiredNeighbor = {
      ...relation('expired-neighbor', null, '2000'),
      subjectEntityId: current.objectEntityId,
      subjectLabel: current.objectLabel,
    };
    const futureNeighbor = {
      ...relation('future-neighbor', '2999', null),
      subjectEntityId: current.objectEntityId,
      subjectLabel: current.objectLabel,
    };
    const overflowNeighbor = {
      ...relation('overflow-neighbor', null, '2026-13'),
      subjectEntityId: current.objectEntityId,
      subjectLabel: current.objectLabel,
    };
    const invertedNeighbor = {
      ...relation('inverted-neighbor', '2024', '2023'),
      subjectEntityId: current.objectEntityId,
      subjectLabel: current.objectLabel,
    };
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: async () => [current],
      connected: async () => [expiredNeighbor, futureNeighbor, overflowNeighbor, invertedNeighbor],
    };
    const result = await recallKnowledgeGraph(repository, {
      agentId: 'owner',
      queryText: 'where do I work',
      queryEmbedding: [1],
    });

    expect(result.block).toContain('Company current-seed');
    expect(result.block).not.toContain('Company expired-neighbor');
    expect(result.block).not.toContain('Company future-neighbor');
    expect(result.block).not.toContain('Company overflow-neighbor');
    expect(result.block).not.toContain('Company inverted-neighbor');
  });

  it('retrieves parseable past intervals for explicit history while rejecting invalid spans', async () => {
    const relation = (
      id: string,
      validFrom: string | null,
      validUntil: string | null,
      objectLabel = `Company ${id}`,
    ) => ({
      relationId: id,
      subjectEntityId: `s-${id}`,
      subjectLabel: 'Owner',
      predicate: 'worked_at',
      assertion: {
        tense: 'past' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: `o-${id}`,
      objectLabel,
      sourceMemoryId: `m-${id}`,
      content: `Owner worked at ${objectLabel}`,
      evidenceQuote: `I worked at ${objectLabel}`,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      confidence: '0.99',
      validFrom,
      validUntil,
      similarity: 0.99,
    });
    const past = relation('past-seed', '2019', '2023-03', 'Former Employer');
    const current = relation('current-seed', null, null, 'Current Employer');
    const expiredNeighbor = {
      ...relation(
        'past-neighbor',
        '2020-01-01T00:00:00.000Z',
        '2022-02-28T23:59:59.000Z',
        'Old Project',
      ),
      subjectEntityId: past.objectEntityId,
      subjectLabel: past.objectLabel,
    };
    const invalidRows = [
      relation('future-seed', '2999', null),
      relation('ambiguous-seed', 'often', null),
      relation('overflow-seed', null, '2026-02-31'),
      relation('inverted-seed', '2024', '2023'),
      relation('invalid-timestamp', null, '2023-02-31T00:00:00.000Z'),
    ];
    const invalidNeighbors = invalidRows.map((row) => ({
      ...row,
      relationId: `neighbor-${row.relationId}`,
      subjectEntityId: past.objectEntityId,
      subjectLabel: past.objectLabel,
      objectEntityId: `neighbor-object-${row.relationId}`,
      objectLabel: `Invalid ${row.objectLabel}`,
    }));
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: async () => [past, current, ...invalidRows],
      connected: async () => [expiredNeighbor, ...invalidNeighbors],
    };
    const result = await recallKnowledgeGraph(
      repository,
      { agentId: 'owner', queryText: 'where did I work before?', queryEmbedding: [1] },
      { limit: 4 },
    );

    expect(result.block).toContain('Former Employer');
    expect(result.block).toContain('(2019 to 2023-03)');
    expect(result.block).toContain('Old Project');
    for (const label of ['Company future-seed', 'Company ambiguous-seed', 'Company overflow-seed'])
      expect(result.block).not.toContain(label);
    expect(result.block).not.toContain('Invalid Company');
  });

  it('uses the exact emitted one-hop identity and revision for suppression', async () => {
    const row = {
      relationId: 'one-hop',
      subjectEntityId: 'owner',
      subjectLabel: 'Owner',
      predicate: 'works_at',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: 'company',
      objectLabel: 'Example Co',
      sourceMemoryId: 'memory-one-hop',
      content: 'Owner works at Example Co',
      evidenceQuote: 'I work at Example Co',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      confidence: '0.99',
      validFrom: null,
      validUntil: null,
      similarity: 0.99,
    };
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: async () => [row],
      connected: async () => [],
    };
    const shown = await recallKnowledgeGraph(repository, {
      agentId: 'owner',
      queryText: 'where do I work',
      queryEmbedding: [1],
    });
    const source = shown.sources[0];
    if (!source?.surfaceKey || !source.sourceRevision) throw new Error('Missing graph receipt');

    const isSuppressed = vi.fn(
      async (surfaceKey: string, sourceRevision: string) =>
        surfaceKey === source.surfaceKey && sourceRevision === source.sourceRevision,
    );
    const hidden = await recallKnowledgeGraph(
      repository,
      { agentId: 'owner', queryText: 'where do I work', queryEmbedding: [1] },
      { isSuppressed },
    );
    expect(isSuppressed).toHaveBeenCalledWith(source.surfaceKey, source.sourceRevision);
    expect(hidden.used).toBe(0);
    expect(hidden.sources).toEqual([]);
  });

  it('suppresses a matching two-hop version and allows the path after its neighbor changes', async () => {
    const seed = {
      relationId: 'path-seed',
      subjectEntityId: 'owner',
      subjectLabel: 'Owner',
      predicate: 'works_on',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: 'project',
      objectLabel: 'Project',
      sourceMemoryId: 'memory-seed',
      content: 'Owner works on Project',
      evidenceQuote: 'I work on Project',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      confidence: '0.99',
      validFrom: null,
      validUntil: null,
      similarity: 0.99,
    };
    const neighbor = {
      relationId: 'path-neighbor',
      subjectEntityId: 'project',
      subjectLabel: 'Project',
      predicate: 'uses',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: 'tool',
      objectLabel: 'Notebook',
      sourceMemoryId: 'memory-neighbor',
      content: 'Project uses Notebook',
      evidenceQuote: 'Project uses Notebook',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      confidence: '0.99',
      validFrom: null,
      validUntil: null,
      similarity: 0.95,
    };
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: async () => [seed],
      connected: async () => [neighbor],
    };
    const args = { agentId: 'owner', queryText: 'tell me about Project', queryEmbedding: [1] };
    const shown = await recallKnowledgeGraph(repository, args, { limit: 1 });
    const twoHop = shown.sources.find((source) => source.hops === 2);
    expect(twoHop?.surfaceKey).toBeTruthy();
    expect(twoHop?.sourceRevision).toBeTruthy();

    const isSuppressed = vi.fn(
      async (surfaceKey: string, sourceRevision: string) =>
        surfaceKey === twoHop?.surfaceKey && sourceRevision === twoHop?.sourceRevision,
    );
    const hidden = await recallKnowledgeGraph(repository, args, { limit: 1, isSuppressed });
    expect(hidden.block).toContain('[1 hop]');
    expect(hidden.block).not.toContain('[2 hops]');
    expect(hidden.used).toBe(1);

    const changedRepository: GraphRecallRepository = {
      ...repository,
      connected: async () => [
        {
          ...neighbor,
          content: 'Project now uses a different Notebook',
          evidenceQuote: 'Project uses a newer Notebook',
        },
      ],
    };
    const changed = await recallKnowledgeGraph(changedRepository, args, {
      limit: 1,
      isSuppressed,
    });
    const changedPath = changed.sources.find((source) => source.hops === 2);
    expect(changed.block).toContain('[2 hops]');
    expect(changed.block).toContain('newer Notebook');
    expect(changedPath?.surfaceKey).toBe(twoHop?.surfaceKey);
    expect(changedPath?.sourceRevision).not.toBe(twoHop?.sourceRevision);
  });

  it('gives distinct surface identities to paths from one seed through different neighbors', async () => {
    const seed = {
      relationId: 'shared-seed',
      subjectEntityId: 'owner',
      subjectLabel: 'Owner',
      predicate: 'works_on',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: 'project',
      objectLabel: 'Project',
      sourceMemoryId: 'memory-seed',
      content: 'Owner works on Project',
      evidenceQuote: 'I work on Project',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      confidence: '0.99',
      validFrom: null,
      validUntil: null,
      similarity: 0.99,
    };
    const neighbors = ['Notebook', 'Calendar'].map((label, index) => ({
      relationId: `neighbor-${index}`,
      subjectEntityId: 'project',
      subjectLabel: 'Project',
      predicate: 'uses',
      assertion: {
        tense: 'present' as const,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      objectEntityId: `tool-${index}`,
      objectLabel: label,
      sourceMemoryId: `memory-neighbor-${index}`,
      content: `Project uses ${label}`,
      evidenceQuote: `Project uses ${label}`,
      createdAt: new Date(`2026-01-0${index + 2}T00:00:00Z`),
      confidence: '0.99',
      validFrom: null,
      validUntil: null,
      similarity: 0.95,
    }));
    const repository: GraphRecallRepository = {
      kind: 'graph-recall-repository',
      seeds: async () => [seed],
      connected: async () => neighbors,
    };

    const result = await recallKnowledgeGraph(
      repository,
      { agentId: 'owner', queryText: 'tell me about Project', queryEmbedding: [1] },
      { limit: 2 },
    );
    const paths = result.sources.filter((source) => source.hops === 2);

    expect(paths).toHaveLength(2);
    expect(paths[0]?.surfaceKey).not.toBe(paths[1]?.surfaceKey);
  });
});
