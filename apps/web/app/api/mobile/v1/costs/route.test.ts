import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreCostRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile cost limits PATCH with PostgreSQL offline',
  () => {
    const installationId = `mobile-cost-limits-${randomUUID()}`;
    const agentId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    let route: typeof import('./route.js');

    beforeAll(async () => {
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      vi.stubEnv(
        'FIRESTORE_EMBEDDING_SPACE',
        '{"provider":"vertex","model":"fixture","dimensions":768,"revision":"1"}',
      );
      vi.stubEnv('LLM_PROVIDER', 'vertex');
      vi.stubEnv('ASSISTANT_MODULES', 'minimal');
      vi.stubEnv('QUEUE_DRIVER', 'local');
      vi.stubEnv('CANARY_ENABLED', 'false');
      vi.stubEnv('LOCATION_PING_SECRET', '');
      resetConfigForTest();
      route = await import('./route.js');
    });

    beforeEach(async () => {
      auth.allowed.mockResolvedValue(true);
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId }),
        store.doc('coordination', 'budget-policy').set({
          dailyLimitMicros: 1_000_000,
          monthlyLimitMicros: 10_000_000,
          softPct: 80,
        }),
        store.doc('budgets', 'task_default').set({ scope: 'task_default', limitUsd: '0.50' }),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    const patch = (body: unknown) =>
      route.PATCH(
        new Request('http://localhost/api/mobile/v1/costs', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    it('allows only PATCH through the Firestore proxy', async () => {
      const { proxy } = await import('../../../../../proxy.js');
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/costs', { method: 'PATCH' })).status,
      ).toBe(200);
      expect(proxy(new NextRequest('http://localhost/api/mobile/v1/costs')).status).toBe(503);
    });

    it('requires authentication and the existing object body', async () => {
      auth.allowed.mockResolvedValue(false);
      expect((await patch({ daily: '2' })).status).toBe(401);
      auth.allowed.mockResolvedValue(true);
      expect((await patch([])).status).toBe(400);
    });

    it('atomically updates live daily/monthly policy and default task cap', async () => {
      expect((await patch({ taskDefault: '2.25', daily: '3.5', monthly: '20' })).status).toBe(200);
      const policy = await store.doc('coordination', 'budget-policy').get();
      const task = await store.doc('budgets', 'task_default').get();
      expect(policy.data()).toMatchObject({
        dailyLimitMicros: 3_500_000,
        monthlyLimitMicros: 20_000_000,
        softPct: 80,
      });
      expect(task.get('limitUsd')).toBe('2.25');
      expect(policy.get('updatedAt')).toBeDefined();
      expect(task.get('updatedAt')).toBeDefined();
      await store.doc('coordination', 'budget-holds').set({ heldMicros: 0 });
      expect(await new FirestoreCostRepository(store).totals()).toMatchObject({
        dailyLimitUsd: 3.5,
        monthlyLimitUsd: 20,
      });
    });

    it('rejects malformed caps and never reports a skipped update as success', async () => {
      expect((await patch({ taskDefault: '12garbage' })).status).toBe(400);
      expect((await patch({ taskDefault: '0.001' })).status).toBe(400);
      expect((await patch({ taskDefault: 2 })).status).toBe(400);
      expect((await patch({ taskDefault: '20000' })).status).toBe(400);
      expect((await patch({ taskDefault: '', daily: '', monthly: '' })).status).toBe(400);
      expect((await store.doc('coordination', 'budget-policy').get()).data()).toMatchObject({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
      });

      expect((await store.doc('budgets', 'task_default').get()).get('limitUsd')).toBe('0.50');
    });

    it('applies zero as an explicit hard stop and leaves omitted fields unchanged', async () => {
      const response = await patch({ daily: '0' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, appliedCaps: { daily: '0.00' } });
      expect((await store.doc('coordination', 'budget-policy').get()).get('dailyLimitMicros')).toBe(
        0,
      );
      expect((await store.doc('budgets', 'task_default').get()).get('limitUsd')).toBe('0.50');
    });

    it('can change period caps when the optional default-task row is absent', async () => {
      await store.doc('budgets', 'task_default').delete();
      expect((await patch({ daily: '2' })).status).toBe(200);
      expect((await store.doc('coordination', 'budget-policy').get()).get('dailyLimitMicros')).toBe(
        2_000_000,
      );
    });
    it('fails closed for active erasure, ambiguous ownership, and malformed budget state', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(patch({ daily: '5' })).rejects.toThrow('Privacy erasure');
      await store.doc('privacyErasureJobs', agentId).delete();
      const extra = randomUUID();
      await store.doc('agents', extra).set({ id: extra });
      try {
        await expect(patch({ daily: '5' })).rejects.toThrow('one matching configured owner');
      } finally {
        await store.doc('agents', extra).delete();
      }
      await store.doc('budgets', 'task_default').update({ scope: 'wrong' });
      await expect(patch({ taskDefault: '1', daily: '5' })).rejects.toThrow(
        'Default task cap is malformed',
      );
      expect((await store.doc('coordination', 'budget-policy').get()).get('dailyLimitMicros')).toBe(
        1_000_000,
      );
    });
  },
);
