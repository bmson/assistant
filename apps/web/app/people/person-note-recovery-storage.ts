import type { OwnerEditorStorage } from '@/lib/owner-editor-client';

/**
 * Scope a person-note marker to the verified owner/server/session partition,
 * while retaining the shared marker as an operation-wide lock for existing
 * editor controls. If a generic control already cleared that shared lock, the
 * original scoped marker may still be checked by its exact operation; only the
 * operation controller's qualified terminal-receipt path can remove it.
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
      if (scoped !== null && (shared === scoped || shared === null)) return scoped;
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
      } else if (scoped !== null && shared === null) {
        // The caller reaches removeItem only after validating the exact same-op
        // terminal reply. A missing shared lock alone never clears this marker.
        base.removeItem(scopedKey(key));
      }
    },
  };
}
