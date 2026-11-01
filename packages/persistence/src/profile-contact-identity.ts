import { ownerEditorSnapshotRevision } from './owner-editor-identity.js';

export type ContactIdentityAuthority = 'owner' | 'inferred';

export type ProfileContactIdentityMutation =
  | { status: 'updated'; name: string; aliases: string[] }
  | { status: 'review_required' | 'conflict' | 'not_found' };

/** Identity changes require the revision that accompanied the displayed contact. */
export function isContactIdentityRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Strict portable metadata parser; missing legacy values stay unknown. */
export function parseContactIdentityAuthority(value: unknown): ContactIdentityAuthority | null {
  if (value === undefined || value === null) return null;
  if (value === 'owner' || value === 'inferred') return value;
  throw new Error('Invalid contact identity authority');
}

/** Keep this descriptor shape identical to the existing B2 contact CAS. */
export function profileContactIdentityRevision(snapshot: {
  driver: 'postgres';
  ownerId: string;
  native: Record<string, unknown>;
}): string;
export function profileContactIdentityRevision(snapshot: {
  driver: 'firestore';
  ownerId: string;
  id: string;
  updateTime: { seconds: number; nanoseconds: number };
}): string;
export function profileContactIdentityRevision(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new Error('Invalid contact identity snapshot');
  const row = snapshot as Record<string, unknown>;
  if (row.driver === 'postgres') {
    if (
      typeof row.ownerId !== 'string' ||
      !row.ownerId ||
      !row.native ||
      typeof row.native !== 'object' ||
      Array.isArray(row.native)
    )
      throw new Error('Invalid PostgreSQL contact identity snapshot');
  } else if (row.driver === 'firestore') {
    const time = row.updateTime as Record<string, unknown> | null;
    if (
      typeof row.ownerId !== 'string' ||
      !row.ownerId ||
      typeof row.id !== 'string' ||
      !row.id ||
      !time ||
      !Number.isSafeInteger(time.seconds) ||
      Number(time.seconds) < 0 ||
      !Number.isSafeInteger(time.nanoseconds) ||
      Number(time.nanoseconds) < 0 ||
      Number(time.nanoseconds) > 999_999_999
    )
      throw new Error('Invalid Firestore contact identity snapshot');
  } else {
    throw new Error('Unsupported contact identity snapshot driver');
  }
  return ownerEditorSnapshotRevision(snapshot);
}
