import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import { cancelTask, raiseTaskBudgetAndRetry, retryTask, revokeAutonomyGrant } from './actions';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web task actions with PostgreSQL offline', () => {
  const installationId = `web-task-actions-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

  beforeAll(() => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    resetConfigForTest();
  });

  beforeEach(async () => {
    auth.owner.mockResolvedValue(undefined);
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  async function task(patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await store.doc('tasks', id).set({
      id,
      agentId,
      type: 'request',
      trust: 'owner',
      status: 'needs_attention',
      state: { pendingFinal: 'stale' },
      budgetUsdLimit: '2.0000',
      spentUsd: '1.5000',
      queueGeneration: 3,
      attempt: 2,
      autonomyGrant: null,
      archivedAt: null,
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      ...patch,
    });
    return id;
  }

  async function read(id: string) {
    return (await store.doc('tasks', id).get()).data() ?? {};
  }

  it('reaches the task Server Actions through the proxy while PostgreSQL stays fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const path = `/tasks/${randomUUID()}`;
    expect(proxy(new NextRequest(`http://localhost${path}`, { method: 'POST' })).status).toBe(410);
  });

  it('retries a stalled task by publishing the next queue generation', async () => {
    const id = await task();
    await retryTask(id);
    const row = await read(id);
    expect(row).toMatchObject({ status: 'pending', queueGeneration: 4, attempt: 0 });
    expect(row.state).toEqual({});
  });

  it('raises a stalled task budget and requeues it in one change', async () => {
    const id = await task();
    const form = new FormData();
    form.set('budgetUsdLimit', '5');
    await raiseTaskBudgetAndRetry(id, form);
    expect(await read(id)).toMatchObject({
      status: 'pending',
      budgetUsdLimit: '5.0000',
      queueGeneration: 4,
    });

    const running = await task({ status: 'running' });
    await expect(raiseTaskBudgetAndRetry(running, form)).rejects.toThrow(
      'Task can no longer be resumed with a higher budget.',
    );
    const invalid = new FormData();
    invalid.set('budgetUsdLimit', 'not a number');
    await expect(raiseTaskBudgetAndRetry(await task(), invalid)).rejects.toThrow(
      'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
    );
  });

  it('cancels owner work and fences its lease', async () => {
    const id = await task({ status: 'running', leaseToken: 'lease', lockedUntil: new Date() });
    await cancelTask(id);
    expect(await read(id)).toMatchObject({
      status: 'cancelled',
      leaseToken: null,
      lockedUntil: null,
    });
  });

  it.each(['5junk', '5e0', '5.00000', '', '0', '0.009', '9999.99995', '10000', 'Infinity'])(
    'rejects the complete malformed task cap %s before changing work',
    async (raw) => {
      const id = await task();
      const before = await read(id);
      const form = new FormData();
      form.set('budgetUsdLimit', raw);
      await expect(raiseTaskBudgetAndRetry(id, form)).rejects.toThrow(
        'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
      );
      expect(await read(id)).toEqual(before);
      expect((await store.collection('outbox').where('taskId', '==', id).get()).empty).toBe(true);
    },
  );

  it('accepts the exact maximum task cap without rounding beyond storage precision', async () => {
    const id = await task();
    const form = new FormData();
    form.set('budgetUsdLimit', '9999.9999');
    await raiseTaskBudgetAndRetry(id, form);
    expect(await read(id)).toMatchObject({
      status: 'pending',
      budgetUsdLimit: '9999.9999',
      queueGeneration: 4,
    });
  });

  it('rejects a file supplied as a task cap before changing work', async () => {
    const id = await task();
    const before = await read(id);
    const form = new FormData();
    form.set('budgetUsdLimit', new File(['5'], 'amount.txt'));
    await expect(raiseTaskBudgetAndRetry(id, form)).rejects.toThrow(
      'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
    );
    expect(await read(id)).toEqual(before);
    expect((await store.collection('outbox').where('taskId', '==', id).get()).empty).toBe(true);
  });

  it('revokes an autonomy grant and ignores tasks owned by another agent', async () => {
    const id = await task({ status: 'running', autonomyGrant: { grantedAt: 'earlier' } });
    await revokeAutonomyGrant(id);
    expect((await read(id)).autonomyGrant).toMatchObject({
      grantedAt: 'earlier',
      revokedAt: expect.any(String),
    });

    const foreign = await task({ agentId: randomUUID(), autonomyGrant: { grantedAt: 'x' } });
    await expect(revokeAutonomyGrant(foreign)).rejects.toThrow('activity item not found');
    await expect(cancelTask(foreign)).rejects.toThrow('activity item not found');
    expect(await read(foreign)).toMatchObject({
      status: 'needs_attention',
      autonomyGrant: { grantedAt: 'x' },
    });
  });

  it('requires the owner before changing any task', async () => {
    const id = await task();
    auth.owner.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(retryTask(id)).rejects.toThrow('unauthorized');
    expect((await read(id)).status).toBe('needs_attention');
  });
});
