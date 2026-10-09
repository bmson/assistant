import { describe, expect, it } from 'vitest';
import { type SituationPackView, selectSituationDecisionContext } from './situations-schema.js';

function pack(input: {
  id: string;
  title: string;
  version?: number;
  archived?: boolean;
  decisions: Array<{
    id: string;
    option: string;
    outcome: 'chosen' | 'rejected';
    reason: string;
    scope?: 'situation' | 'preference';
    confirmed?: boolean;
  }>;
}): SituationPackView {
  return {
    id: input.id,
    title: input.title,
    version: input.version ?? 1,
    archived: input.archived ?? false,
    updatedAt: '2026-10-01T00:00:00.000Z',
    data: {
      items: [
        {
          id: 'plan',
          title: input.title,
          details: '',
          lane: 'plan',
          dependsOn: [],
          source: null,
          snapshot: null,
          needsReview: false,
        },
      ],
      decisions: input.decisions.map((decision) => ({
        ...decision,
        scope: decision.scope ?? 'situation',
        confirmed: decision.confirmed ?? true,
      })),
    },
    changes: [],
    affectedIds: [],
  };
}

describe('selectSituationDecisionContext', () => {
  it('returns owner-confirmed active choices with pack identity and version', () => {
    const active = pack({
      id: 'launch-a',
      title: 'Launch plan',
      version: 4,
      decisions: [
        {
          id: 'daily',
          option: 'Daily check-in',
          outcome: 'rejected',
          reason: 'It interrupts focus time during launch.',
        },
        {
          id: 'guess',
          option: 'Assistant guess',
          outcome: 'chosen',
          reason: 'Might help.',
          confirmed: false,
        },
      ],
    });
    const archived = pack({
      id: 'launch-old',
      title: 'Launch plan',
      archived: true,
      decisions: [
        {
          id: 'daily-old',
          option: 'Daily check-in',
          outcome: 'chosen',
          reason: 'Old plan chose it.',
        },
      ],
    });

    expect(
      selectSituationDecisionContext(
        [active, archived],
        'Should we add a daily check-in for launch?',
      ),
    ).toEqual([
      expect.objectContaining({
        decisionId: 'daily',
        outcome: 'rejected',
        packId: 'launch-a',
        packVersion: 4,
        scope: 'situation',
      }),
    ]);
  });

  it('preserves opposite choices from separate packs even when the result limit is one', () => {
    const packs = [
      pack({
        id: 'launch-a',
        title: 'Launch plan A',
        version: 3,
        decisions: [
          {
            id: 'daily-a',
            option: 'Daily check-in',
            outcome: 'rejected',
            reason: 'Daily meetings interrupt focus.',
          },
        ],
      }),
      pack({
        id: 'launch-b',
        title: 'Launch plan B',
        version: 2,
        decisions: [
          {
            id: 'daily-b',
            option: 'Daily check-in',
            outcome: 'chosen',
            reason: 'Daily check-ins catch blockers.',
          },
        ],
      }),
    ];

    expect(
      selectSituationDecisionContext(packs, 'Should we add a daily check-in for launch?', 1).map(
        ({ outcome, packId, packVersion }) => ({ outcome, packId, packVersion }),
      ),
    ).toEqual([
      { outcome: 'rejected', packId: 'launch-a', packVersion: 3 },
      { outcome: 'chosen', packId: 'launch-b', packVersion: 2 },
    ]);
  });

  it('does not retrieve irrelevant packs or invent evidence for empty frames', () => {
    const unrelated = pack({
      id: 'vacation',
      title: 'Holiday travel',
      decisions: [
        {
          id: 'beach',
          option: 'Beach hotel',
          outcome: 'chosen',
          reason: 'Close to the water.',
          scope: 'preference',
        },
      ],
    });
    expect(selectSituationDecisionContext([unrelated], 'How do project plans work?')).toEqual([]);
    expect(selectSituationDecisionContext([unrelated], '   ')).toEqual([]);
  });
});
