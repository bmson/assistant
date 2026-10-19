import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreScheduleRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
const mcpDiscovery = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner, authMode: 'google' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'assistant.test', 'x-forwarded-proto': 'https' }),
}));
vi.mock('@assistant/tools/mcp', () => ({
  inspectMcpConnection: mcpDiscovery.inspect,
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore owner settings page with PostgreSQL offline', () => {
  const installationId = `web-settings-${randomUUID()}`;
  const databaseId = `web-settings-${randomUUID()}`;
  const agentId = randomUUID();
  const policyId = randomUUID();
  const pausedPolicyId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId,
  });
  let page: typeof import('./page.js');
  let actions: typeof import('./actions.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', databaseId);
    vi.stubEnv('MCP_ENC_KEY', '22'.repeat(32));
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
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    mcpDiscovery.inspect.mockResolvedValue({
      status: 'ready',
      serverName: 'Settings test MCP',
      serverVersion: '1.0',
      tools: [{ name: 'search' }],
    });
    page = await import('./page.js');
    actions = await import('./actions.js');

    const now = new Date();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Owner assistant',
      email: 'owner@example.test',
      calendarId: null,
      phoneE164: null,
      avatarUrl: null,
      signature: 'Regards, assistant',
      timezone: 'UTC',
      locale: 'en-US',
      workspacePrefix: 'test',
      browserProfilePath: null,
      credentialRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    const schedules = new FirestoreScheduleRepository(store);
    await schedules.ensure({
      agentId,
      name: 'daily-job',
      cron: '0 9 * * *',
      taskTemplate: {},
      nextRunAt: new Date(now.getTime() + 86_400_000),
    });
    const pausedSchedule = await schedules.ensure({
      agentId,
      name: 'weekly-job',
      cron: '0 9 * * 1',
      taskTemplate: {},
      nextRunAt: new Date(now.getTime() + 7 * 86_400_000),
    });
    await store.doc('schedules', pausedSchedule.id).update({ enabled: false });
    await store.doc('notificationPrefs', agentId).set({
      agentId,
      quietStartMin: 22 * 60,
      quietEndMin: 7 * 60,
      ambientDailyCap: 3,
      createdAt: now,
      updatedAt: now,
    });
    await store.doc('approvalPolicies', policyId).set({
      id: policyId,
      agentId,
      toolName: 'gmail.send',
      templateKey: 'gmail.send.to_recipient',
      effect: 'allow',
      enabled: true,
      createdVia: 'owner',
      match: { recipient: 'trusted@example.test' },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.doc('approvalPolicies', pausedPolicyId).set({
      id: pausedPolicyId,
      agentId,
      toolName: 'calendar.create_event',
      templateKey: 'calendar.create_event',
      effect: 'ask',
      enabled: false,
      createdVia: 'owner',
      match: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('admits owner settings actions and renders only portable Firestore settings editors', async () => {
    const { proxy } = await import('../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/settings')).status).toBe(200);
    expect(proxy(new NextRequest('http://localhost/settings', { method: 'POST' })).status).toBe(
      200,
    );
    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain('Mobile app connection');
    expect(html).toContain('https://assistant.test');
    expect(html).not.toContain('Recurring jobs');
  });

  it('saves, toggles, and deletes MCP connections from Firestore Settings with encrypted credentials', async () => {
    const created = await actions.createMcpConnectionAction({
      name: 'Settings MCP',
      endpoint: 'https://settings.example.test/mcp',
      bearerToken: 'settings-secret-token',
    });
    expect(created).toEqual({});
    const [connection] = (await store.collection('mcpConnections').get()).docs;
    expect(connection.get('bearerTokenEncrypted')).not.toBe('settings-secret-token');
    expect(connection.get('bearerTokenEncrypted')).toMatch(/^v2\./);
    expect(connection.get('status')).toBe('ready');

    expect(await actions.refreshMcpConnectionAction(connection.get('id'))).toEqual({});
    expect(await actions.setMcpConnectionEnabledAction(connection.get('id'), false)).toEqual({});
    expect((await store.doc('mcpConnections', connection.get('id')).get()).get('enabled')).toBe(
      false,
    );
    expect(await actions.deleteMcpConnectionAction(connection.get('id'))).toEqual({});
    expect((await store.doc('mcpConnections', connection.get('id')).get()).exists).toBe(false);
  });

  it('updates notification preferences through the validated Firestore settings facade', async () => {
    const result = await actions.updateNotificationSettings({
      quietStart: '21:30',
      quietEnd: '06:15',
      ambientDailyCap: '5',
    });
    expect(result).toEqual({});
    const prefs = await store.doc('notificationPrefs', agentId).get();
    expect(prefs.get('quietStartMin')).toBe(21 * 60 + 30);
    expect(prefs.get('quietEndMin')).toBe(6 * 60 + 15);
    expect(prefs.get('ambientDailyCap')).toBe(5);
    expect((await store.doc('agents', agentId).get()).get('signature')).toBe('Regards, assistant');
  });

  it('rejects invalid notification preferences without changing Firestore settings', async () => {
    const before = await store.doc('notificationPrefs', agentId).get();
    const result = await actions.updateNotificationSettings({
      quietStart: '25:00',
      quietEnd: '06:15',
      ambientDailyCap: '101',
    });
    expect(result.error).toBeTruthy();
    const after = await store.doc('notificationPrefs', agentId).get();
    expect(after.get('quietStartMin')).toBe(before.get('quietStartMin'));
    expect(after.get('quietEndMin')).toBe(before.get('quietEndMin'));
    expect(after.get('ambientDailyCap')).toBe(before.get('ambientDailyCap'));
  });

  it('requires owner authentication and an inactive erasure fence for notification updates', async () => {
    const before = await store.doc('notificationPrefs', agentId).get();
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(
      actions.updateNotificationSettings({
        quietStart: '20:00',
        quietEnd: '07:00',
        ambientDailyCap: '4',
      }),
    ).rejects.toThrow('owner authentication required');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(
        actions.updateNotificationSettings({
          quietStart: '20:00',
          quietEnd: '07:00',
          ambientDailyCap: '4',
        }),
      ).rejects.toThrow('Privacy erasure is in progress');
      expect((await store.doc('notificationPrefs', agentId).get()).get('ambientDailyCap')).toBe(
        before.get('ambientDailyCap'),
      );
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('updates only the configured owner identity through the validated Firestore facade', async () => {
    const prefsBefore = await store.doc('notificationPrefs', agentId).get();
    const result = await actions.updateAgentSettings({
      timezone: 'America/Los_Angeles',
      locale: 'en-GB',
      signature: 'Best, assistant',
    });
    expect(result).toEqual({});
    const owner = await store.doc('agents', agentId).get();
    expect(owner.get('timezone')).toBe('America/Los_Angeles');
    expect(owner.get('locale')).toBe('en-GB');
    expect(owner.get('signature')).toBe('Best, assistant');
    expect(owner.get('credentialRefs')).toEqual({});
    expect((await store.doc('notificationPrefs', agentId).get()).get('ambientDailyCap')).toBe(
      prefsBefore.get('ambientDailyCap'),
    );
  });

  it('rejects invalid identity values without changing the Firestore owner', async () => {
    const before = await store.doc('agents', agentId).get();
    const result = await actions.updateAgentSettings({
      timezone: 'Not/A_Timezone',
      locale: 'en-US',
      signature: 'must not be saved',
    });
    expect(result.error).toBeTruthy();
    expect((await store.doc('agents', agentId).get()).get('signature')).toBe(
      before.get('signature'),
    );
  });

  it('requires owner authentication and an inactive privacy-erasure fence before mutation', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(
      actions.updateAgentSettings({ timezone: 'UTC', locale: 'en-US', signature: 'No' }),
    ).rejects.toThrow('owner authentication required');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(
        actions.updateAgentSettings({ timezone: 'UTC', locale: 'en-US', signature: 'No' }),
      ).rejects.toThrow('Privacy erasure is in progress');
      expect((await store.doc('agents', agentId).get()).get('signature')).toBe('Best, assistant');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('requires owner authentication before reading', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });
});
