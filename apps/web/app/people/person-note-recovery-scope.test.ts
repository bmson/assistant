import { describe, expect, it } from 'vitest';
import { personNoteRecoveryPartition } from './person-note-recovery-scope';

const base = {
  authSecret: 'test-secret-only',
  ownerEmail: 'owner@example.test',
  ownerId: '11111111-1111-4111-8111-111111111111',
  formSessionScope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  persistenceDriver: 'postgres' as const,
  workspaceId: 'test-workspace',
  databaseUrl: 'postgres://user:password@db.example.test:5432/assistant',
  firestoreProject: '',
  firestoreDatabaseId: '',
};

describe('person-note recovery partition', () => {
  it('stays stable when current issuance disappears and does not expose identity/config values', () => {
    const withGrant = personNoteRecoveryPartition(base);
    const withoutGrant = personNoteRecoveryPartition(base);
    expect(withGrant).toBeTruthy();
    expect(withoutGrant).toBe(withGrant);
    expect(withGrant).toMatch(/^[a-f0-9]{64}$/);
    expect(withGrant).not.toContain(base.ownerEmail);
    expect(withGrant).not.toContain('db.example.test');
    expect(withGrant).not.toContain('password');
  });

  it.each([
    { ownerEmail: 'other@example.test' },
    { ownerId: '22222222-2222-4222-8222-222222222222' },
    { formSessionScope: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { workspaceId: 'other-workspace' },
    { databaseUrl: 'postgres://user:password@other.example.test:5432/assistant' },
  ])('isolates a changed owner/server/session scope (%s)', (change) => {
    expect(personNoteRecoveryPartition({ ...base, ...change })).not.toBe(
      personNoteRecoveryPartition(base),
    );
  });

  it('fails closed if the current authenticated owner/server/session scope is unverified', () => {
    expect(personNoteRecoveryPartition({ ...base, ownerId: null })).toBeNull();
    expect(personNoteRecoveryPartition({ ...base, formSessionScope: null })).toBeNull();
    expect(personNoteRecoveryPartition({ ...base, databaseUrl: '' })).toBeNull();
    expect(personNoteRecoveryPartition({ ...base, authSecret: undefined })).toBeNull();
  });

  it('changes the partition when the Firestore project/database server changes', () => {
    const firestore = {
      ...base,
      persistenceDriver: 'firestore' as const,
      firestoreProject: 'project-a',
      firestoreDatabaseId: 'database-a',
    };
    expect(personNoteRecoveryPartition(firestore)).not.toBe(
      personNoteRecoveryPartition({ ...firestore, firestoreProject: 'project-b' }),
    );
    expect(personNoteRecoveryPartition(firestore)).not.toBe(
      personNoteRecoveryPartition({ ...firestore, firestoreDatabaseId: 'database-b' }),
    );
  });
});
