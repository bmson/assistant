import type { OwnerEditorStorage } from '@/lib/owner-editor-client';

/**
 * Scope a person-note marker to the verified owner/server/session partition,
 * while retaining the shared unscoped marker as an operation-wide lock for
 * existing editor controls. A marker from another partition blocks new work;
 * it is never read as authority or removed from here.
 */
export function personNoteRecoveryStorage(
  base: OwnerEditorStorage,
  partition: string,
): OwnerEditorStorage {
  const scopedKey = (key: string) => `person-note-recovery:${partition}:${key}`;
  return {
    getItem(key) {
      const scoped = base.getItem(scopedKey(key));
      const shared = base.getItem(key);
      if (scoped !== null && shared === scoped) return scoped;
      if (scoped !== null || shared !== null)
        throw new Error('A save belongs to a different recovery partition.');
      return null;
    },
    setItem(key, value) {
      const scoped = base.getItem(scopedKey(key));
      const shared = base.getItem(key);
      if ((scoped !== null && scoped !== value) || (shared !== null && shared !== value))
        throw new Error('Another owner-editor operation is already tracked.');
      base.setItem(key, value);
      try {
        base.setItem(scopedKey(key), value);
      } catch (error) {
        if (shared === null && base.getItem(key) === value) base.removeItem(key);
        throw error;
      }
    },
    removeItem(key) {
      const scoped = base.getItem(scopedKey(key));
      const shared = base.getItem(key);
      if (scoped !== null && shared === scoped) {
        base.removeItem(scopedKey(key));
        base.removeItem(key);
      }
    },
  };
}
