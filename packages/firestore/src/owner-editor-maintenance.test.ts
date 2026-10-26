import { randomUUID } from 'node:crypto';
import { ownerEditorEpochStateDigest, ownerEditorPrivacyDigest } from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import {
  inspectFirestoreOwnerEditorMaintenanceState,
  type OwnerEditorMaintenanceInspection,
  type OwnerEditorMaintenanceRequest,
  rotateFirestoreOwnerEditorEpochForMaintenance,
} from './owner-editor-maintenance.js';
import { rotateFirestoreOwnerEditorEpoch } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';

function fixture() {
  const f = ownerEditorTestStore();
  const ownerId = randomUUID();
  const target = {
    projectId: 'demo-maintenance-test',
    databaseId: 'fixture',
    installationId: 'fixture',
  };
  Object.assign(f.store, target);
  f.seed('agents', ownerId, { id: ownerId });
  const marker = {
    status: 'active',
    sourceAgentId: ownerId,
    target,
    formatVersion: 3,
    bundleChecksum: 'a'.repeat(64),
    completedWrites: 2,
    totalWrites: 2,
    activation: {
      sourceWriteFenceId: 'fixture-fence',
      sourceWritesDrainedAt: new Date('2026-10-26T12:00:00Z'),
      snapshotUri: 'gs://fixture/checkpoint',
      snapshotGeneration: '123',
      snapshotSha256: 'b'.repeat(64),
    },
  };
  f.seed('coordination', 'migration', marker);
  const inspect = () => inspectFirestoreOwnerEditorMaintenanceState(f.store, ownerId);
  const request = (
    action: OwnerEditorMaintenanceRequest['action'],
    original: OwnerEditorMaintenanceInspection,
    overrides: Partial<OwnerEditorMaintenanceRequest> = {},
  ): OwnerEditorMaintenanceRequest => ({
    ownerId,
    operationId: randomUUID(),
    requestDigest: 'c'.repeat(64),
    action,
    targetEpoch: randomUUID(),
    expectedEpochStateDigestOrAbsent: original.cursor
      ? ownerEditorEpochStateDigest(original.cursor)
      : null,
    expectedEpochNativeVersionOrAbsent: original.epochNativeVersion,
    expectedOwnerNativeVersion: original.ownerNativeVersion,
    expectedPrivacyDigest: ownerEditorPrivacyDigest(original.privacyGeneration),
    expectedLineageDigest: original.lineageDigest,
    expectedLineageNativeVersion: original.lineageNativeVersion,
    ...overrides,
  });
  const rotate = (value: OwnerEditorMaintenanceRequest) =>
    rotateFirestoreOwnerEditorEpochForMaintenance(f.store, value);
  return { ...f, ownerId, marker, inspect, request, rotate };
}

describe('fixed maintenance native preconditions with offline transactional storage', () => {
  it('inspects without writes or authority, provisions disabled, and enables the exact observed epoch', async () => {
    const f = fixture();
    const absent = await f.inspect();
    expect(absent.cursor).toBeNull();
    expect(f.stats.writes).toEqual([]);
    const disabled = await f.rotate(f.request('provision-disabled', absent));
    expect(disabled.cursor.ready).toBe(false);
    const original = await f.inspect();
    const enable = f.request('enable', original);
    const saved = await f.rotate(enable);
    expect(saved.cursor).toMatchObject({ epoch: enable.targetEpoch, ready: true });
    expect(await f.rotate(enable)).toEqual({ ...saved, status: 'replayed' });
    expect(f.stats.writes).toEqual(['maintenanceCursors', 'maintenanceCursors']);
    expect(f.stats.readsAfterWrites).toBe(0);
  });

  it('does not accept restored identical logical state at a different native updateTime', async () => {
    const f = fixture();
    await f.rotate(f.request('provision-disabled', await f.inspect()));
    const original = await f.inspect();
    const request = f.request('enable', original);
    const name = `owner-editor-epoch:${f.ownerId}`;
    f.seed('maintenanceCursors', name, { name, cursor: JSON.stringify(original.cursor) });
    expect((await f.inspect()).cursor).toEqual(original.cursor);
    await expect(f.rotate(request)).rejects.toThrow('original epoch observation');
    expect(f.stats.writes).toHaveLength(1);
  });

  it('rejects a second request bound to the same original absent observation', async () => {
    const f = fixture();
    const original = await f.inspect();
    const first = f.request('provision-disabled', original);
    const second = f.request('provision-disabled', original);
    await f.rotate(first);
    await expect(f.rotate(second)).rejects.toThrow('original epoch observation');
    expect((await f.inspect()).cursor?.epoch).toBe(first.targetEpoch);
    expect(f.stats.writes).toEqual(['maintenanceCursors']);
  });

  it('resolves an exact lost commit reply without a second rotation or comparing its old pre-write version', async () => {
    const f = fixture();
    const request = f.request('provision-disabled', await f.inspect());
    const db = f.store.db as unknown as {
      runTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T>;
    };
    const original = db.runTransaction.bind(db);
    let loseReply = true;
    db.runTransaction = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> => {
      const result = await original(run);
      if (loseReply) {
        loseReply = false;
        throw new Error('fixture lost commit reply');
      }
      return result;
    };
    await expect(f.rotate(request)).rejects.toThrow('lost commit reply');
    const replay = await f.rotate(request);
    expect(replay.status).toBe('replayed');
    expect(replay.cursor.epoch).toBe(request.targetEpoch);
    expect(f.stats.writes).toEqual(['maintenanceCursors']);
  });

  it('reuses the caller-selected target across discarded native transaction callbacks', async () => {
    const f = fixture();
    const request = f.request('provision-disabled', await f.inspect());
    const db = f.store.db as unknown as {
      runTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T>;
    };
    const original = db.runTransaction.bind(db);
    const observed: string[] = [];
    db.runTransaction = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> => {
      await expect(
        original(async (tx) => {
          const result = (await run(tx)) as { cursor: { epoch: string } };
          observed.push(result.cursor.epoch);
          throw new Error('discard callback');
        }),
      ).rejects.toThrow('discard callback');
      return original(async (tx) => {
        const result = (await run(tx)) as T & { cursor: { epoch: string } };
        observed.push(result.cursor.epoch);
        return result;
      });
    };
    await f.rotate(request);
    expect(observed).toEqual([request.targetEpoch, request.targetEpoch]);
    expect(f.stats.writes).toEqual(['maintenanceCursors']);
  });

  it('does not mistake a same operation with another target/action/request for a replay', async () => {
    const f = fixture();
    const request = f.request('provision-disabled', await f.inspect());
    await f.rotate(request);
    for (const changed of [
      { targetEpoch: randomUUID() },
      { action: 'disable' as const },
      { requestDigest: 'd'.repeat(64) },
    ])
      await expect(f.rotate({ ...request, ...changed })).rejects.toThrow(
        'original operation binding',
      );
    expect(f.stats.writes).toEqual(['maintenanceCursors']);
  });

  it('checks original physical owner and lineage before any replay authorization', async () => {
    for (const changed of ['owner', 'lineage']) {
      const f = fixture();
      const request = f.request('provision-disabled', await f.inspect());
      await f.rotate(request);
      if (changed === 'owner') f.seed('agents', f.ownerId, { id: f.ownerId });
      else f.seed('coordination', 'migration', f.marker);
      await expect(f.rotate(request)).rejects.toThrow('owner, privacy or installation lineage');
      expect(f.stats.writes).toEqual(['maintenanceCursors']);
    }
  });

  it('fails closed on active privacy erasure and does not write another epoch', async () => {
    const f = fixture();
    const request = f.request('provision-disabled', await f.inspect());
    f.seed('privacyErasureJobs', f.ownerId, {
      agentId: f.ownerId,
      generation: randomUUID(),
      status: 'active',
    });
    await expect(f.rotate(request)).rejects.toThrow('privacy');
    expect(f.stats.writes).toEqual([]);
  });

  it('requires full active lineage, physical owner/target, and historical activation fields', async () => {
    for (const mutation of [
      { status: 'pending_activation' },
      { status: 'importing' },
      { formatVersion: 4 },
      { completedWrites: 1 },
      { activation: null },
      { activation: { ...fixture().marker.activation, snapshotSha256: 'malformed' } },
      { target: { projectId: 'another', databaseId: 'fixture', installationId: 'fixture' } },
    ]) {
      const f = fixture();
      f.seed('coordination', 'migration', { ...f.marker, ...mutation });
      await expect(f.inspect()).rejects.toThrow();
      expect(f.stats.writes).toEqual([]);
    }
    const f = fixture();
    f.remove('coordination', 'migration');
    await expect(f.inspect()).rejects.toThrow('lineage');
    expect(f.stats.writes).toEqual([]);
  });

  it('does not authorize a missing or already enabled epoch, or reuse the original epoch UUID', async () => {
    const f = fixture();
    await expect(f.rotate(f.request('enable', await f.inspect()))).rejects.toThrow('transition');
    await f.rotate(f.request('provision-disabled', await f.inspect()));
    const disabled = await f.inspect();
    if (!disabled.cursor) throw new Error('Expected disabled epoch');
    await expect(
      f.rotate(f.request('enable', disabled, { targetEpoch: disabled.cursor.epoch })),
    ).rejects.toThrow('transition');
    await f.rotate(f.request('enable', disabled));
    await expect(f.rotate(f.request('enable', await f.inspect()))).rejects.toThrow('transition');
  });

  it('clears the maintenance binder on unrelated rotation and cannot reinterpret that as original success', async () => {
    const f = fixture();
    const request = f.request('provision-disabled', await f.inspect());
    await f.rotate(request);
    await rotateFirestoreOwnerEditorEpoch(f.store, f.ownerId, false);
    expect((await f.inspect()).cursor?.maintenanceBinder).toBeUndefined();
    await expect(f.rotate(request)).rejects.toThrow('original epoch observation');
    expect(f.stats.writes).toHaveLength(2);
  });
});
