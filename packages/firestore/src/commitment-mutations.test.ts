import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreCommitmentMutationRepository } from './commitment-mutations.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('commitment correction history bound', () => {
  let store: InstallationStore;
  let owner: string;
  let target: string;
  let repository: FirestoreCommitmentMutationRepository;
  const hash = (title: string) =>
    createHash('sha256').update(`promise\n${title.toLowerCase()}\n`).digest('hex');
  beforeEach(async () => {
    store = emulatorStore();
    owner = randomUUID();
    target = randomUUID();
    repository = new FirestoreCommitmentMutationRepository(store, owner);
    await store.doc('agents', owner).set({ id: owner });
    await put(target, 'open', 'Other title');
    for (let i = 0; i < 11; i += 1) await put(`closed-${i}`, 'dismissed');
  });
  afterEach(async () => disposeStore(store));
  async function put(id: string, status: string, title = 'Send forms') {
    await store.doc('commitments', id).set(
      encodeRecord({
        id,
        agentId: owner,
        kind: 'promise',
        title,
        details: '',
        nextAction: '',
        status,
        snoozedUntil: null,
        resolvedAt: status === 'dismissed' || status === 'resolved' ? new Date() : null,
        reopenedFromId: null,
        reopenOperationId: null,
        resolution: null,
        confidence: '1.00',
        contentHash: hash(title),
        updatedAt: new Date(),
      }),
    );
  }
  it('ignores closed history but rejects an active twin beyond eleven closed rows', async () => {
    await put('zz-active', 'open');
    await expect(
      repository.correct(target, { title: 'Send forms', details: '', nextAction: '' }),
    ).rejects.toThrow('matching active commitment');
    expect((await store.doc('commitments', target).get()).get('title')).toBe('Other title');
  });
  it('allows a correction with eleven closed twins and preserves their closure', async () => {
    expect(
      await repository.correct(target, { title: 'Send forms', details: '', nextAction: '' }),
    ).toBe(true);
    const rows = await store.collection('commitments').get();
    expect(rows.docs.filter((doc) => doc.get('status') === 'dismissed')).toHaveLength(11);
  });

  it('reopens as a linked occurrence, replays idempotently, and allows a later explicit reopen', async () => {
    await put('closed-for-reopen', 'resolved');
    const originalRef = store.doc('commitments', 'closed-for-reopen');
    await originalRef.update({
      resolvedAt: new Date(),
      resolution: 'Finished',
      updatedAt: new Date(),
    });
    const original = await originalRef.get();
    const originalUpdatedAt = original.get('updatedAt').toDate();
    const operationId = '6a5e6202-8d62-4f93-a550-8026ed2dd657';
    const first = await repository.reopen('closed-for-reopen', originalUpdatedAt, operationId);
    expect(first?.replay).toBe(false);
    if (!first) throw new Error('explicit reopen was rejected');
    expect(await repository.reopen('closed-for-reopen', originalUpdatedAt, operationId)).toEqual({
      commitmentId: first.commitmentId,
      replay: true,
    });
    expect(
      await repository.reopen('closed-for-reopen', originalUpdatedAt, randomUUID()),
    ).toBeNull();
    const closedStill = await originalRef.get();
    expect(closedStill.data()).toMatchObject({
      status: 'resolved',
      resolution: 'Finished',
      reopenedFromId: null,
      reopenOperationId: null,
    });
    const childRef = store.doc('commitments', first.commitmentId);
    expect((await childRef.get()).data()).toMatchObject({
      status: 'open',
      reopenedFromId: 'closed-for-reopen',
      reopenOperationId: operationId,
      sourceOccurrenceKey: `manual-reopen:v1:${owner}:${operationId}`,
    });
    expect(await repository.resolve(first.commitmentId, 'Closed again')).toBe(true);
    const closedChild = await childRef.get();
    const second = await repository.reopen(
      first.commitmentId,
      closedChild.get('updatedAt').toDate(),
      'd851f9ce-c089-46f5-aa7e-ef67e60bf811',
    );
    expect(second?.replay).toBe(false);
    expect(
      (await store.doc('commitments', second?.commitmentId ?? '').get()).get('reopenedFromId'),
    ).toBe(first.commitmentId);
  });

  it('rejects stale, foreign, erasure-fenced, and already-open copies', async () => {
    await put('closed-stale', 'dismissed');
    const closedRef = store.doc('commitments', 'closed-stale');
    const closed = await closedRef.get();
    const timestamp = closed.get('updatedAt').toDate();
    expect(
      await repository.reopen('closed-stale', new Date(timestamp.getTime() - 1), randomUUID()),
    ).toBeNull();
    expect(await repository.reopen('missing-foreign', timestamp, randomUUID())).toBeNull();
    await put('open-copy', 'open');
    expect(await repository.reopen('closed-stale', timestamp, randomUUID())).toBeNull();
    await store.doc('privacyErasureJobs', owner).set({ agentId: owner, status: 'active' });
    await expect(repository.reopen('closed-stale', timestamp, randomUUID())).rejects.toThrow(
      'Privacy erasure is in progress',
    );
  });

  it('allows only one child when different operation ids race on the same closed source', async () => {
    await put('closed-race', 'dismissed');
    const ref = store.doc('commitments', 'closed-race');
    const closed = await ref.get();
    const updatedAt = closed.get('updatedAt').toDate();
    const attempts = await Promise.all([
      repository.reopen('closed-race', updatedAt, 'f317df62-3972-45b7-a26d-0d9eb6075202'),
      repository.reopen('closed-race', updatedAt, '8b27c643-195a-4d3e-9bde-f97fc565531d'),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const children = await store
      .collection('commitments')
      .where('agentId', '==', owner)
      .where('reopenedFromId', '==', 'closed-race')
      .get();
    expect(children.size).toBe(1);
  });
  it.each(['resolve', 'dismiss', 'snooze', 'correct'] as const)(
    'allows owner %s on unresolved legacy stale work',
    async (action) => {
      await put(target, 'stale', 'Other title');
      const result =
        action === 'resolve'
          ? await repository.resolve(target, 'Finished')
          : action === 'dismiss'
            ? await repository.dismiss(target)
            : action === 'snooze'
              ? await repository.snooze(target, new Date(Date.now() + 60_000))
              : await repository.correct(target, {
                  title: 'New title',
                  details: '',
                  nextAction: '',
                });
      expect(result).toBe(true);
    },
  );
});
