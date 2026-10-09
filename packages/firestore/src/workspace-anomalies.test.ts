import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreWorkspaceAnomalyRepository } from './workspace-anomalies.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile workspace anomalies',
  () => {
    let store: InstallationStore;
    let repository: FirestoreWorkspaceAnomalyRepository;
    const agentId = randomUUID();

    beforeEach(async () => {
      store = emulatorStore();
      repository = new FirestoreWorkspaceAnomalyRepository(store);
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
    });

    afterEach(async () => disposeStore(store));

    async function seed(
      id: string,
      patch: Record<string, unknown> = {},
      documentId = id,
    ): Promise<void> {
      await store.doc('anomalies', documentId).set({
        id,
        agentId,
        status: 'open',
        kind: 'frequency',
        toolName: 'calendar.create',
        detail: 'Unexpected automatic calendar writes',
        observed: 12,
        expected: 2,
        toolCallIds: ['call-one', 'call-two'],
        policyId: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        ...patch,
      });
    }

    it('matches the newest 100 open rows, excludes other owners, and counts citations exactly', async () => {
      const batch = store.db.batch();
      for (let index = 0; index < 105; index += 1) {
        const id = `open-${String(index).padStart(3, '0')}`;
        batch.set(store.doc('anomalies', id), {
          id,
          agentId,
          status: 'open',
          kind: 'burst',
          toolName: 'email.send',
          detail: 'Burst',
          observed: index,
          expected: 1,
          toolCallIds: ['one', 'two', 'three'],
          policyId: 'policy-one',
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
        });
      }
      batch.set(store.doc('anomalies', 'foreign'), {
        id: 'foreign',
        agentId: 'another-owner',
        status: 'open',
        kind: 'off_hours',
        toolName: 'email.send',
        detail: 'Foreign owner alert',
        observed: 1,
        expected: 0,
        toolCallIds: [],
        policyId: null,
        createdAt: new Date('2026-12-01T00:00:00.000Z'),
      });
      await batch.commit();
      await seed('dismissed', { status: 'dismissed', createdAt: new Date('2026-12-01') });

      const rows = await repository.listOpen(agentId);
      expect(rows).toHaveLength(100);
      expect(rows.map((row) => row.id)).toEqual(
        Array.from({ length: 100 }, (_, index) => `open-${String(104 - index).padStart(3, '0')}`),
      );
      expect(rows[0]).toEqual({
        id: 'open-104',
        kind: 'burst',
        toolName: 'email.send',
        detail: 'Burst',
        observed: 104,
        expected: 1,
        toolCallIds: ['one', 'two', 'three'],
        policyId: 'policy-one',
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 104)),
      });
      expect((await repository.listOpen('another-owner')).map((row) => row.id)).toEqual([
        'foreign',
      ]);
      await expect(repository.listOpen('')).rejects.toThrow('agent is required');
    });

    it('fails closed on malformed owner identity or open anomaly fields', async () => {
      await seed('wrong-id', {}, 'different-document');
      await expect(repository.listOpen(agentId)).rejects.toThrow('Invalid owner anomaly document');
      await store.doc('anomalies', 'different-document').delete();

      await seed('bad-count', { toolCallIds: ['call', 7] });
      await expect(repository.listOpen(agentId)).rejects.toThrow('Invalid open anomaly document');
    });

    it('keeps live anomalies available after more than 2,000 dismissed historical rows', async () => {
      for (let offset = 0; offset < 2_001; offset += 500) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 500, 2_001); index += 1) {
          const id = `old-${index}`;
          batch.set(store.doc('anomalies', id), { id, agentId, status: 'dismissed' });
        }
        await batch.commit();
      }
      await seed('still-open', { createdAt: new Date('2026-12-02') });
      await expect(repository.listOpen(agentId)).resolves.toMatchObject([{ id: 'still-open' }]);
    });

    it('retains the active-row bound when more than 2,000 anomalies are open', async () => {
      const ids = Array.from({ length: 2_001 }, () => randomUUID()).sort();
      for (let offset = 0; offset < 2_001; offset += 500) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 500, 2_001); index += 1) {
          const id = ids[index];
          if (!id) throw new Error('Missing seeded anomaly ID');
          batch.set(store.doc('anomalies', id), {
            id,
            agentId,
            status: 'open',
            kind: 'frequency',
            toolName: 'calendar.create',
            detail: 'Unexpected writes',
            observed: 1,
            expected: 0,
            toolCallIds: [],
            policyId: null,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
          });
        }
        await batch.commit();
      }
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Owner anomalies exceed the mobile workspace scan limit',
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

    it('paginates open anomalies with owner-bound cursors and no skipped rows', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
      await Promise.all([
        ...ids.map((id) => seed(id)),
        store.doc('anomalies', randomUUID()).set({
          id: randomUUID(),
          agentId: randomUUID(),
          status: 'open',
          kind: 'frequency',
          toolName: 'calendar.create',
          detail: 'Foreign',
          observed: 1,
          expected: 0,
          toolCallIds: [],
          policyId: null,
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

    it('rejects reads during erasure and an erasure that completes mid-read', async () => {
      await seed('open-one');
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.listOpen(agentId)).rejects.toThrow('Privacy erasure is in progress');
      await store.doc('privacyErasureJobs', agentId).delete();

      const originalDoc = store.doc.bind(store);
      let fenceReads = 0;
      const spy = vi.spyOn(store, 'doc').mockImplementation((collection, id) => {
        const ref = originalDoc(collection, id);
        if (collection === 'privacyErasureJobs' && id === agentId) {
          const get = ref.get.bind(ref);
          vi.spyOn(ref, 'get').mockImplementation(async () => {
            fenceReads += 1;
            if (fenceReads === 2)
              await originalDoc('privacyErasureJobs', agentId).set({ agentId, status: 'complete' });
            return get();
          });
        }
        return ref;
      });
      try {
        await expect(repository.listOpen(agentId)).rejects.toThrow(
          'Privacy erasure changed during read',
        );
        expect(fenceReads).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('dismisses and suspends owner anomalies transactionally with their linked policy', async () => {
      const policyId = 'policy-to-suspend';
      await seed('dismiss-me');
      await seed('suspend-me', { policyId });
      await store.doc('approvalPolicies', policyId).set({
        id: policyId,
        agentId,
        enabled: true,
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      expect(await repository.dismiss(agentId, 'dismiss-me')).toBe(true);
      expect((await store.doc('anomalies', 'dismiss-me').get()).get('status')).toBe('dismissed');
      expect(await repository.suspendPolicy(agentId, 'suspend-me')).toBe(true);
      expect((await store.doc('anomalies', 'suspend-me').get()).get('status')).toBe('suspended');
      expect((await store.doc('approvalPolicies', policyId).get()).get('enabled')).toBe(false);
      expect(await repository.dismiss('another-owner', 'dismiss-me')).toBe(false);
    });

    it('fences anomaly writes during privacy erasure and rejects foreign policy links', async () => {
      const policyId = 'foreign-policy';
      await seed('suspend-me', { policyId });
      await store.doc('approvalPolicies', policyId).set({
        id: policyId,
        agentId: 'another-owner',
        enabled: true,
      });
      await expect(repository.suspendPolicy(agentId, 'suspend-me')).rejects.toThrow(
        'Anomaly policy belongs to another owner',
      );
      expect((await store.doc('anomalies', 'suspend-me').get()).get('status')).toBe('open');

      await store.doc('approvalPolicies', policyId).update({ agentId });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.dismiss(agentId, 'suspend-me')).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('anomalies', 'suspend-me').get()).get('status')).toBe('open');
    });
  },
);
