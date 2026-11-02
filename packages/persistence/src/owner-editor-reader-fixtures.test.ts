import { describe, expect, it } from 'vitest';
import { deserializeMigrationValue, serializeMigrationValue } from './migration.js';
import {
  invalidCreateOwnerMemoryReaderRecords,
  readerFixtures,
} from './owner-editor-reader-fixtures.test-support.js';
import { parseOwnerEditorOperationRecord } from './owner-editor-storage.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-11-01T20:00:00.000Z');
const fixtures = readerFixtures({ ownerId, epoch, now, privacyGeneration: null });

describe('shared owner-editor reader qualification fixtures', () => {
  it('keeps the five prior saved commands readable with their exact persisted result shapes', () => {
    expect(fixtures.oldSaved).toHaveLength(5);
    for (const fixture of fixtures.oldSaved) {
      const parsed = parseOwnerEditorOperationRecord(fixture.record);
      expect(parsed.command).toBe(fixture.scope.command);
      expect(parsed.status).toBe('committed');
      expect(parsed.result?.outcome).toBe('saved');
      expect(parsed.scopeDigest).toBe(fixture.record.scopeDigest);
    }
  });

  it('round-trips valid Date fields and accepts every valid create receipt state', () => {
    const create = fixtures.createOwnerMemory;
    const states = [
      create.preparing,
      create.expiredPreparing,
      create.savedRefresh,
      create.savedNoRefresh,
      create.conflict,
      create.invalid,
      create.unavailable,
      ...create.notApplied,
    ];

    for (const fixture of states) {
      expect(fixture.scope.expiresAt - fixture.scope.issuedAt).toBe(600_000);
      expect(fixture.record.formExpiresAt.getTime()).toBe(fixture.scope.expiresAt);
      const parsed = parseOwnerEditorOperationRecord(
        deserializeMigrationValue(serializeMigrationValue(fixture.record)),
      );
      expect(parsed.command).toBe('create_owner_memory');
      expect(parsed.formIssuedAt).toBeInstanceOf(Date);
      expect(parsed.formExpiresAt).toBeInstanceOf(Date);
      expect(parsed.createdAt).toBeInstanceOf(Date);
      expect(parsed.updatedAt).toBeInstanceOf(Date);
    }

    expect(create.savedRefresh.record.result).toMatchObject({
      outcome: 'saved',
      refreshPending: true,
    });
    expect(create.savedNoRefresh.record.result).toMatchObject({
      outcome: 'saved',
      refreshPending: false,
    });
    expect(create.preparing.record.result).toBeNull();
    expect(create.preparing.proof.scope).toEqual(create.preparing.scope);
    expect(create.preparing.claim.claimExpiresAt).toEqual(create.preparing.record.claimExpiresAt);
    expect(create.expiredPreparing.proof.claimIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(create.notApplied.map(({ record }) => record.result?.outcome)).toEqual([
      'not_applied',
      'not_applied',
    ]);
  });

  it('rejects invalid unchanged, extra-ID, state, and native-date variants without coercion', () => {
    const variants = invalidCreateOwnerMemoryReaderRecords(fixtures.createOwnerMemory.savedRefresh);
    for (const candidate of Object.values(variants))
      expect(() => parseOwnerEditorOperationRecord(candidate)).toThrow();

    const decoded = deserializeMigrationValue(
      serializeMigrationValue(fixtures.createOwnerMemory.savedRefresh.record),
    );
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('Migration date round-trip did not return an operation record');
    expect(() =>
      parseOwnerEditorOperationRecord({ ...decoded, createdAt: '2026-11-01T20:00:00.000Z' }),
    ).toThrow();
  });
});
