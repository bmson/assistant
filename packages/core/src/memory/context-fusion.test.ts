import { describe, expect, it } from 'vitest';
import type { ContextCandidate } from './context-fusion.js';
import { fuseContextCandidates, lexicalContextScore } from './context-fusion.js';
import { fuseOwnerContext } from './fused-owner-context.js';

function candidate(
  key: number,
  label: string,
  score: number,
  kind: 'chat' | 'knowledge_graph' | 'decision' | 'commitment' = 'chat',
  date = '2026-01-01',
): ContextCandidate {
  return {
    text: label,
    score,
    source: {
      date,
      label,
      kind,
      surfaceKey: key.toString(16).padStart(64, '0'),
      sourceRevision: (key + 100).toString(16).padStart(64, '0'),
    },
  };
}

describe('bounded fused owner context selection', () => {
  it.each([
    {
      name: 'long history selects the relevant older summary over unrelated recent turns',
      candidates: [
        candidate(1, 'Vacation packing list', 0.91),
        candidate(2, 'Weekly grocery list', 0.33),
      ],
      expected: ['Vacation packing list'],
      limit: 1,
    },
    {
      name: 'pronoun continuity can select the only source that resolves the prior referent',
      candidates: [
        candidate(3, 'The owner chose the blue one for the trip', 0.89),
        candidate(4, 'Blue paint options', 0.4),
      ],
      expected: ['The owner chose the blue one for the trip'],
      limit: 1,
    },
    {
      name: 'topic change omits the previous topic when it has no match',
      candidates: [
        candidate(5, 'Passport renewal appointment', 0),
        candidate(6, 'Current pasta recipe question', 0.93),
      ],
      expected: ['Current pasta recipe question'],
      limit: 2,
    },
    {
      name: 'temporary exception outranks a broad historical preference when explicitly relevant',
      candidates: [
        candidate(7, 'Usually prefers morning meetings', 0.82),
        candidate(8, 'This week only, schedule after 2 PM', 0.94),
      ],
      expected: ['This week only, schedule after 2 PM'],
      limit: 1,
    },
    {
      name: 'rejected options retain their negative outcome in the selected evidence',
      candidates: [
        candidate(
          9,
          'Rejected: move the launch to Friday because support is unavailable',
          0.86,
          'decision',
        ),
      ],
      expected: ['Rejected: move the launch to Friday because support is unavailable'],
      limit: 1,
    },
    {
      name: 'same-name ambiguity keeps distinct source candidates instead of merging identities',
      candidates: [
        candidate(10, 'Alex from design owns the mockups', 0.81),
        candidate(11, 'Alex from finance approved the budget', 0.8),
      ],
      expected: ['Alex from design owns the mockups', 'Alex from finance approved the budget'],
      limit: 2,
    },
    {
      name: 'current evidence wins over an older conflicting statement',
      candidates: [
        candidate(12, 'Historical plan: leave on Monday', 0.72, 'decision', '2024-01-01'),
        candidate(13, 'Current plan: leave on Tuesday', 0.91, 'decision', '2026-02-01'),
      ],
      expected: ['Current plan: leave on Tuesday'],
      limit: 1,
    },
    {
      name: 'an honest miss returns no context block',
      candidates: [candidate(14, 'Old unrelated note', 0)],
      expected: [],
      limit: 4,
    },
    {
      name: 'private or untrusted sources are excluded by the upstream owner-trust gate',
      candidates: [],
      expected: [],
      limit: 1,
    },
    {
      name: 'fuser keeps the visible replacement after source suppression refills candidates',
      candidates: [candidate(17, 'Visible supporting source', 0.72)],
      expected: ['Visible supporting source'],
      limit: 1,
    },
    {
      name: 'one stable source identity is included only once',
      candidates: [
        candidate(18, 'Current rendering', 0.89),
        { ...candidate(18, 'Duplicate rendering', 0.7) },
      ],
      expected: ['Current rendering'],
      limit: 2,
    },
    {
      name: 'opposing decisions remain visible as separate evidence when both matter',
      candidates: [
        candidate(19, 'Pack A version 3 chose option Cedar', 0.8, 'decision'),
        candidate(20, 'Pack B version 5 rejected option Cedar', 0.79, 'decision'),
      ],
      expected: ['Pack A version 3 chose option Cedar', 'Pack B version 5 rejected option Cedar'],
      limit: 2,
    },
    {
      name: 'commitment evidence competes in the same ranked pool as graph evidence',
      candidates: [
        candidate(21, 'graph: old office address', 0.7, 'knowledge_graph'),
        candidate(22, 'commitment: submit the travel receipt tomorrow', 0.88, 'commitment'),
      ],
      expected: ['commitment: submit the travel receipt tomorrow'],
      limit: 1,
    },
    {
      name: 'UTF-8 byte budget prevents a large source from hiding other candidates',
      candidates: [candidate(23, 'x'.repeat(400), 0.95), candidate(24, 'Short relevant note', 0.8)],
      expected: ['Short relevant note'],
      limit: 2,
      maxBytes: 180,
    },
    {
      name: 'context remains reference evidence and carries no action authority',
      candidates: [
        candidate(25, 'Earlier owner preference: do not book without asking first', 0.84),
      ],
      expected: ['Earlier owner preference: do not book without asking first'],
      limit: 1,
    },
  ])('$name', ({ candidates, expected, limit, maxBytes }) => {
    const result = fuseContextCandidates(candidates, { limit, maxBytes });
    expect(result.selected.map((entry) => entry.text)).toEqual(expected);
    if (expected.length === 0) expect(result.block).toBe('');
    else expect(result.block).toContain('never action permission');
  });

  it('computes a deterministic lexical score for explicit owner-open-loop matches', () => {
    expect(
      lexicalContextScore(
        'Did I promise to send the travel receipt?',
        'promise: submit the travel receipt',
      ),
    ).toBeGreaterThan(0.7);
    expect(lexicalContextScore('What is the weather?', 'promise: submit the travel receipt')).toBe(
      0,
    );
  });

  it('fuses active decisions with their pack revision and skips an owner-muted revision', async () => {
    const fused = await fuseOwnerContext({
      queryText: 'why did we reject the Cedar plan',
      rankedContext: [candidate(26, 'Earlier message about Cedar', 0.82)],
      decisions: [
        {
          decisionId: 'cedar',
          option: 'Cedar plan',
          outcome: 'rejected',
          reason: 'The launch window conflicts with support coverage.',
          scope: 'situation',
          packId: 'pack-1',
          packTitle: 'Launch plan',
          packVersion: 4,
          packUpdatedAt: '2026-08-01T12:00:00.000Z',
          relevance: 0.93,
        },
      ],
      isSuppressed: async (_key, revision) =>
        revision === (26 + 100).toString(16).padStart(64, '0'),
      limit: 3,
    });
    expect(fused.selected).toHaveLength(1);
    expect(fused.sources[0]?.kind).toBe('decision');
    expect(fused.sources[0]?.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(fused.block).toContain('version 4');
    expect(fused.block).toContain('rejected');
  });
});
