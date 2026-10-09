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
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>;
};

function hasIndex(collectionGroup: string, fields: string[]): boolean {
  return spec.indexes.some(
    (index) =>
      index.collectionGroup === collectionGroup &&
      index.queryScope === 'COLLECTION' &&
      index.fields.map((field) => field.fieldPath).join('|') === fields.join('|') &&
      index.fields.every((field) => field.order === 'ASCENDING'),
  );
}

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8').replace(/\s+/g, ' ');
}

describe('email observer and attachment Firestore index contract', () => {
  it('declares the composite required by the expired observer-claim inequality', () => {
    const emailSync = source('packages/firestore/src/email-sync.ts');
    expect(emailSync).toContain("queryStatus('claimed', true)");
    expect(emailSync).toContain("due = due.where('leaseExpiresAt', '<=', now)");
    expect(hasIndex('emailObserverWork', ['agentId', 'status', 'leaseExpiresAt'])).toBe(true);
  });

  it('filters disabled observer keys before the bounded ready and expired work pages', () => {
    const emailSync = source('packages/firestore/src/email-sync.ts');
    expect(emailSync).toContain("eligible.where('observerKey', 'not-in', excludedKeys)");
    expect(emailSync).toContain(".where('observerVersion', 'not-in', versions)");
    expect(emailSync).toContain(".where('workClass', '!=', identity.workClass)");
    expect(emailSync).toContain(".orderBy('leaseExpiresAt', 'asc')");
    expect(emailSync).toContain(".orderBy('observerKey', 'asc')");
    expect(hasIndex('emailObserverWork', ['agentId', 'status', 'observerKey'])).toBe(true);
    expect(
      hasIndex('emailObserverWork', ['agentId', 'status', 'leaseExpiresAt', 'observerKey']),
    ).toBe(true);
    expect(
      hasIndex('emailObserverWork', ['agentId', 'status', 'observerKey', 'observerVersion']),
    ).toBe(true);
    expect(
      hasIndex('emailObserverWork', [
        'agentId',
        'status',
        'observerKey',
        'leaseExpiresAt',
        'observerVersion',
      ]),
    ).toBe(true);
    expect(
      hasIndex('emailObserverWork', [
        'agentId',
        'status',
        'observerKey',
        'observerVersion',
        'workClass',
      ]),
    ).toBe(true);
    expect(
      hasIndex('emailObserverWork', [
        'agentId',
        'status',
        'observerKey',
        'observerVersion',
        'leaseExpiresAt',
        'workClass',
      ]),
    ).toBe(true);
  });

  it('keeps attachment cleanup query shapes explicit for predictable planning', () => {
    const custody = source('packages/firestore/src/email-attachment-custody.ts');
    const deletion = source('packages/firestore/src/document-deletion.ts');
    expect(custody).toContain(
      ".where('agentId', '==', input.agentId) .where('kind', '==', 'email_attachment_custody') .orderBy('__name__')",
    );
    expect(custody).toContain(
      ".where('kind', '==', 'email_attachment_custody') .where('custodyId', '==', row.id)",
    );
    expect(deletion).toContain(
      ".where('agentId', '==', agentId) .where('documentId', '==', documentId)",
    );
    expect(hasIndex('privacyErasureAssets', ['agentId', 'kind', '__name__'])).toBe(true);
    expect(hasIndex('privacyErasureAssets', ['kind', 'custodyId'])).toBe(true);
    expect(hasIndex('privacyErasureAssets', ['agentId', 'documentId'])).toBe(true);
  });

  it('keeps the nested task cleanup query covered and confirms its fields are not exempted', () => {
    const deletion = source('packages/firestore/src/document-deletion.ts');
    expect(deletion).toContain(
      ".where('agentId', '==', agentId) .where('trigger.payload.documentId', '==', documentId)",
    );
    expect(hasIndex('tasks', ['agentId', 'trigger.payload.documentId'])).toBe(true);
    expect(
      spec.fieldOverrides.some(
        (override) =>
          override.collectionGroup === 'tasks' &&
          (override.fieldPath === '*' ||
            override.fieldPath === 'trigger' ||
            override.fieldPath === 'trigger.payload.documentId'),
      ),
    ).toBe(false);
  });
});
