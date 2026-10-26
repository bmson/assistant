import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import { createPostgresRecallSurfacingRepository } from './recall-surfacing-repository.js';
import { recallSurfaces } from './schema.js';

const fence = vi.hoisted(() => ({ before: vi.fn(), after: vi.fn() }));
vi.mock('./privacy-erasure-repository.js', () => ({
  lockPostgresPrivacyObservationFence: vi.fn(),
  withPostgresPrivacyObservationFence: async (
    _db: unknown,
    owner: string,
    read: () => Promise<unknown>,
  ) => {
    await fence.before(owner);
    const result = await read();
    await fence.after(owner);
    return result;
  },
}));

const agentId = 'owner/encoded';
const sourceKey = 'a'.repeat(64);
const revision = 'b'.repeat(64);
const input = { agentId, sourceKey, expectedSourceRevision: revision };
const date = new Date('2026-10-07T12:00:00Z');
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'surface-id',
    agentId,
    sourceKey,
    sourceRevision: revision,
    kind: 'chat',
    firstSurfacedAt: date,
    lastSurfacedAt: date,
    lastMessageId: null,
    surfaceCount: 1,
    version: 1,
    suppressedAt: null,
    ...overrides,
  };
}
const malformed: Array<[string, unknown]> = [
  ['id', ''],
  ['kind', undefined],
  ['kind', ''],
  ['firstSurfacedAt', undefined],
  ['firstSurfacedAt', new Date(NaN)],
  ['lastSurfacedAt', '2026-01-01'],
  ['lastMessageId', undefined],
  ['lastMessageId', 3],
  ['surfaceCount', 0],
  ['surfaceCount', 1.5],
  ['version', undefined],
  ['version', Number.MAX_SAFE_INTEGER + 1],
  ['sourceRevision', undefined],
  ['sourceRevision', 'BAD'],
  ['sourceRevision', 42],
  ['suppressedAt', undefined],
  ['suppressedAt', '2026-01-01'],
  ['suppressedAt', 1],
  ['suppressedAt', new Date(NaN)],
  ['agentId', 'foreign'],
  ['sourceKey', 'c'.repeat(64)],
];

function setup(row: unknown = record()) {
  const limit = vi.fn(async () => (row === null ? [] : [row]));
  const where = vi.fn((_condition: Parameters<PgDialect['sqlToQuery']>[0]) => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const db = { select } as unknown as Db;
  return { repo: createPostgresRecallSurfacingRepository(db), select, from, where, limit };
}
beforeEach(() => {
  fence.before.mockReset();
  fence.after.mockReset();
});
describe('offline PostgreSQL source setting read', () => {
  it.each([
    [record(), { status: 'allowed' }],
    [record({ suppressedAt: date }), { status: 'suppressed' }],
    [record({ sourceRevision: 'c'.repeat(64) }), { status: 'stale' }],
    [record({ sourceRevision: null }), { status: 'unavailable', reason: 'unversioned_legacy' }],
    [null, { status: 'unavailable', reason: 'missing_record' }],
  ])('reads a validated ledger state through the privacy fence', async (row, expected) => {
    const s = setup(row);
    await expect(s.repo.readSourceSetting(input)).resolves.toEqual(expected);
    expect(s.select).toHaveBeenCalledWith();
    expect(s.from).toHaveBeenCalledWith(recallSurfaces);
    expect(s.limit).toHaveBeenCalledWith(1);
    const condition = s.where.mock.calls[0]?.[0];
    if (!condition) throw new Error('Expected an owner-scoped ledger predicate');
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.sql).toBe(
      '("recall_surfaces"."agent_id" = $1 and "recall_surfaces"."source_key" = $2)',
    );
    expect(query.params).toEqual([agentId, sourceKey]);
    expect(fence.before).toHaveBeenCalledWith(agentId);
    expect(fence.after).toHaveBeenCalledWith(agentId);
  });
  it.each(malformed)('rejects malformed %s before stale classification', async (field, value) => {
    const s = setup(record({ sourceRevision: 'c'.repeat(64), [field]: value }));
    await expect(s.repo.readSourceSetting(input)).rejects.toThrow();
  });
  it('rejects suppression without a versioned source', async () => {
    await expect(
      setup(record({ sourceRevision: null, suppressedAt: date })).repo.readSourceSetting(input),
    ).rejects.toThrow();
  });
  it.each([record(), null])(
    'awaits post-read privacy completion and propagates rejection',
    async (row) => {
      let release!: () => void;
      fence.after.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      let settled = false;
      const pending = setup(row)
        .repo.readSourceSetting(input)
        .then(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(fence.after).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      release();
      await pending;
      fence.after.mockRejectedValueOnce(new Error('fence changed'));
      await expect(setup(row).repo.readSourceSetting(input)).rejects.toThrow('fence changed');
    },
  );
  it('awaits the pre-read privacy fence before touching storage', async () => {
    let release!: () => void;
    fence.before.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const s = setup();
    const pending = s.repo.readSourceSetting(input);
    expect(s.select).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ status: 'allowed' });
  });
  it('propagates a pre-read privacy failure without reading storage', async () => {
    fence.before.mockRejectedValueOnce(new Error('owner/privacy failure'));
    const s = setup();
    await expect(s.repo.readSourceSetting(input)).rejects.toThrow('owner/privacy failure');
    expect(s.select).not.toHaveBeenCalled();
  });
});
