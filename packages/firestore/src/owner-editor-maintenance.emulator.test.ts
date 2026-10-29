/** Localhost emulator only; production operator entrypoint rejects emulator configuration. */
import { randomUUID } from 'node:crypto';
import { type DocumentReference, type DocumentSnapshot, Firestore } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerEditorEmulatorAuth } from './owner-editor-emulator-auth.js';
import { buildFirestoreOwnerEditorEpochRecord } from './owner-editor-epoch-record.js';
import {
  prepareOwnerEditorMaintenance,
  runOwnerEditorMaintenance,
} from './owner-editor-maintenance.js';
import { InstallationStore } from './store.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local emulator required');
const sha = 'a'.repeat(40);
const stamp = (doc: DocumentSnapshot) =>
  doc.updateTime ? [doc.updateTime.seconds, doc.updateTime.nanoseconds] : null;
describe.skipIf(!host)('V1 editor maintenance real localhost Firestore transactions', () => {
  let store: InstallationStore | undefined;
  let cleanup: DocumentReference[] = [];
  afterEach(async () => {
    if (store) {
      try {
        if (cleanup.length > 4) throw new Error('Test cleanup bound');
        const batch = store.db.batch();
        for (const ref of cleanup) batch.delete(ref);
        await batch.commit();
      } finally {
        await store.db.terminate();
        store = undefined;
        cleanup = [];
      }
    }
  });
  async function fixture(ready: boolean | null = null) {
    if (!host || process.env.FIRESTORE_EMULATOR_HOST !== host)
      throw new Error('Local emulator required');
    // Test-only transport: real SDK transactions live in a fresh demo project/test DB.
    // The logical maintenance scope is injected to exercise the fixed production packet parser;
    // this rehearsal does not prove the production client/identity/target binding.
    const db = new Firestore({
      projectId: `demo-editor-init-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      databaseId: `editor-init-${randomUUID().replaceAll('-', '').slice(0, 12)}-test`,
      host,
      ssl: false,
      universeDomain: 'googleapis.com',
      preferRest: true,
      authClient: ownerEditorEmulatorAuth(host),
    } as ConstructorParameters<typeof Firestore>[0]);
    store = new InstallationStore(
      db,
      `editor-init-test-${randomUUID()}`,
      undefined,
      'bmson-assistant',
      'assistant-production',
    );
    const ownerId = randomUUID(),
      name = `owner-editor-epoch:${ownerId}`,
      now = Date.now();
    cleanup = [
      store.doc('agents', ownerId),
      store.doc('maintenanceCursors', name),
      store.doc('privacyErasureJobs', ownerId),
    ];
    await store.doc('agents', ownerId).set({ id: ownerId });
    if (ready !== null)
      await store.doc('maintenanceCursors', name).set(
        buildFirestoreOwnerEditorEpochRecord({
          ownerId,
          epoch: randomUUID(),
          ready,
          privacyGeneration: null,
          updatedAt: new Date(),
        }),
      );
    const current = store;
    const prepare = (action: 'initialize' | 'disable' = 'initialize') =>
      prepareOwnerEditorMaintenance(current, { ownerId, action, releaseSha: sha, now });
    const run = (packet: unknown, mode: 'dry-run' | 'apply' = 'apply') =>
      runOwnerEditorMaintenance(current, packet, { mode, releaseSha: sha, now: Date.now });
    const approve = <T extends object>(packet: T) => ({
      ...packet,
      evidence: { recoverySha256: 'b'.repeat(64), drainSha256: 'c'.repeat(64) },
    });
    return { store: current, ownerId, name, prepare, run, approve };
  }
  it.each([null, false])(
    'dry-runs and initializes %s once with exact native CAS/replay',
    async (ready) => {
      const f = await fixture(ready),
        packet = f.approve(await f.prepare());
      const before = await f.store.doc('maintenanceCursors', f.name).get();
      await f.run(packet, 'dry-run');
      const afterDry = await f.store.doc('maintenanceCursors', f.name).get();
      expect(stamp(afterDry)).toEqual(stamp(before));
      await f.run(packet);
      const committed = await f.store.doc('maintenanceCursors', f.name).get();
      expect(JSON.parse(committed.get('cursor')).epoch).toBe(packet.proposedEpoch);
      expect(await f.run(packet)).toMatchObject({ outcome: 'already_applied', wrote: false });
      const replayed = await f.store.doc('maintenanceCursors', f.name).get();
      expect(stamp(replayed)).toEqual(stamp(committed));
      expect(Object.keys(replayed.data() ?? {}).sort()).toEqual(['cursor', 'name', 'updatedAt']);
    },
  );
  it('rejects a native document-version change after review even when the cursor is unchanged', async () => {
    const f = await fixture(false),
      packet = f.approve(await f.prepare());
    await f.store
      .doc('maintenanceCursors', f.name)
      .update({ updatedAt: new Date(Date.now() + 1000) });
    await expect(f.run(packet)).rejects.toThrow();
    expect(
      JSON.parse((await f.store.doc('maintenanceCursors', f.name).get()).get('cursor')).ready,
    ).toBe(false);
  });
  it('rejects active erasure and a newly added owner without modifying the epoch', async () => {
    const f = await fixture(),
      packet = f.approve(await f.prepare());
    await f.store
      .doc('privacyErasureJobs', f.ownerId)
      .set({ agentId: f.ownerId, status: 'running', generation: 'active' });
    await expect(f.run(packet)).rejects.toThrow();
    await f.store.doc('privacyErasureJobs', f.ownerId).delete();
    const other = randomUUID();
    cleanup.push(f.store.doc('agents', other));
    await f.store.doc('agents', other).set({ id: other });
    await expect(f.run(packet)).rejects.toThrow();
    expect((await f.store.doc('maintenanceCursors', f.name).get()).exists).toBe(false);
  });
  it('disables with a new stable epoch and replay leaves native updateTime unchanged', async () => {
    const f = await fixture(true),
      packet = f.approve(await f.prepare('disable'));
    await f.run(packet);
    const first = await f.store.doc('maintenanceCursors', f.name).get();
    expect(JSON.parse(first.get('cursor'))).toMatchObject({
      epoch: packet.proposedEpoch,
      ready: false,
    });
    await f.run(packet);
    expect(stamp(await f.store.doc('maintenanceCursors', f.name).get())).toEqual(stamp(first));
  });
  it('binds native completed-privacy timestamp precision and rejects subsequent replacement', async () => {
    const f = await fixture();
    const job = f.store.doc('privacyErasureJobs', f.ownerId);
    await job.set({ agentId: f.ownerId, status: 'complete', generation: 'one' });
    const packet = f.approve(await f.prepare());
    await f.run(packet);
    await job.update({ generation: 'two' });
    await expect(f.run(packet)).rejects.toThrow();
  });
});
