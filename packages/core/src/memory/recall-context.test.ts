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
      db: {} as never,
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
});
