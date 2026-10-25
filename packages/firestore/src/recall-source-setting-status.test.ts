import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreRecallSurfacingRepository } from './recall-surfacing.js';
import { deterministicUuid } from './stable-id.js';
import { documentKey, type InstallationStore } from './store.js';

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

const surfaceId = deterministicUuid('assistant:recall-surface', agentId, sourceKey);
function snapshot(
  id: string,
  data: Record<string, unknown> | null,
  updateTime = Timestamp.fromMillis(1000),
) {
  return {
    id,
    exists: data !== null,
    data: () => data,
    get: (key: string) => data?.[key],
    updateTime,
  };
}
function setup(
  overrides: Record<string, unknown> | null = {},
  options: {
    owner?: ReturnType<typeof snapshot>;
    physicalId?: string;
    fences?: Array<ReturnType<typeof snapshot>>;
    readError?: boolean;
  } = {},
) {
  const row =
    overrides === null
      ? null
      : record({
          id: surfaceId,
          firstSurfacedAt: Timestamp.fromDate(date),
          lastSurfacedAt: Timestamp.fromDate(date),
          ...overrides,
        });
  const completed = snapshot(documentKey(agentId), { agentId, status: 'complete' });
  const fences = options.fences ?? [completed, completed];
  let fenceIndex = 0;
  const reads: string[] = [];
  const doc = vi.fn((collection: string, id: string) => {
    const physicalId = documentKey(id);
    return {
      id: physicalId,
      get: async () => {
        reads.push(`${collection}/${physicalId}`);
        if (collection === 'privacyErasureJobs') {
          const fence = fences[Math.min(fenceIndex++, fences.length - 1)];
          if (!fence) throw new Error('Missing synthetic privacy-fence snapshot');
          return fence;
        }
        if (collection === 'agents') return options.owner ?? snapshot(physicalId, { id: agentId });
        if (collection === 'recallSurfaces') {
          if (options.readError) throw new Error('storage failed');
          return snapshot(options.physicalId ?? physicalId, row);
        }
        throw new Error('Unexpected private source read');
      },
    };
  });
  // Only point reads exist: writes, transactions and private collections fail closed.
  const store = { doc } as unknown as InstallationStore;
  return { repo: new FirestoreRecallSurfacingRepository(store), reads, doc };
}
describe('offline Firestore source setting read with real codec and erasure fences', () => {
  it.each([
    [{}, { status: 'allowed' }],
    [{ suppressedAt: Timestamp.fromDate(date) }, { status: 'suppressed' }],
    [{ sourceRevision: 'c'.repeat(64) }, { status: 'stale' }],
    [{ sourceRevision: null }, { status: 'unavailable', reason: 'unversioned_legacy' }],
    [null, { status: 'unavailable', reason: 'missing_record' }],
  ])('returns only a validated privacy-completed state', async (row, expected) => {
    const s = setup(row);
    await expect(s.repo.readSourceSetting(input)).resolves.toEqual(expected);
    expect(s.reads).toEqual([
      `privacyErasureJobs/${documentKey(agentId)}`,
      `agents/${documentKey(agentId)}`,
      `recallSurfaces/${documentKey(surfaceId)}`,
      `privacyErasureJobs/${documentKey(agentId)}`,
    ]);
    expect(s.doc.mock.calls).toEqual([
      ['privacyErasureJobs', agentId],
      ['agents', agentId],
      ['recallSurfaces', surfaceId],
      ['privacyErasureJobs', agentId],
    ]);
  });
  it.each(malformed)('rejects malformed %s even when revision is stale', async (field, value) => {
    await expect(
      setup({ sourceRevision: 'c'.repeat(64), [field]: value }).repo.readSourceSetting(input),
    ).rejects.toThrow();
  });
  it('rejects missing suppression and nonnull suppression with a legacy revision', async () => {
    await expect(
      setup({ sourceRevision: null, suppressedAt: date }).repo.readSourceSetting(input),
    ).rejects.toThrow();
  });
  it.each([
    snapshot(documentKey(agentId), null),
    snapshot('wrong-physical-owner', { id: agentId }),
    snapshot(documentKey(agentId), { id: 'foreign' }),
  ])('requires an existing physically bound owner point read', async (owner) => {
    const s = setup({}, { owner });
    await expect(s.repo.readSourceSetting(input)).rejects.toThrow();
    expect(s.reads.some((path) => path.startsWith('recallSurfaces/'))).toBe(false);
  });
  it('rejects deterministic record or physical identity mismatch even if stale', async () => {
    await expect(
      setup({ id: 'other', sourceRevision: 'c'.repeat(64) }).repo.readSourceSetting(input),
    ).rejects.toThrow();
    await expect(
      setup({ sourceRevision: 'c'.repeat(64) }, { physicalId: 'wrong' }).repo.readSourceSetting(
        input,
      ),
    ).rejects.toThrow();
  });
  it.each([{}, null])(
    'rejects actual before/after generation changes including missing ledger',
    async (row) => {
      const before = snapshot(
        documentKey(agentId),
        { agentId, status: 'complete' },
        Timestamp.fromMillis(1000),
      );
      const after = snapshot(
        documentKey(agentId),
        { agentId, status: 'complete' },
        Timestamp.fromMillis(2000),
      );
      const absent = snapshot(documentKey(agentId), null);
      for (const fences of [
        [before, after],
        [absent, after],
        [before, absent],
      ]) {
        await expect(setup(row, { fences }).repo.readSourceSetting(input)).rejects.toThrow(
          'Privacy erasure changed',
        );
      }
    },
  );
  it.each(['active', undefined])('rejects active or malformed erasure state', async (status) => {
    const job = snapshot(documentKey(agentId), { agentId, status });
    await expect(setup(null, { fences: [job] }).repo.readSourceSetting(input)).rejects.toThrow();
  });
  it('propagates storage failure', async () => {
    await expect(setup({}, { readError: true }).repo.readSourceSetting(input)).rejects.toThrow(
      'storage failed',
    );
  });
});
