import { describe, expect, it } from 'vitest';
import type { OwnerEditorStorage } from '@/lib/owner-editor-client';
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

const key = 'owner-editor:v1:owner:session';
const marker = JSON.stringify({
  id: 'opaque-original-handle',
  command: 'create_owner_memory',
  targetId: 'contact-a',
});

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
});
