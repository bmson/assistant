import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), db: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({ getDb: mocks.db, getBillingOverview: async () => [] }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore costs page with PostgreSQL offline', () => {
  const installationId = `web-costs-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let page: typeof import('./page.js');
  let actions: typeof import('./actions.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    mocks.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    mocks.db.mockImplementation(() => {
      throw new Error('PostgreSQL is unreachable');
    });
    page = await import('./page.js');
    actions = await import('./actions.js');

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    await Promise.all([
      store.doc('agents', agentId).set({
        id: agentId,
        name: 'Assistant',
        timezone: 'UTC',
        locale: 'en-US',
        signature: '',
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      }),
      store.doc('coordination', 'budget-holds').set({ heldMicros: 20_000 }),
      store.doc('budgetPeriods', `day:${day}`).set({ spentMicros: 123_400 }),
      store.doc('budgetPeriods', `month:${month}`).set({ spentMicros: 123_400 }),
      store.doc('budgets', 'task_default').set({ scope: 'task_default', limitUsd: '0.50' }),
      store.doc('tasks', 'cost-task').set({
        id: 'cost-task',
        type: 'chat',
        progress: 'Owner work',
        status: 'waiting_budget',
      }),
      store.doc('costEvents', 'owner-charge').set({
        id: 'owner-charge',
        taskId: 'cost-task',
        source: 'model',
        description: 'Owner charge',
        usd: '0.123400',
        createdAt: now,
      }),
      store.doc('modelCalls', 'owner-model').set({
        id: 'owner-model',
        model: 'gemini-test',
        costUsd: '0.123400',
        createdAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows costs reads and server-action submissions through the Firestore proxy', async () => {
    const { proxy } = await import('../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request('/costs')).status).toBe(307);
    expect(proxy(request('/costs', 'POST')).status).toBe(410);
    expect(proxy(request('/costs', 'DELETE')).status).toBe(410);
    expect(proxy(request('/api/mobile/v1/costs', 'POST')).status).toBe(503);
  });

  it('renders cost data and the cap form without PostgreSQL or unsupported task links', async () => {
    const html = renderToStaticMarkup(await page.default());
    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
    expect(html).toContain('Owner charge');
    expect(html).toContain('gemini-test');
    expect(html).toContain('Owner work');
    expect(html).toContain('$0.12');
    expect(html).toContain('<form');
    expect(html).toContain('Update caps');
    expect(html).toContain('estimate month-end costs');
    expect(html).toContain('Assistant spending limits');
    expect(html).not.toContain('href="/tasks');
  });

  it('updates the Firestore caps through the owner-authenticated server action', async () => {
    const form = new FormData();
    form.set('task_default', '3.25');
    form.set('daily', '2.75');
    form.set('monthly', '23');
    await actions.updateCaps(form);

    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledWith('/costs');
    expect((await store.doc('coordination', 'budget-policy').get()).data()).toMatchObject({
      dailyLimitMicros: 2_750_000,
      monthlyLimitMicros: 23_000_000,
    });
    expect((await store.doc('budgets', 'task_default').get()).get('limitUsd')).toBe('3.25');
  });

  it('rejects invalid cap updates atomically', async () => {
    const form = new FormData();
    form.set('task_default', '0');
    form.set('daily', 'not a number');
    form.set('monthly', '10001');
    await expect(actions.updateCaps(form)).rejects.toThrow('whole-cent USD amount');

    expect(mocks.db).not.toHaveBeenCalled();
    expect((await store.doc('coordination', 'budget-policy').get()).data()).toMatchObject({
      dailyLimitMicros: 2_750_000,
      monthlyLimitMicros: 23_000_000,
    });
    expect((await store.doc('budgets', 'task_default').get()).get('limitUsd')).toBe('3.25');
  });

  it('requires owner authentication before changing caps', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    const form = new FormData();
    form.set('daily', '99');
    await expect(actions.updateCaps(form)).rejects.toThrow('owner authentication required');
    expect(mocks.db).not.toHaveBeenCalled();
    expect((await store.doc('coordination', 'budget-policy').get()).get('dailyLimitMicros')).toBe(
      2_750_000,
    );
  });

  it('requires owner authentication before reading costs', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('refuses a configured owner absent from the installation', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default()).rejects.toThrow('Cost dashboard owner is missing');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });

  it('fails closed while owner privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
