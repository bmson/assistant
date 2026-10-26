import { describe, expect, it } from 'vitest';
import {
  clearOwnerEditorPendingMarker,
  decodeOwnerEditorReply,
  type OwnerEditorPendingMarker,
  type OwnerEditorStorage,
  ownerEditorRoute,
  readOwnerEditorPendingMarker,
  writeOwnerEditorPendingMarker,
} from './owner-editor-client';

const operationId = '11111111-1111-4111-8111-111111111111';
const requestHash = 'a'.repeat(64);
const marker: OwnerEditorPendingMarker = {
  id: 'issued-handle-a',
  command: 'update_person_identity',
  targetId: '22222222-2222-4222-8222-222222222222',
};

class MemoryStorage implements OwnerEditorStorage {
  values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  getItem(key: string) {
    if (this.failReads) throw new Error('read failed');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('write failed');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    authority: 'operation_receipt',
    command: marker.command,
    operationId,
    requestHash,
    statusVersion: 2,
    outcome: 'saved',
    ids: { contactId: '22222222-2222-4222-8222-222222222222' },
    revision: 'c'.repeat(64),
    ...overrides,
  };
}

function seededStorage() {
  const storage = new MemoryStorage();
  writeOwnerEditorPendingMarker(storage, 'owner-a', 'session-a', marker);
  return storage;
}

describe('owner editor client helpers', () => {
  it('maps only declared commands to their exact endpoints', () => {
    expect(ownerEditorRoute('create_person')).toBe('/api/people/editor');
    expect(ownerEditorRoute('update_person_identity')).toBe('/api/people/editor');
    expect(ownerEditorRoute('add_family_relationship')).toBe('/api/profile/knowledge/family');
    expect(ownerEditorRoute('correct_owner_family_relationship')).toBe(
      '/api/profile/knowledge/family',
    );
    expect(ownerEditorRoute('correct_owner_memory')).toBe('/api/profile/knowledge/memory');
  });

  it('decodes complete authoritative replies and rejects empty or malformed fulfilled JSON', () => {
    expect(decodeOwnerEditorReply(receipt())?.authority).toBe('operation_receipt');
    expect(decodeOwnerEditorReply({})).toBeNull();
    expect(decodeOwnerEditorReply({ ...receipt(), requestHash: 'short' })).toBeNull();
    expect(
      decodeOwnerEditorReply({ ...receipt(), authority: 'unresolved', outcome: 'saved' }),
    ).toBeNull();
  });

  it('accepts a memory correction receipt with only memoryId and rejects extra saved identities', () => {
    const memoryReceipt = {
      version: 1,
      authority: 'operation_receipt',
      command: 'correct_owner_memory',
      operationId,
      requestHash,
      statusVersion: 3,
      outcome: 'saved',
      ids: { memoryId: '22222222-2222-4222-8222-222222222222' },
      revision: 'c'.repeat(64),
    };
    expect(decodeOwnerEditorReply(memoryReceipt)).toMatchObject({
      command: 'correct_owner_memory',
      authority: 'operation_receipt',
      ids: { memoryId: '22222222-2222-4222-8222-222222222222' },
    });
    expect(
      decodeOwnerEditorReply({
        ...memoryReceipt,
        ids: {
          memoryId: '22222222-2222-4222-8222-222222222222',
          relationId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    ).toBeNull();
  });

  it('keeps original A pending after a changed-body B rejection, then clears on A terminal receipt', () => {
    const storage = seededStorage();
    const rejectedB = decodeOwnerEditorReply({
      version: 1,
      authority: 'request_rejection',
      command: marker.command,
      operationId,
      outcome: 'conflict',
      originalOperationTerminal: false,
      reason: 'request_hash_mismatch',
    });
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        'owner-a',
        'session-a',
        marker,
        rejectedB,
        operationId,
        requestHash,
      ),
    ).toBe(false);
    expect(readOwnerEditorPendingMarker(storage, 'owner-a', 'session-a')).toEqual(marker);

    const terminalA = decodeOwnerEditorReply(receipt());
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        'owner-a',
        'session-a',
        marker,
        terminalA,
        operationId,
        requestHash,
      ),
    ).toBe(true);
    expect(readOwnerEditorPendingMarker(storage, 'owner-a', 'session-a')).toBeNull();
  });

  it('does not clear for wrong target marker, operation, command, hash, or non-authoritative authority', () => {
    const storage = seededStorage();
    const terminal = decodeOwnerEditorReply(receipt());
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        'owner-a',
        'session-a',
        { ...marker, targetId: 'other' },
        terminal,
        operationId,
        requestHash,
      ),
    ).toBe(false);
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        'owner-a',
        'session-a',
        marker,
        terminal,
        'other-op',
        requestHash,
      ),
    ).toBe(false);
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        'owner-a',
        'session-a',
        marker,
        terminal,
        operationId,
        'b'.repeat(64),
      ),
    ).toBe(false);
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        'owner-a',
        'session-a',
        marker,
        decodeOwnerEditorReply({
          version: 1,
          authority: 'unresolved',
          command: marker.command,
          operationId,
          outcome: 'outcome_unknown',
          reason: 'receipt_missing',
        }),
        operationId,
        requestHash,
      ),
    ).toBe(false);
    expect(readOwnerEditorPendingMarker(storage, 'owner-a', 'session-a')).toEqual(marker);
  });

  it('stores only marker metadata and scopes it by owner and form session', () => {
    const storage = new MemoryStorage();
    writeOwnerEditorPendingMarker(storage, 'owner-a', 'session-a', marker);
    const raw = [...storage.values.values()][0];
    expect(raw).toBe(JSON.stringify(marker));
    expect(raw).not.toContain('name');
    expect(raw).not.toContain('note');
    expect(readOwnerEditorPendingMarker(storage, 'owner-b', 'session-a')).toBeNull();
    expect(readOwnerEditorPendingMarker(storage, 'owner-a', 'session-b')).toBeNull();
  });

  it('fails closed on storage errors, tampering, and existing markers', () => {
    const storage = new MemoryStorage();
    storage.failReads = true;
    expect(() => writeOwnerEditorPendingMarker(storage, 'owner-a', 'session-a', marker)).toThrow();
    storage.failReads = false;
    storage.failWrites = true;
    expect(() => writeOwnerEditorPendingMarker(storage, 'owner-a', 'session-a', marker)).toThrow();
    storage.failWrites = false;
    storage.values.set(
      'owner-editor:v1:owner-a:session-a',
      JSON.stringify({ ...marker, note: 'private' }),
    );
    expect(() => readOwnerEditorPendingMarker(storage, 'owner-a', 'session-a')).toThrow();
    expect(() => writeOwnerEditorPendingMarker(storage, 'owner-a', 'session-a', marker)).toThrow();
  });
});

describe('strict owner editor wire response identities', () => {
  it.each([
    { operationId: 'operation-1' },
    { operationId: '' },
    { revision: 'revision-1' },
    { ids: {} },
    { ids: { contactId: '' } },
    { ids: { contactId: 'contact-1' } },
    { ids: { relationId: '22222222-2222-4222-8222-222222222222' } },
    {
      ids: {
        contactId: '22222222-2222-4222-8222-222222222222',
        mysteryId: '33333333-3333-4333-8333-333333333333',
      },
    },
  ])('rejects malformed or command-incomplete durable identity %j', (overrides) => {
    expect(decodeOwnerEditorReply(receipt(overrides))).toBeNull();
  });
  it('accepts only complete UUID family durable identities and hashed operation revision', () => {
    expect(
      decodeOwnerEditorReply(
        receipt({
          command: 'add_family_relationship',
          ids: {
            relationId: '22222222-2222-4222-8222-222222222222',
            memoryId: '33333333-3333-4333-8333-333333333333',
            assertionId: '44444444-4444-4444-8444-444444444444',
          },
        }),
      )?.authority,
    ).toBe('operation_receipt');
  });
});
