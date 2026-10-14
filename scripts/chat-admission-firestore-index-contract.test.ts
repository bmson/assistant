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

describe('Firestore owner-chat admission index contract', () => {
  it('supports the bounded recent-message query used for same-chat context inheritance', () => {
    const persistence = readFileSync(
      resolve(root, 'packages/firestore/src/application-chat.ts'),
      'utf8',
    ).replace(/\s+/g, ' ');
    const start = persistence.indexOf('let inheritsEphemeralContext = false;');
    const end = persistence.indexOf('const ephemeralMemory =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const admission = persistence.slice(start, end);
    expect(admission).toContain('ownerTurnReferencesEphemeralContext(input.text)');
    expect(admission).toContain(
      ".collection('messages') .where('conversationId', '==', input.conversationId) .orderBy('createdAt', 'desc') .limit(12)",
    );

    const exactIndex = indexSpec.indexes.filter(
      (index) =>
        index.collectionGroup === 'messages' &&
        index.queryScope === 'COLLECTION' &&
        JSON.stringify(index.fields) ===
          JSON.stringify([
            { fieldPath: 'conversationId', order: 'ASCENDING' },
            { fieldPath: 'createdAt', order: 'DESCENDING' },
          ]),
    );
    expect(exactIndex).toHaveLength(1);
  });
});
