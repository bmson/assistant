import { describe, expect, it, vi } from 'vitest';
import {
  explicitlyAsksAboutPriorSituationDecision,
  readSituationDecisionContext,
  renderSituationDecisionContext,
} from './situation-context.js';

describe('situation decision context', () => {
  it('recognizes explicit recall questions without treating generic discussion as one', () => {
    expect(explicitlyAsksAboutPriorSituationDecision('What did we decide about launch week?')).toBe(
      true,
    );
    expect(explicitlyAsksAboutPriorSituationDecision('Why did we reject daily meetings?')).toBe(
      true,
    );
    expect(explicitlyAsksAboutPriorSituationDecision('Could a daily check-in help?')).toBe(false);
  });

  it('renders conflicting evidence with separate source pack revisions and no action authority', () => {
    const decisions = [
      {
        decisionId: 'check-in-a',
        option: 'Daily check-in',
        outcome: 'rejected' as const,
        reason: 'It interrupted focus.',
        scope: 'situation' as const,
        packId: 'pack-a',
        packTitle: 'Launch A',
        packVersion: 2,
        packUpdatedAt: '2026-10-01T00:00:00.000Z',
        relevance: 5,
      },
      {
        decisionId: 'check-in-b',
        option: 'Daily check-in',
        outcome: 'chosen' as const,
        reason: 'It caught blockers.',
        scope: 'situation' as const,
        packId: 'pack-b',
        packTitle: 'Launch B',
        packVersion: 4,
        packUpdatedAt: '2026-10-02T00:00:00.000Z',
        relevance: 5,
      },
    ];
    const block = renderSituationDecisionContext(decisions);

    expect(block).toContain('never action permission');
    expect(block).toContain('pack-a, version 2');
    expect(block).toContain('pack-b, version 4');
    expect(block).toContain('rejected “Daily check-in”');
    expect(block).toContain('chosen “Daily check-in”');
  });

  it('prefers configured portable owner storage and reports an unavailable read without throwing', async () => {
    const retrieve = vi.fn(async () => []);
    const read = await readSituationDecisionContext({
      persistence: {
        situationDecisionContext: {
          kind: 'situation-decision-context-repository',
          retrieve,
        },
      } as never,
      agentId: 'owner-a',
      discussionFrame: 'active launch discussion',
    });
    expect(read).toEqual({ status: 'complete', decisions: [] });
    expect(retrieve).toHaveBeenCalledWith({
      agentId: 'owner-a',
      discussionFrame: 'active launch discussion',
      limit: undefined,
    });

    const unavailable = await readSituationDecisionContext({
      persistence: {
        situationDecisionContext: {
          kind: 'situation-decision-context-repository',
          retrieve: vi.fn(async () => {
            throw new Error('sensitive raw provider detail');
          }),
        },
      } as never,
      agentId: 'owner-a',
      discussionFrame: 'active launch discussion',
    });
    expect(unavailable).toEqual({ status: 'unavailable', decisions: [] });
    expect(JSON.stringify(unavailable)).not.toContain('sensitive raw provider detail');
  });
});
