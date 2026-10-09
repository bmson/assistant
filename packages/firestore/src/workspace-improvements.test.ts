import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreWorkspaceImprovementRepository } from './workspace-improvements.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile workspace improvements',
  () => {
    let store: InstallationStore;
    let repository: FirestoreWorkspaceImprovementRepository;
    const agentId = randomUUID();

    beforeEach(() => {
      store = emulatorStore();
      repository = new FirestoreWorkspaceImprovementRepository(store);
    });
    afterEach(async () => disposeStore(store));

    async function seed(id: string, patch: Record<string, unknown> = {}, documentId = id) {
      await store.doc('improvementProposals', documentId).set({
        id,
        agentId,
        status: 'open',
        kind: 'model_role',
        title: 'Change draft model',
        rationale: 'Retries cost too much',
        change: { suggestion: 'Choose another model' },
        evidenceIds: ['task-one'],
        createdAt: new Date('2026-09-01T00:00:00Z'),
        ...patch,
      });
    }

    it('returns newest 100 open owner proposals without foreign or dismissed rows', async () => {
      const batch = store.db.batch();
      for (let index = 0; index < 105; index++) {
        const id = `proposal-${String(index).padStart(3, '0')}`;
        batch.set(store.doc('improvementProposals', id), {
          id,
          agentId,
          status: 'open',
          kind: 'model_role',
          title: 'Change draft model',
          rationale: 'Retries cost too much',
          change: { suggestion: 'Choose another model' },
          evidenceIds: ['task-one'],
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
        });
      }
      batch.set(store.doc('improvementProposals', 'foreign'), {
        id: 'foreign',
        agentId: 'another-owner',
        status: 'open',
        kind: 'note',
        title: 'Foreign',
        rationale: '',
        change: {},
        evidenceIds: [],
        createdAt: new Date('2026-12-01'),
      });
      await batch.commit();
      await seed('dismissed', { status: 'dismissed', createdAt: new Date('2026-12-01') });

      const rows = await repository.listOpen(agentId);
      expect(rows).toHaveLength(100);
      expect(rows[0]?.id).toBe('proposal-104');
      expect(rows.at(-1)?.id).toBe('proposal-005');
      expect((await repository.listOpen('another-owner')).map((row) => row.id)).toEqual([
        'foreign',
      ]);
    });

    it('paginates open proposals without repeating rows or admitting another owner', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
      await Promise.all([
        ...ids.map((id) => seed(id)),
        store.doc('improvementProposals', randomUUID()).set({
          id: randomUUID(),
          agentId: randomUUID(),
          status: 'open',
          kind: 'note',
          title: 'Foreign',
          rationale: '',
          change: {},
          evidenceIds: [],
          createdAt: new Date(),
        }),
      ]);
      const collected: string[] = [];
      let afterId: string | undefined;
      do {
        const page = await repository.listOpenPage(agentId, { afterId, limit: 2 });
        collected.push(...page.items.map((row) => row.id));
        afterId = page.nextCursor ?? undefined;
        expect(page.hasMore).toBe(Boolean(afterId));
      } while (afterId);
      expect(collected).toEqual(ids);
      expect(new Set(collected).size).toBe(ids.length);
    });

    it('fails closed on malformed records and active privacy erasure', async () => {
      await seed('wrong-id', {}, 'different-document');
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Invalid owner improvement document',
      );
      await store.doc('improvementProposals', 'different-document').delete();
      await seed('bad-evidence', { evidenceIds: [42] });
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Invalid open improvement document',
      );
      await store.doc('improvementProposals', 'bad-evidence').delete();
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.listOpen(agentId)).rejects.toThrow('Privacy erasure is in progress');
    });

    it('acknowledges portable advisory proposals and makes dismissal idempotent', async () => {
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
      await seed('advisory', { kind: 'note', evidenceIds: [] });
      expect(await repository.applyAction(agentId, 'advisory', 'apply')).toMatchObject({
        outcome: 'acknowledged',
        enacted: false,
      });
      expect((await store.doc('improvementProposals', 'advisory').get()).get('status')).toBe(
        'applied',
      );

      await seed('dismiss-me', { kind: 'prompt' });
      await repository.applyAction(agentId, 'dismiss-me', 'dismiss');
      await repository.applyAction(agentId, 'dismiss-me', 'dismiss');
      expect((await store.doc('improvementProposals', 'dismiss-me').get()).get('status')).toBe(
        'dismissed',
      );
      expect(await repository.applyAction(agentId, 'advisory', 'dismiss')).toMatchObject({
        outcome: 'already_decided',
        enacted: false,
      });
      expect((await store.doc('improvementProposals', 'advisory').get()).get('status')).toBe(
        'applied',
      );
    });

    it('swaps an evidence-backed model role to enabled models only', async () => {
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
      await Promise.all([
        store.doc('modelRoles', 'draft').set({
          role: 'draft',
          primaryModel: 'old/primary',
          fallbackModel: 'old/fallback',
          params: {},
          updatedAt: new Date('2026-09-01T00:00:00Z'),
        }),
        store.doc('models', 'new/primary').set({
          id: 'new/primary',
          enabled: true,
          promptCostPerMTok: '0',
          completionCostPerMTok: '0',
          capabilities: {},
        }),
        store.doc('models', 'disabled/fallback').set({ id: 'disabled/fallback', enabled: false }),
      ]);
      await seed('routing', {
        change: {
          role: 'draft',
          primaryModel: 'new/primary',
          fallbackModel: 'disabled/fallback',
          suggestion: 'Use the newer draft model',
        },
      });
      await expect(repository.applyAction(agentId, 'routing', 'apply')).rejects.toThrow(
        'not enabled with prices',
      );
      expect((await store.doc('improvementProposals', 'routing').get()).get('status')).toBe('open');
      expect((await store.doc('modelRoles', 'draft').get()).get('primaryModel')).toBe(
        'old/primary',
      );
      await store
        .doc('improvementProposals', 'routing')
        .update({ change: { role: 'draft', primaryModel: 'new/primary' } });
      expect(await repository.applyAction(agentId, 'routing', 'apply')).toMatchObject({
        outcome: 'applied',
        enacted: true,
      });
      expect((await store.doc('improvementProposals', 'routing').get()).get('status')).toBe(
        'applied',
      );
      expect((await store.doc('modelRoles', 'draft').get()).data()).toMatchObject({
        primaryModel: 'new/primary',
        fallbackModel: 'old/fallback',
      });

      // Unknown models remain actionable and never claim an applied change.
      await seed('unknown', { change: { role: 'draft', primaryModel: 'missing/model' } });
      await expect(repository.applyAction(agentId, 'unknown', 'apply')).rejects.toThrow(
        'not enabled with prices',
      );
      expect((await store.doc('improvementProposals', 'unknown').get()).get('status')).toBe('open');
      expect((await store.doc('modelRoles', 'draft').get()).get('primaryModel')).toBe(
        'new/primary',
      );
    });

    it('leaves an unevidenced routing proposal open and refuses foreign owners', async () => {
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
      await store.doc('modelRoles', 'draft').set({ role: 'draft', primaryModel: 'old/primary' });
      await store.doc('models', 'new/primary').set({ id: 'new/primary', enabled: true });
      await seed('opinion', {
        evidenceIds: [],
        change: { role: 'draft', primaryModel: 'new/primary' },
      });
      await expect(repository.applyAction(agentId, 'opinion', 'apply')).rejects.toThrow(
        'needs cited evidence',
      );
      expect((await store.doc('improvementProposals', 'opinion').get()).get('status')).toBe('open');
      expect((await store.doc('modelRoles', 'draft').get()).get('primaryModel')).toBe(
        'old/primary',
      );

      await seed('foreign', { agentId: 'another-owner' });
      await expect(repository.applyAction(agentId, 'foreign', 'dismiss')).rejects.toThrow(
        'Improvement proposal belongs to another agent',
      );
      expect((await store.doc('improvementProposals', 'foreign').get()).get('status')).toBe('open');
    });

    it('fences actions during erasure and requires one configured owner', async () => {
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
      await seed('erase-me', { kind: 'note' });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.applyAction(agentId, 'erase-me', 'dismiss')).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      await store.doc('privacyErasureJobs', agentId).delete();
      const extraOwner = randomUUID();
      await store.doc('agents', extraOwner).set({ id: extraOwner, name: 'Extra' });
      await expect(repository.applyAction(agentId, 'erase-me', 'dismiss')).rejects.toThrow(
        'Improvement action requires exactly one configured owner',
      );
      expect((await store.doc('improvementProposals', 'erase-me').get()).get('status')).toBe(
        'open',
      );
    });

    async function routingFixture(id: string) {
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
      await store
        .doc('modelRoles', 'draft')
        .set({ role: 'draft', primaryModel: 'old/model', fallbackModel: 'old/fallback' });
      await store.doc('models', 'new/model').set({
        id: 'new/model',
        enabled: true,
        promptCostPerMTok: '0',
        completionCostPerMTok: '0',
        capabilities: {},
      });
      await seed(id, { change: { role: 'draft', primaryModel: 'new/model' } });
    }

    it('serializes duplicate approvals and racing dismissal without closing an applied proposal again', async () => {
      await routingFixture('duplicate');
      const duplicate = await Promise.all([
        repository.applyAction(agentId, 'duplicate', 'apply'),
        repository.applyAction(agentId, 'duplicate', 'apply'),
      ]);
      expect(duplicate.map((row) => row.outcome).sort()).toEqual(['already_decided', 'applied']);
      await store.doc('modelRoles', 'draft').update({ primaryModel: 'old/model' });
      await seed('contested', { change: { role: 'draft', primaryModel: 'new/model' } });
      const contested = await Promise.all([
        repository.applyAction(agentId, 'contested', 'apply'),
        repository.applyAction(agentId, 'contested', 'dismiss'),
      ]);
      const final = (await store.doc('improvementProposals', 'contested').get()).get('status');
      expect(contested.filter((row) => row.outcome === 'already_decided')).toHaveLength(1);
      expect((await store.doc('modelRoles', 'draft').get()).get('primaryModel')).toBe(
        final === 'applied' ? 'new/model' : 'old/model',
      );
    });

    it('reports an already current route and refuses missing roles or unpriced models', async () => {
      await routingFixture('current');
      await store.doc('modelRoles', 'draft').update({ primaryModel: 'new/model' });
      expect(await repository.applyAction(agentId, 'current', 'apply')).toMatchObject({
        outcome: 'already_current',
        enacted: false,
      });
      await seed('missing-role', { change: { role: 'draft', primaryModel: 'new/model' } });
      await store.doc('modelRoles', 'draft').delete();
      await expect(repository.applyAction(agentId, 'missing-role', 'apply')).rejects.toThrow(
        'not configured',
      );
      expect((await store.doc('improvementProposals', 'missing-role').get()).get('status')).toBe(
        'open',
      );
      await store.doc('modelRoles', 'draft').set({ role: 'draft', primaryModel: 'old/model' });
      await seed('unpriced', { change: { role: 'draft', primaryModel: 'new/model' } });
      await store.doc('models', 'new/model').update({ promptCostPerMTok: null });
      await expect(repository.applyAction(agentId, 'unpriced', 'apply')).rejects.toThrow(
        'not enabled with prices',
      );
      expect((await store.doc('improvementProposals', 'unpriced').get()).get('status')).toBe(
        'open',
      );
      expect((await store.doc('modelRoles', 'draft').get()).get('primaryModel')).toBe('old/model');
    });

    it('does not commit the routing update if the proposal write fails', async () => {
      await routingFixture('rollback');
      const failingDb = new Proxy(store.db, {
        get(target, property) {
          if (property !== 'runTransaction') return Reflect.get(target, property);
          return (work: (tx: unknown) => Promise<unknown>) =>
            target.runTransaction((tx) =>
              work(
                new Proxy(tx, {
                  get(transaction, key) {
                    if (key !== 'update') return Reflect.get(transaction, key);
                    return (
                      ref: FirebaseFirestore.DocumentReference,
                      patch: FirebaseFirestore.UpdateData<Record<string, unknown>>,
                    ) => {
                      if (ref.path === store.doc('improvementProposals', 'rollback').path)
                        throw new Error('Injected proposal persistence failure');
                      return transaction.update(ref, patch);
                    };
                  },
                }),
              ),
            );
        },
      });
      const failingStore = new Proxy(store, {
        get(target, property) {
          return property === 'db' ? failingDb : Reflect.get(target, property);
        },
      });
      await expect(
        new FirestoreWorkspaceImprovementRepository(failingStore).applyAction(
          agentId,
          'rollback',
          'apply',
        ),
      ).rejects.toThrow('Injected proposal persistence failure');
      expect((await store.doc('improvementProposals', 'rollback').get()).get('status')).toBe(
        'open',
      );
      expect((await store.doc('modelRoles', 'draft').get()).get('primaryModel')).toBe('old/model');
    });

    it('keeps open proposals available after more than 2,000 decided historical rows', async () => {
      for (let offset = 0; offset < 2_001; offset += 500) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 500, 2_001); index++) {
          const id = `old-${index}`;
          batch.set(store.doc('improvementProposals', id), {
            id,
            agentId,
            status: 'dismissed',
          });
        }
        await batch.commit();
      }
      await seed('still-open', { createdAt: new Date('2026-12-02') });
      await expect(repository.listOpen(agentId)).resolves.toMatchObject([{ id: 'still-open' }]);
    });

    it('retains the active-row bound when more than 2,000 proposals are open', async () => {
      const ids = Array.from({ length: 2_001 }, () => randomUUID()).sort();
      for (let offset = 0; offset < 2_001; offset += 500) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 500, 2_001); index++) {
          const id = ids[index];
          if (!id) throw new Error('Missing seeded improvement ID');
          batch.set(store.doc('improvementProposals', id), {
            id,
            agentId,
            status: 'open',
            kind: 'note',
            title: 'An actionable suggestion',
            rationale: 'Bounded query test',
            change: {},
            evidenceIds: [],
            createdAt: new Date('2026-09-01T00:00:00Z'),
          });
        }
        await batch.commit();
      }
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Owner improvements exceed the mobile workspace scan limit',
      );

      const collected: string[] = [];
      let afterId: string | undefined;
      do {
        const page = await repository.listOpenPage(agentId, {
          ...(afterId ? { afterId } : {}),
          limit: 100,
        });
        collected.push(...page.items.map((row) => row.id));
        afterId = page.nextCursor ?? undefined;
        expect(page.hasMore).toBe(Boolean(afterId));
      } while (afterId);
      expect(collected).toEqual(ids);
    });
  },
);
