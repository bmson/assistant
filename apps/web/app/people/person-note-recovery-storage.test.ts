import { webcrypto } from 'node:crypto';
import type { OwnerEditorFormGrant } from '@assistant/persistence/owner-editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerEditorStorage } from '@/lib/owner-editor-client';
import { OwnerEditorOperation } from '@/lib/owner-editor-operation';
import { ownerEditorRequestHash } from '../../../../packages/application/src/owner-editor-hash';
import { buildPersonNoteCreateRequest, type PersonNoteCreateSnapshot } from './person-note-creator';
import { personNoteRecoveryStorage } from './person-note-recovery-storage';

class MemoryStorage implements OwnerEditorStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const marker = JSON.stringify({
  id: 'opaque-original-handle',
  command: 'create_owner_memory',
  targetId: 'contact-a',
});
const session = {
  ownerId: '11111111-1111-4111-8111-111111111111',
  formSessionScope: 'same-owner-session-scope',
};
const key = `owner-editor:v1:${encodeURIComponent(session.ownerId)}:${encodeURIComponent(session.formSessionScope)}`;
const snapshot: PersonNoteCreateSnapshot = {
  contactId: '22222222-2222-4222-8222-222222222222',
  name: 'Alex Example',
  trust: 'known',
  revision: 'a'.repeat(64),
};
const grant: OwnerEditorFormGrant = {
  command: 'create_owner_memory',
  operationId: '44444444-4444-4444-8444-444444444444',
  issuedOperationHandle: 'opaque-original-operation-handle',
};

afterEach(() => vi.unstubAllGlobals());

describe('person-note recovery storage partition', () => {
  it('writes a same-scope marker with a shared lock and clears only its exact value', () => {
    const base = new MemoryStorage();
    const storage = personNoteRecoveryStorage(base, 'partition-a');
    storage.setItem(key, marker);
    expect(storage.getItem(key)).toBe(marker);
    expect(base.getItem(key)).toBe(marker);
    storage.removeItem(key);
    expect(base.getItem(key)).toBeNull();
  });

  it('does not read or remove another partition marker as current authority', () => {
    const base = new MemoryStorage();
    const original = personNoteRecoveryStorage(base, 'partition-a');
    original.setItem(key, marker);
    const bytesBefore = new Map(base.values);
    const other = personNoteRecoveryStorage(base, 'partition-b');
    expect(() => other.getItem(key)).toThrow(/different recovery partition/);
    expect(() => other.removeItem(key)).not.toThrow();
    expect(base.values).toEqual(bytesBefore);
  });

  it('blocks writing over an existing operation from another editor or server', () => {
    const base = new MemoryStorage();
    base.setItem(key, marker);
    const storage = personNoteRecoveryStorage(base, 'partition-b');
    expect(() =>
      storage.setItem(key, JSON.stringify({ ...JSON.parse(marker), id: 'new' })),
    ).toThrow(/already tracked/);
    expect(base.getItem(key)).toBe(marker);
  });

  it('leaves the old owner/session record untouched when the next owner has a different key', () => {
    const base = new MemoryStorage();
    const oldOwnerKey = 'owner-editor:v1:owner-a:session-a';
    const nextOwnerKey = 'owner-editor:v1:owner-b:session-b';
    const oldScope = personNoteRecoveryStorage(base, 'owner-a-server-a-session-a');
    oldScope.setItem(oldOwnerKey, marker);
    const oldBytes = base.getItem(oldOwnerKey);
    const nextScope = personNoteRecoveryStorage(base, 'owner-b-server-a-session-b');
    expect(nextScope.getItem(nextOwnerKey)).toBeNull();
    expect(base.getItem(oldOwnerKey)).toBe(oldBytes);
  });

  it('reopens the same operation after a generic control clears the shared marker', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const base = new MemoryStorage();
    const recovery = personNoteRecoveryStorage(base, 'partition-a');
    const content = 'Alex prefers morning meetings.';
    const request = buildPersonNoteCreateRequest({
      session,
      snapshot,
      grant,
      content,
      domain: 'relationships',
      importance: 3,
      pinned: false,
    });
    if (!request) throw Error('Expected a valid person-note request');
    const reply = {
      version: 1,
      authority: 'operation_receipt',
      command: 'create_owner_memory',
      operationId: grant.operationId,
      requestHash: ownerEditorRequestHash(request),
      statusVersion: 1,
      outcome: 'saved',
      ids: { memoryId: '33333333-3333-4333-8333-333333333333' },
      revision: 'b'.repeat(64),
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Error('connection lost'))
      .mockResolvedValueOnce(Response.json(reply))
      .mockResolvedValueOnce(Response.json(reply));

    const firstPersonNote = new OwnerEditorOperation(session, () => recovery, fetcher);
    firstPersonNote.initialize();
    await firstPersonNote.apply(request, grant, snapshot.contactId);
    expect(firstPersonNote.getSnapshot().phase).toBe('pending');
    expect(base.getItem(key)).not.toBeNull();
    expect(base.getItem(`person-note-recovery:partition-a:${key}`)).not.toBeNull();

    const genericControl = new OwnerEditorOperation(session, () => base, fetcher);
    genericControl.initialize();
    expect(genericControl.getSnapshot().phase).toBe('pending');
    await genericControl.checkPendingResult();
    expect(genericControl.getSnapshot().phase).toBe('resolved');
    expect(base.getItem(key)).toBeNull();
    expect(base.getItem(`person-note-recovery:partition-a:${key}`)).not.toBeNull();

    const personNote = new OwnerEditorOperation(session, () => recovery, fetcher);
    personNote.initialize();
    expect(personNote.getSnapshot()).toMatchObject({
      phase: 'pending',
      marker: {
        id: grant.issuedOperationHandle,
        command: grant.command,
        targetId: snapshot.contactId,
      },
    });
    await personNote.checkPendingResult();

    expect(personNote.getSnapshot()).toMatchObject({ phase: 'resolved', reply });
    expect(base.getItem(key)).toBeNull();
    expect(base.getItem(`person-note-recovery:partition-a:${key}`)).toBeNull();
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET', 'GET']);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      `operation=${encodeURIComponent(grant.issuedOperationHandle)}`,
    );
    expect(String(fetcher.mock.calls[2]?.[0])).toContain(
      `operation=${encodeURIComponent(grant.issuedOperationHandle)}`,
    );
  });
});
