import { describe, expect, it, vi } from 'vitest';
import { retrieveOwnerContext } from './recall-context.js';

describe('shared owner recall entrypoint', () => {
  it('keeps direct, planning, and fallback outputs identical for the same bounded source set', async () => {
    const since = new Date('2026-10-01T00:00:00.000Z');
    const history = {
      kind: 'history-recall-repository' as const,
      recentWindowStart: vi.fn(async () => since),
      segments: vi.fn(async () => [
        {
          conversationId: 'prior-conversation',
          summary: 'The owner prefers wheelchair-accessible entrances at clinics.',
          startMessageId: 'prior-message',
          startedAt: new Date('2026-09-01T00:00:00.000Z'),
          endedAt: new Date('2026-09-01T00:00:00.000Z'),
          similarity: 0.97,
          keyMessage: {
            id: 'prior-message',
            role: 'user' as const,
            text: 'Use wheelchair-accessible entrances for clinics.',
          },
        },
      ]),
      messages: vi.fn(async () => []),
      neighborhood: vi.fn(async () => []),
    };
    const persistence = {
      history,
      ownerContext: { listOpenCommitments: vi.fn(async () => []) },
      situationDecisionContext: { retrieve: vi.fn(async () => []) },
      recallSurfacing: {
        suppressed: vi.fn(async () => new Set<string>()),
      },
    } as never;
    const router = {
      embeddingSpace: vi.fn(async () => ({
        provider: 'synthetic',
        model: 'eligibility-parity',
        dimensions: 2,
        revision: '1',
      })),
      embed: vi.fn(async () => [[1, 0]]),
    } as never;
    const common = {
      persistence,
      router,
      agentId: 'agent-1',
      conversationId: 'current-conversation',
      queryText: 'Find clinics with wheelchair-accessible entrances.',
      eligibilityText: 'Find clinics with wheelchair-accessible entrances.',
      sinceCreatedAt: since,
      discussionTurns: [],
      graphEnabled: false,
    } as const;

    const [direct, planning, fallback] = await Promise.all([
      retrieveOwnerContext({ ...common, taskId: 'direct-task', mode: 'automatic' }),
      retrieveOwnerContext({ ...common, taskId: 'planning-task', mode: 'automatic' }),
      retrieveOwnerContext({ ...common, taskId: 'fallback-task', mode: 'continuation' }),
    ]);

    const selected = (result: typeof direct) => ({
      block: result.block,
      sources: result.sources.map(({ surfaceKey, sourceRevision }) => ({
        surfaceKey,
        sourceRevision,
      })),
    });
    expect(selected(direct)).toEqual(selected(planning));
    expect(selected(direct)).toEqual(selected(fallback));
    expect(direct.sources).toHaveLength(1);
    expect(direct.block).toContain('wheelchair-accessible entrances');
    expect(history.segments).toHaveBeenCalledTimes(3);
  });

  it('fails closed when a required recall persistence port and database are both missing', async () => {
    const router = {
      embeddingSpace: vi.fn(async () => ({
        provider: 'synthetic',
        model: 'eligibility-missing-port',
        dimensions: 2,
        revision: '1',
      })),
      embed: vi.fn(async () => [[1, 0]]),
    } as never;

    await expect(
      retrieveOwnerContext({
        router,
        persistence: {
          ownerContext: { listOpenCommitments: vi.fn(async () => []) },
        } as never,
        taskId: 'missing-history-task',
        agentId: 'agent-1',
        conversationId: 'current-conversation',
        queryText: 'Find clinics with wheelchair-accessible entrances.',
        eligibilityText: 'Find clinics with wheelchair-accessible entrances.',
        mode: 'automatic',
        graphEnabled: false,
      }),
    ).rejects.toThrow('History recall storage is not configured');
  });

  it('does not match a history date wrapper as source meaning', async () => {
    const history = {
      kind: 'history-recall-repository' as const,
      recentWindowStart: vi.fn(async () => null),
      segments: vi.fn(async () => [
        {
          conversationId: 'prior-conversation',
          summary: 'The planning group uses a weekly meeting cadence.',
          startMessageId: 'prior-message',
          startedAt: new Date('2026-10-01T00:00:00.000Z'),
          endedAt: new Date('2026-10-01T00:00:00.000Z'),
          similarity: 0.99,
          keyMessage: {
            id: 'prior-message',
            role: 'user' as const,
            text: 'The meeting cadence is weekly.',
          },
        },
      ]),
      messages: vi.fn(async () => []),
      neighborhood: vi.fn(async () => []),
    };
    const result = await retrieveOwnerContext({
      persistence: {
        history,
        ownerContext: { listOpenCommitments: vi.fn(async () => []) },
        situationDecisionContext: { retrieve: vi.fn(async () => []) },
      } as never,
      router: {
        embeddingSpace: vi.fn(async () => ({
          provider: 'synthetic',
          model: 'history-meaning-projection',
          dimensions: 2,
          revision: '1',
        })),
        embed: vi.fn(async () => [[1, 0]]),
      } as never,
      taskId: 'date-wrapper-task',
      agentId: 'agent-1',
      conversationId: 'current-conversation',
      queryText: 'Find 2026-10',
      eligibilityText: 'Find 2026-10',
      mode: 'automatic',
      graphEnabled: false,
    });

    expect(result.sources).toEqual([]);
    expect(history.segments).toHaveBeenCalledOnce();
  });

  it.each(['Find 1 hop', 'Find unverified Owner'])(
    'does not match graph presentation metadata as meaning for %s',
    async (queryText) => {
      const now = new Date();
      const relation = {
        relationId: 'relation-1',
        subjectEntityId: 'owner-entity',
        subjectLabel: 'Owner',
        predicate: 'works_at',
        assertion: { tense: 'present', polarity: 'positive', modality: 'unverified' },
        objectEntityId: 'company-entity',
        objectLabel: 'Contoso',
        sourceMemoryId: 'memory-1',
        content: 'Owner works at Contoso.',
        evidenceQuote: 'I work at Contoso.',
        createdAt: now,
        confidence: '0.99',
        validFrom: null,
        validUntil: null,
        similarity: 0.99,
      };
      const history = {
        kind: 'history-recall-repository' as const,
        recentWindowStart: vi.fn(async () => null),
        segments: vi.fn(async () => []),
        messages: vi.fn(async () => []),
        neighborhood: vi.fn(async () => []),
      };
      const result = await retrieveOwnerContext({
        persistence: {
          history,
          graph: {
            kind: 'graph-recall-repository',
            seeds: vi.fn(async () => [relation]),
            connected: vi.fn(async () => []),
          },
          ownerContext: { listOpenCommitments: vi.fn(async () => []) },
          situationDecisionContext: { retrieve: vi.fn(async () => []) },
        } as never,
        router: {
          embeddingSpace: vi.fn(async () => ({
            provider: 'synthetic',
            model: 'graph-meaning-projection',
            dimensions: 2,
            revision: '1',
          })),
          embed: vi.fn(async () => [[1, 0]]),
        } as never,
        taskId: 'graph-metadata-task',
        agentId: 'agent-1',
        conversationId: 'current-conversation',
        queryText,
        eligibilityText: queryText,
        mode: 'automatic',
        graphEnabled: true,
      });

      expect(result.sources).toEqual([]);
    },
  );
});
