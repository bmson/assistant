import { describe, expect, it } from 'vitest';
import {
  canRewriteConsolidationFacts,
  earliestConsolidationSource,
} from './consolidation-temporal.js';

const old = new Date('2020-01-01Z');
const fact = { content: 'Drinks coffee black.', createdAt: old, validFrom: null, validUntil: null };
describe('consolidation temporal invariants', () => {
  it.each([
    ['historical', { validUntil: new Date('2023-01-01Z') }],
    ['future', { validFrom: new Date('2099-01-01Z') }],
    ['overlap', { validFrom: old, validUntil: new Date('2023-01-01Z') }],
    ['unknown uncertainty', { content: 'May work at Acme, but it is unconfirmed.' }],
    ['unresolved relative date', { content: 'Worked at Acme last year.' }],
  ])('retains %s claims separately', (_label, changes) => {
    expect(canRewriteConsolidationFacts([fact, { ...fact, ...changes }])).toBe(false);
  });
  it('preserves the original observation time for a safe timeless merge', () => {
    const facts = [fact, { ...fact, createdAt: new Date('2024-01-01Z') }];
    expect(canRewriteConsolidationFacts(facts)).toBe(true);
    expect(earliestConsolidationSource(facts)).toEqual(old);
  });
});
