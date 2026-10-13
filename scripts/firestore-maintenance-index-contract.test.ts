import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const indexSpec = JSON.parse(
  readFileSync(resolve(root, 'infra/gcp/firestore/firestore.indexes.json'), 'utf8'),
) as {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<{ fieldPath: string; order?: string }>;
  }>;
};

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8').replace(/\s+/g, ' ');
}

function expectIndex(
  collectionGroup: string,
  fields: Array<{ fieldPath: string; order: 'ASCENDING' }>,
): void {
  expect(
    indexSpec.indexes.filter(
      (index) =>
        index.collectionGroup === collectionGroup &&
        index.queryScope === 'COLLECTION' &&
        JSON.stringify(index.fields) === JSON.stringify(fields),
    ),
  ).toHaveLength(1);
}

describe('Firestore maintenance query index contracts', () => {
  it('supports stale dispatch-reservation reconciliation by status and attempt time', () => {
    const costs = source('packages/firestore/src/costs.ts');
    const start = costs.indexOf('const staleDispatches = await this.store');
    const end = costs.indexOf('for (const doc of staleDispatches.docs)', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const query = costs.slice(start, end);

    expect(query).toContain(".collection('costReservations')");
    expect(query).toContain(".where('status', '==', 'dispatching')");
    expect(query).toContain(".where('attemptStartedAt', '<', cutoff)");
    expect(query).toContain(".orderBy('attemptStartedAt')");
    expect(query).toContain('.limit(batch) .get()');
    expectIndex('costReservations', [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'attemptStartedAt', order: 'ASCENDING' },
    ]);
  });

  it('supports pending and failed watch-effect polling ordered by update time', () => {
    const watches = source('packages/firestore/src/watches.ts');
    const start = watches.indexOf('async pendingFireEffects(');
    const end = watches.indexOf('async fireEffectsForFire(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const query = watches.slice(start, end);

    expect(query).toContain(".collection('watchFireEffects')");
    expect(query).toContain(".where('agentId', '==', agentId)");
    expect(query).toContain(".where('status', '==', 'pending')");
    expect(query).toContain(".where('status', '==', 'failed')");
    expect(query.match(/\.orderBy\('updatedAt'\)/g)).toHaveLength(2);
    expect(query.match(/\.limit\(cap\) \.get\(\)/g)).toHaveLength(2);
    expectIndex('watchFireEffects', [
      { fieldPath: 'agentId', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'updatedAt', order: 'ASCENDING' },
    ]);
  });
});
