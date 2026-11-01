import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { graphSourceEligible } from './graph-source-eligibility.js';
import { embeddingSpaceKey } from './memory.js';

const content = 'Owner lives in Reykjavík.';
const contentHash = createHash('sha256').update(content).digest('hex');
const space = { provider: 'test', model: 'fixture', dimensions: 2, revision: '1' };
const input = {
  memory: {
    id: 'note',
    agentId: 'owner',
    content,
    contentHash,
    category: 'knowledge',
    quarantined: false,
    supersededById: null,
    expiresAt: null,
    embedding: [1, 0],
  },
  source: { memoryId: 'note', status: 'ready', contentHash, extractionVersion: 3 },
  agentId: 'owner',
  space,
  storedSpace: embeddingSpaceKey(space),
  extractionVersion: 3,
  now: new Date('2026-10-26T00:00:00Z'),
  tombstoned: false,
};
describe('actual graph source body binding', () => {
  it('admits the exact UTF-8 body and rejects stale extraction when body changed under matching hash metadata', () => {
    expect(graphSourceEligible(input)).toBe(true);
    expect(
      graphSourceEligible({
        ...input,
        memory: { ...input.memory, content: 'Owner moved elsewhere.' },
      }),
    ).toBe(false);
    expect(
      graphSourceEligible({
        ...input,
        memory: { ...input.memory, content: undefined as unknown as string },
      }),
    ).toBe(false);
  });
});
