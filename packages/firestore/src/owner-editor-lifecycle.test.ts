import { randomUUID } from 'node:crypto';
import {
  type OwnerEditorScope,
  ownerEditorMaintenanceTargetEpochDigest,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  beginFirestoreOwnerEditorWrite,
  createFirestoreOwnerEditorOperationRepository,
  readFirestoreOwnerEditorIssuanceContext,
} from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';

function fixture(ready: boolean | null = true) {
  const f = ownerEditorTestStore(),
    ownerId = randomUUID(),
    epoch = randomUUID();
  f.seed('agents', ownerId, { id: ownerId });
  const name = `owner-editor-epoch:${ownerId}`;
  if (ready !== null)
    f.seed('maintenanceCursors', name, {
      name,
      cursor: JSON.stringify({
        ownerId,
        epoch,
        ready,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
  const erasure = new FirestorePrivacyErasureRepository(f.store, ownerId);
  const operations = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
  const now = Date.now();
  const scope: OwnerEditorScope = {
    ownerId,
    epoch,
    privacyGeneration: null,
    command: 'create_person',
    operationId: randomUUID(),
    targetId: null,
    sessionDigest: 'a'.repeat(64),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 600000,
  };
  // Exercise the real erasure entry transaction independently of unrelated domains.
  const begin = () =>
    (erasure as unknown as { begin(id: string): Promise<unknown> }).begin(ownerId);
  const contentErased = () =>
    f.seed('privacyErasureJobs', ownerId, {
      agentId: ownerId,
      generation: randomUUID(),
      status: 'content-erased',
      counts: {},
    });
  return { ...f, ownerId, epoch, name, scope, erasure, operations, begin, contentErased };
}

describe('editor actual Firestore erasure lifecycle with offline transactional storage', () => {
  it('clears the original maintenance binder when erasure rotates a disabled epoch', async () => {
    const f = fixture(false);
    f.seed('maintenanceCursors', f.name, {
      name: f.name,
      cursor: JSON.stringify({
        ownerId: f.ownerId,
        epoch: f.epoch,
        ready: false,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        maintenanceBinder: {
          version: 1,
          operationId: randomUUID(),
          requestDigest: 'd'.repeat(64),
          action: 'provision-disabled',
          targetEpochDigest: ownerEditorMaintenanceTargetEpochDigest(f.epoch),
        },
      }),
    });
    await f.begin();
    const rotated = JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor));
    expect(rotated.epoch).not.toBe(f.epoch);
    expect(rotated.ready).toBe(false);
    expect(rotated).not.toHaveProperty('maintenanceBinder');
  });
  it('retires issued handles at erasure entry and fences an already-held claim', async () => {
    const f = fixture();
    const reserved = await f.operations.reserve(f.scope, 'b'.repeat(64), new Date());
    expect(reserved.kind).toBe('claimed');
    if (reserved.kind !== 'claimed') throw new Error('Missing claim');
    await f.begin();
    expect(JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor)).epoch).not.toBe(f.epoch);
    await expect(
      f.store.db.runTransaction((tx) =>
        beginFirestoreOwnerEditorWrite(f.store, tx, reserved.claim, new Date()),
      ),
    ).rejects.toThrow('privacy');
    expect(f.rows('contacts')).toEqual([]);
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it('recovers a completion crash gap without authorizing stale work or rotating again on retry', async () => {
    const f = fixture();
    await f.begin();
    f.contentErased();
    f.stats.failEpoch = true;
    await expect(f.erasure.complete()).rejects.toThrow('Injected epoch');
    expect(f.rows('privacyErasureJobs')[0]?.status).toBe('complete');
    expect(await readFirestoreOwnerEditorIssuanceContext(f.store, f.ownerId)).toBeNull();
    f.stats.failEpoch = false;
    await f.erasure.complete();
    const context = await readFirestoreOwnerEditorIssuanceContext(f.store, f.ownerId);
    expect(context?.epoch).not.toBe(f.epoch);
    expect(context?.privacyGeneration).toContain('nanoseconds');
    expect((await f.operations.lookup(f.scope, new Date())).reply.authority).toBe(
      'scope_retirement',
    );
    await f.erasure.complete();
    expect(await readFirestoreOwnerEditorIssuanceContext(f.store, f.ownerId)).toEqual(context);
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it.each([false, null])('does not enable or create a previously %s editor', async (ready) => {
    const f = fixture(ready);
    await f.begin();
    f.contentErased();
    await f.erasure.complete();
    expect(await readFirestoreOwnerEditorIssuanceContext(f.store, f.ownerId)).toBeNull();
    if (ready === null) expect(f.rows('maintenanceCursors')).toEqual([]);
    else expect(JSON.parse(String(f.rows('maintenanceCursors')[0]?.cursor)).ready).toBe(false);
  });
  it('rolls back erasure entry if existing epoch metadata belongs to another owner', async () => {
    const f = fixture();
    f.seed('maintenanceCursors', f.name, {
      name: f.name,
      cursor: JSON.stringify({
        ownerId: randomUUID(),
        epoch: f.epoch,
        ready: true,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
    await expect(f.begin()).rejects.toThrow('owner mismatch');
    expect(f.rows('privacyErasureJobs')).toEqual([]);
    expect(f.rows('ownerCards')).toEqual([]);
  });
});
