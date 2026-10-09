import { expect, it } from 'vitest';
import {
  boundGraphRelationToSource,
  type KnowledgeGraphProjectionRelation,
} from './knowledge-graph-sync.js';

const relation = { validFrom: null, validUntil: null } as KnowledgeGraphProjectionRelation;
it('does not widen historical or future source intervals', () => {
  const source = { validFrom: new Date('2019-01-01Z'), validUntil: new Date('2023-01-01Z') };
  expect(boundGraphRelationToSource(relation, source)).toMatchObject({
    validFrom: source.validFrom.toISOString(),
    validUntil: source.validUntil.toISOString(),
  });
  expect(boundGraphRelationToSource({ ...relation, validFrom: '2099-01-01' }, source)).toBeNull();
  expect(
    boundGraphRelationToSource({ ...relation, validFrom: '2020-01', validUntil: '2021' }, source),
  ).toMatchObject({ validFrom: '2020-01', validUntil: '2021' });
});
it('does not extend a midnight source expiry through the rest of its date', () => {
  expect(
    boundGraphRelationToSource(
      { ...relation, validUntil: '2023-01-01' },
      { validUntil: new Date('2023-01-01Z') },
    )?.validUntil,
  ).toBe('2023-01-01T00:00:00.000Z');
});
