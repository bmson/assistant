import { randomUUID } from 'node:crypto';
import { ownerEditorPrivacyDigest } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { buildFirestoreOwnerEditorEpochRecord } from './owner-editor-epoch-record.js';
import {
  parseOwnerEditorMaintenancePacket,
  prepareOwnerEditorMaintenance,
  runOwnerEditorMaintenance,
} from './owner-editor-maintenance.js';
import { rotateFirestoreOwnerEditorEpoch } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';

const sha = 'a'.repeat(40),
  now = Date.now();
function fixture(ready: boolean | null = null) {
  const f = ownerEditorTestStore(),
    ownerId = randomUUID(),
    name = `owner-editor-epoch:${ownerId}`;
  Object.assign(f.store, {
    projectId: 'bmson-assistant',
    databaseId: 'assistant-production',
    installationId: 'private-installation',
  });
  f.seed('agents', ownerId, { id: ownerId, privatePreference: 'must-not-read-content' });
  if (ready !== null)
    f.seed(
      'maintenanceCursors',
      name,
      buildFirestoreOwnerEditorEpochRecord({
        ownerId,
        epoch: randomUUID(),
        ready,
        privacyGeneration: null,
        updatedAt: new Date(now),
      }),
    );
  const prepare = (action: 'initialize' | 'disable' = 'initialize') =>
    prepareOwnerEditorMaintenance(f.store, { ownerId, action, releaseSha: sha, now });
  const run = (packet: unknown, mode: 'dry-run' | 'apply' = 'apply', at = now) =>
    runOwnerEditorMaintenance(f.store, packet, { mode, releaseSha: sha, now: () => at });
  const approve = <T extends object>(packet: T) => ({
    ...packet,
    evidence: { recoverySha256: 'b'.repeat(64), drainSha256: 'c'.repeat(64) },
  });
  return { ...f, ownerId, name, prepare, run, approve };
}
describe('operator V1 epoch initializer using offline transactional repository', () => {
  it.each([null, false])(
    'prepares and dry-runs %s without a write; applies once then replays without rotation',
    async (ready) => {
      const f = fixture(ready),
        packet = f.approve(await f.prepare());
      expect(f.stats.writes).toEqual([]);
      expect(await f.run(packet, 'dry-run')).toMatchObject({
        outcome: 'would_apply',
        wrote: false,
      });
      expect(f.stats.writes).toEqual([]);
      expect(await f.run(packet)).toEqual({ outcome: 'applied', wrote: true });
      const row = f.rows('maintenanceCursors')[0],
        state = JSON.parse(String(row?.cursor));
      expect(state).toEqual({
        ownerId: f.ownerId,
        epoch: packet.proposedEpoch,
        ready: true,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      });
      expect(Object.keys(row ?? {}).sort()).toEqual(['cursor', 'name', 'updatedAt']);
      expect(await f.run(packet)).toEqual({ outcome: 'already_applied', wrote: false });
      expect(f.stats.writes).toEqual(['maintenanceCursors']);
      expect(f.stats.readsAfterWrites).toBe(0);
      expect(f.stats.unboundedQueries).toEqual([]);
    },
  );
  it('requires reviewed evidence to write but permits inspection/dry-run first', async () => {
    const f = fixture(),
      packet = await f.prepare();
    await expect(f.run(packet)).rejects.toThrow();
    expect(await f.run(packet, 'dry-run')).toMatchObject({ outcome: 'would_apply' });
    expect(f.stats.writes).toEqual([]);
  });
  it('rejects preparing unexpected READY initialization or missing disable state', async () => {
    await expect(fixture(true).prepare()).rejects.toThrow();
    await expect(fixture().prepare('disable')).rejects.toThrow();
    await expect(fixture(false).prepare('disable')).rejects.toThrow();
  });
  it('disables with a distinct stable epoch and never restores old authority', async () => {
    const f = fixture(true),
      previous = String(f.rows('maintenanceCursors')[0]?.cursor);
    const packet = f.approve(await f.prepare('disable'));
    await f.run(packet);
    const state = JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor));
    expect(state.ready).toBe(false);
    expect(state.epoch).toBe(packet.proposedEpoch);
    expect(state.epoch).not.toBe(JSON.parse(previous).epoch);
    expect(await f.run(packet)).toMatchObject({ outcome: 'already_applied', wrote: false });
    expect(f.stats.writes).toEqual(['maintenanceCursors']);
  });
  it.each(['owner', 'epoch', 'privacy', 'active-privacy'])(
    'rejects changed %s before apply without changing user data',
    async (changed) => {
      const f = fixture(false),
        packet = f.approve(await f.prepare());
      if (changed === 'owner') f.seed('agents', f.ownerId, { id: f.ownerId });
      else if (changed === 'epoch')
        f.seed(
          'maintenanceCursors',
          f.name,
          buildFirestoreOwnerEditorEpochRecord({
            ownerId: f.ownerId,
            epoch: randomUUID(),
            ready: false,
            privacyGeneration: null,
            updatedAt: new Date(now),
          }),
        );
      else
        f.seed('privacyErasureJobs', f.ownerId, {
          agentId: f.ownerId,
          generation: randomUUID(),
          status: changed === 'privacy' ? 'complete' : 'running',
        });
      await expect(f.run(packet)).rejects.toThrow();
      expect(f.stats.writes).toEqual([]);
      for (const table of ['contacts', 'memories', 'familyRelationships', 'ownerEditorOperations'])
        expect(f.rows(table)).toEqual([]);
    },
  );
  it('replay after commit still rejects changed privacy instead of rebinding', async () => {
    const f = fixture(),
      packet = f.approve(await f.prepare());
    await f.run(packet);
    f.seed('privacyErasureJobs', f.ownerId, {
      agentId: f.ownerId,
      generation: 'new',
      status: 'complete',
    });
    await expect(f.run(packet)).rejects.toThrow();
    expect(f.stats.writes).toEqual(['maintenanceCursors']);
  });
  it('binds a completed privacy generation with native timestamp precision', async () => {
    const f = fixture();
    f.seed('privacyErasureJobs', f.ownerId, {
      agentId: f.ownerId,
      generation: 'completed',
      status: 'complete',
    });
    const packet = f.approve(await f.prepare());
    expect(packet.expectedPrivacyDigest).not.toBe(ownerEditorPrivacyDigest(null));
    await f.run(packet);
    expect(
      JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor)).privacyGenerationDigest,
    ).toBe(packet.expectedPrivacyDigest);
  });
  it('aborts before commit and succeeds with the same packet after retry', async () => {
    const f = fixture(),
      packet = f.approve(await f.prepare());
    f.stats.failEpoch = true;
    await expect(f.run(packet)).rejects.toThrow('Injected');
    expect(f.rows('maintenanceCursors')).toEqual([]);
    f.stats.failEpoch = false;
    await f.run(packet);
    expect(JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor)).epoch).toBe(
      packet.proposedEpoch,
    );
  });
  it('rejects expired/future/wrong-source/wrong-target/unknown-fields packets', async () => {
    const f = fixture(),
      packet = f.approve(await f.prepare());
    await expect(f.run(packet, 'apply', packet.expiresAt)).rejects.toThrow();
    await expect(f.run(packet, 'apply', packet.issuedAt - 1)).rejects.toThrow();
    await expect(f.run({ ...packet, releaseSha: 'd'.repeat(40) })).rejects.toThrow();
    await expect(
      f.run({ ...packet, target: { ...packet.target, installationId: 'other' } }),
    ).rejects.toThrow();
    for (const change of [
      { extra: true },
      { expiresAt: now + 1800001 },
      { proposedEpoch: 'bad' },
      { privacyBinding: 'unknown' },
      { evidence: { arbitrary: true } },
    ])
      expect(() => parseOwnerEditorMaintenancePacket({ ...packet, ...change })).toThrow();
    await expect(
      f.run({
        ...packet,
        expectedOwnerVersion: packet.expectedOwnerVersion.replace(/:[0-9]+$/, ':999999999'),
      }),
    ).rejects.toThrow();
    expect(f.stats.writes).toEqual([]);
  });
  it('preserves ordinary random rotation and the existing record shape', async () => {
    const f = fixture();
    const first = await rotateFirestoreOwnerEditorEpoch(f.store, f.ownerId, false);
    const second = await rotateFirestoreOwnerEditorEpoch(f.store, f.ownerId, false);
    expect(first).not.toBe(second);
    expect(JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor)).epoch).toBe(second);
  });
});
