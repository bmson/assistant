import { describe, expect, it } from 'vitest';
import { ownerEditorSnapshotRevision } from './owner-editor-identity.js';
import {
  isContactIdentityRevision,
  parseContactIdentityAuthority,
  profileContactIdentityRevision,
} from './profile-contact-identity.js';

describe('profile contact identity revision', () => {
  it('uses the same exact native revision descriptor as the existing B2 contact CAS', () => {
    const postgres = {
      driver: 'postgres' as const,
      ownerId: 'owner-1',
      native: {
        id: 'contact-1',
        name: 'Rae',
        aliases: ['R'],
        updated_at: '2026-10-26T12:00:00.000123Z',
      },
    };
    const firestore = {
      driver: 'firestore' as const,
      ownerId: 'owner-1',
      id: 'contact-1',
      updateTime: { seconds: 1_798_000_000, nanoseconds: 123_456_789 },
    };
    expect(profileContactIdentityRevision(postgres)).toBe(ownerEditorSnapshotRevision(postgres));
    expect(profileContactIdentityRevision(firestore)).toBe(ownerEditorSnapshotRevision(firestore));
    expect(isContactIdentityRevision(profileContactIdentityRevision(postgres))).toBe(true);
    expect(isContactIdentityRevision('A'.repeat(64))).toBe(false);
    expect(isContactIdentityRevision('0'.repeat(63))).toBe(false);
  });

  it('fails closed for missing or malformed native revision data and authority metadata', () => {
    expect(() =>
      profileContactIdentityRevision({
        driver: 'firestore',
        ownerId: 'owner-1',
        id: 'contact-1',
        updateTime: { seconds: 1, nanoseconds: 1_000_000_000 },
      }),
    ).toThrow('Invalid Firestore contact identity snapshot');
    const readUnknownRevision = profileContactIdentityRevision as (value: unknown) => string;
    expect(() => readUnknownRevision({ driver: 'unknown' })).toThrow(
      'Unsupported contact identity snapshot driver',
    );
    expect(parseContactIdentityAuthority(undefined)).toBeNull();
    expect(parseContactIdentityAuthority(null)).toBeNull();
    expect(parseContactIdentityAuthority('owner')).toBe('owner');
    expect(parseContactIdentityAuthority('inferred')).toBe('inferred');
    expect(() => parseContactIdentityAuthority('trusted')).toThrow(
      'Invalid contact identity authority',
    );
  });
});
