import { expect, it } from 'vitest';
import { flattenFactRetirements } from './consolidation.js';

const facts = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id,
  confidence: '0.80',
  createdAt: new Date(index * 1000),
  ownerConfirmed: id === 'b',
}));
it('breaks overlapping two-way and longer cycles with a deterministic live survivor', () => {
  for (const edges of [
    new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]),
    new Map([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['d', 'a'],
    ]),
  ]) {
    const flattened = flattenFactRetirements(edges, facts);
    expect(flattened.has('b')).toBe(false);
    for (const [loser, survivor] of flattened) {
      expect(loser).not.toBe(survivor);
      expect(flattened.has(survivor)).toBe(false);
      expect(survivor).toBe('b');
    }
    expect(flattenFactRetirements(new Map([...edges].reverse()), facts)).toEqual(flattened);
  }
});
it('flattens chains and rejects unsupported targets', () => {
  expect(
    flattenFactRetirements(
      new Map([
        ['a', 'c'],
        ['c', 'd'],
      ]),
      facts,
    ),
  ).toEqual(
    new Map([
      ['a', 'd'],
      ['c', 'd'],
    ]),
  );
  expect(() => flattenFactRetirements(new Map([['a', 'foreign']]), facts)).toThrow('unknown fact');
});
