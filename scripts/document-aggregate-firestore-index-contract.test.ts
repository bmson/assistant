import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const spec = JSON.parse(
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

describe('document aggregate Firestore index contract', () => {
  it('declares the index required by the owner-scoped chunk-count aggregate', () => {
    const documents = source('packages/firestore/src/documents.ts');
    expect(documents).toContain(
      "const ownedDocuments = this.store.collection('documents').where('agentId', '==', agentId);",
    );
    expect(documents).toContain(
      "ownedDocuments .aggregate({ total: AggregateField.count(), chunks: AggregateField.sum('chunkCount') }) .get(),",
    );

    expect(
      spec.indexes.some(
        (index) =>
          index.collectionGroup === 'documents' &&
          index.queryScope === 'COLLECTION' &&
          index.fields.map((field) => field.fieldPath).join('|') ===
            'agentId|chunkCount|__name__' &&
          index.fields.every((field) => field.order === 'ASCENDING'),
      ),
    ).toBe(true);
  });
});
