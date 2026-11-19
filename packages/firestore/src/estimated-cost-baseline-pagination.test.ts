import {
  type EstimatedCostBaselineContext,
  estimatedCostBaselineCensusDigest,
} from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { inspectFirestoreEstimatedCostBaseline } from './estimated-cost-baseline-provision.js';
import { documentKey, type InstallationStore } from './store.js';

const time = new Timestamp(100, 0);
const owner = 'owner';
const context: EstimatedCostBaselineContext = {
  ownerId: owner,
  target: {
    driver: 'firestore',
    projectId: 'test',
    databaseId: '(default)',
    installationId: 'install',
  },
  releaseSha: 'a'.repeat(40),
  now: () => new Date(200000),
};
function doc(id: string, data: Record<string, unknown>) {
  return {
    id: documentKey(id),
    exists: true,
    createTime: time,
    updateTime: time,
    get: (key: string) => data[key],
  };
}
function fixture(count: number) {
  const reservations = Array.from({ length: count }, (_, i) => {
    const id = `reservation-${String(i).padStart(6, '0')}`;
    return doc(id, { id, status: 'reconciled', estimatedUsd: '0.000001' });
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  // Firestore document-ID ordering is bytewise, not locale ordering.
  reservations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const grants: ReturnType<typeof doc>[] = [];
  let queryCount = 0;
  function collection(name: string) {
    const rows =
      name === 'agents'
        ? [doc(owner, { id: owner })]
        : name === 'costReservations'
          ? reservations
          : grants;
    const query = (after = '', limit = 1000) => ({
      select: () => query(after, limit),
      orderBy: () => query(after, limit),
      limit: (n: number) => query(after, n),
      startAfter: (snapshot: ReturnType<typeof doc>) => query(snapshot.id, limit),
      read: () => {
        queryCount++;
        const docs = rows.filter((row) => row.id > after).slice(0, limit);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    });
    return query();
  }
  const tx = { get: async (ref: { read: () => unknown }) => ref.read() };
  const store = {
    projectId: 'test',
    databaseId: '(default)',
    installationId: 'install',
    collection,
    doc: (name: string) => ({
      read: () =>
        name === 'privacyErasureJobs' ? { exists: false } : doc('holds', { heldMicros: 0 }),
    }),
    db: { runTransaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx) },
  } as unknown as InstallationStore;
  return { store, reservations, grants, queries: () => queryCount };
}

describe('bounded baseline census pagination', () => {
  it('reads all 24,258 reservations in one transaction and preserves canonical digest', async () => {
    const f = fixture(24258);
    const { census, censusDigest } = await inspectFirestoreEstimatedCostBaseline(f.store, context);
    expect(census.reservations).toHaveLength(24258);
    expect(new Set(census.reservations.map((row) => row.reservationId)).size).toBe(24258);
    expect(censusDigest).toBe(estimatedCostBaselineCensusDigest(census));
    expect(f.queries()).toBe(28); // owner, 25 reservation pages plus empty page, empty grants
  });
  it('keeps the original small census shape and digest', async () => {
    const f = fixture(2);
    const { census, censusDigest } = await inspectFirestoreEstimatedCostBaseline(f.store, context);
    const expected = {
      ownerVersion: '100:0',
      privacyGeneration: null,
      heldMicros: 0,
      ledgerVersion: '100:0',
      grants: [],
      reservations: [0, 1].map((i) => ({
        reservationId: `reservation-${String(i).padStart(6, '0')}`,
        status: 'reconciled',
        estimatedMicros: 1,
        reservationKind: 'attempt',
        grantId: null,
        createdMicros: '100000000',
        version: '100:0',
      })),
    };
    expect(census).toEqual(expected);
    expect(censusDigest).toBe(estimatedCostBaselineCensusDigest(expected));
  });
  it.each(['held', 'dispatching', 'invalid'])(
    'rejects %s reservation on a later page',
    async (status) => {
      const f = fixture(1001);
      const old = f.reservations[1000];
      if (!old) throw new Error('Missing fixture');
      f.reservations[1000] = {
        ...old,
        get: (key: string) => (key === 'status' ? status : old.get(key)),
      };
      await expect(inspectFirestoreEstimatedCostBaseline(f.store, context)).rejects.toThrow(
        status === 'invalid' ? 'Malformed reservation' : 'Active reservation',
      );
    },
  );
  it('rejects an active grant on a later page', async () => {
    const f = fixture(0);
    for (let i = 0; i < 1001; i++) {
      const id = `grant-${String(i).padStart(6, '0')}`;
      f.grants.push(doc(id, { id, expiresAt: new Timestamp(i === 1000 ? 300 : 100, 0) }));
    }
    f.grants.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Put active authority at the end in document order.
    const old = f.grants[1000];
    if (!old) throw new Error('Missing fixture');
    f.grants[1000] = {
      ...old,
      get: (key: string) => (key === 'expiresAt' ? new Timestamp(300, 0) : old.get(key)),
    };
    await expect(inspectFirestoreEstimatedCostBaseline(f.store, context)).rejects.toThrow(
      'Active grant',
    );
  });
  it('includes unknown liability from a later page in ledger reconciliation', async () => {
    const f = fixture(1001);
    const old = f.reservations[1000];
    if (!old) throw new Error('Missing fixture');
    f.reservations[1000] = {
      ...old,
      get: (key: string) => (key === 'status' ? 'unknown' : old.get(key)),
    };
    await expect(inspectFirestoreEstimatedCostBaseline(f.store, context)).rejects.toThrow(
      'Incomplete liability census',
    );
  });
  it('fails closed above the 100,000 document ceiling', async () => {
    const f = fixture(100001);
    await expect(inspectFirestoreEstimatedCostBaseline(f.store, context)).rejects.toThrow(
      'Baseline census exceeds limit',
    );
  });
});
