import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createFirestoreSettingsPersistence, createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)('Firestore mobile settings PATCH with PostgreSQL offline', () => {
  const installationId = `mobile-settings-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const url = 'http://localhost/api/mobile/v1/settings';
  const agent = {
    id: agentId,
    name: 'Owner',
    email: 'owner@example.test',
    calendarId: null,
    phoneE164: null,
    avatarUrl: null,
    signature: 'Original',
    timezone: 'UTC',
    locale: 'en-US',
    workspacePrefix: 'owner',
    browserProfilePath: null,
    credentialRefs: { encrypted: 'preserved' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const request = (body: unknown) =>
    new Request(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
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
    auth.mobile.mockResolvedValue(true);
    await store.doc('agents', agentId).set(agent);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('opens only the exact PATCH and requires mobile authentication', async () => {
    const { proxy } = await import('../../../../../proxy.js');
    expect(proxy(new NextRequest(url, { method: 'PATCH' })).status).toBe(200);
    expect(proxy(new NextRequest(url)).status).toBe(503);
    expect(proxy(new NextRequest(url, { method: 'POST' })).status).toBe(503);
    expect(proxy(new NextRequest(`${url}/other`, { method: 'PATCH' })).status).toBe(503);
    const { PATCH } = await import('./route.js');
    auth.mobile.mockResolvedValueOnce(false);
    expect((await PATCH(request({ timezone: 'UTC', locale: 'en-US' }))).status).toBe(401);
    expect((await store.doc('agents', agentId).get()).get('signature')).toBe('Original');
  });

  it('preserves body and application validation, normalization, and ok/error JSON', async () => {
    const { PATCH } = await import('./route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    expect(await (await PATCH(request([]))).json()).toEqual({
      error: 'Request body must be an object.',
    });
    const invalidTimezone = await PATCH(request({ timezone: 'Not/AZone', locale: 'en-US' }));
    expect(invalidTimezone.status).toBe(400);
    expect(await invalidTimezone.json()).toEqual({ error: 'Unknown timezone "Not/AZone".' });
    const invalidLocale = await PATCH(request({ timezone: 'UTC', locale: '' }));
    expect(invalidLocale.status).toBe(400);
    expect(await invalidLocale.json()).toEqual({ error: 'Locale is required.' });
    const response = await PATCH(
      request({
        timezone: ' America/Los_Angeles ',
        locale: ' en-GB ',
        signature: ` ${'x'.repeat(510)} `,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
    const updated = await store.doc('agents', agentId).get();
    expect(updated.data()).toMatchObject({
      timezone: 'America/Los_Angeles',
      locale: 'en-GB',
      signature: 'x'.repeat(500),
      credentialRefs: { encrypted: 'preserved' },
    });
  });

  it('fails closed for erasure, configured-agent mismatch, and ambiguous owner', async () => {
    const { PATCH } = await import('./route.js');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(PATCH(request({ timezone: 'UTC', locale: 'en-US' }))).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      await expect(
        createFirestoreSettingsPersistence(store, agentId).settings.updateOwner(agentId, {
          timezone: 'UTC',
          locale: 'en-US',
          signature: 'blocked',
        }),
      ).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', otherAgentId);
    resetConfigForTest();
    try {
      await expect(PATCH(request({ timezone: 'UTC', locale: 'en-US' }))).rejects.toThrow(
        'exactly one configured agent',
      );
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', otherAgentId).set({ ...agent, id: otherAgentId });
    try {
      await expect(PATCH(request({ timezone: 'UTC', locale: 'en-US' }))).rejects.toThrow(
        'exactly one configured agent',
      );
    } finally {
      await store.doc('agents', otherAgentId).delete();
    }
  });
});
