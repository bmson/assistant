import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore writing voice page with PostgreSQL offline', () => {
  const installationId = `web-voice-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const databaseId = 'assistant-web-voice-test';
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId,
  });
  let page: typeof import('./page.js');
  let actions: typeof import('../actions.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', databaseId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');
    actions = await import('../actions.js');

    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store
        .doc('writingSamples', 'sample-auto')
        .set({ id: 'sample-auto', agentId, context: 'auto:mail' }),
      store
        .doc('writingSamples', 'sample-upload')
        .set({ id: 'sample-upload', agentId, context: 'upload:email' }),
      store.doc('voiceProfile', '1').set({
        id: 1,
        description: 'Warm and direct',
        dos: ['short sentences'],
        donts: ['formal greeting'],
        signature: 'B',
      }),
      store.doc('importSources', 'voice-import').set({
        id: 'voice-import',
        agentId,
        source: 'voice-samples-upload',
        status: 'done',
        updatedAt: now,
        itemsTotal: 2,
        itemsProcessed: 2,
        memoriesSaved: 2,
        taskId: null,
        error: null,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('admits owner edits, sample uploads, and the sample purge', async () => {
    const { proxy } = await import('../../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/profile/voice')).status).toBe(307);
    expect(
      proxy(new NextRequest('http://localhost/profile/voice', { method: 'POST' })).status,
    ).toBe(410);
    expect(
      proxy(new NextRequest('http://localhost/api/import/upload', { method: 'POST' })).status,
    ).toBe(200);
    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain('Warm and direct');
    expect(html).toContain('short sentences');
    expect(html).toContain('formal greeting');
    expect(html).toContain('2 samples');
    expect(html).toContain('1 learned from your sent mail');
    expect(html).toContain('href="/profile"');
    expect(html).toContain('Save voice');
    expect(html).toContain('action="/api/import/upload"');
    expect(html).toContain('Only your configured email address is used from archives');
    expect(html).toContain('plain text is treated as writing you confirm is yours');
    // The purge runs through FirestoreVoiceSamplePurgeRepository.
    expect(html).toContain('Clear learned &amp; uploaded samples');
  });

  it('saves the voice profile through the owner-authenticated web action', async () => {
    expect(
      await actions.updateVoiceProfileAction({
        description: '  Concise  ',
        dos: 'Lead with result',
        donts: 'Hedge',
        signature: '  B  ',
      }),
    ).toEqual({});
    expect((await store.doc('voiceProfile', '1').get()).data()).toMatchObject({
      description: 'Concise',
      dos: ['Lead with result'],
      donts: ['Hedge'],
      signature: 'B',
    });
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(
      actions.updateVoiceProfileAction({
        description: 'Unauthorized',
        dos: '',
        donts: '',
        signature: '',
      }),
    ).rejects.toThrow('owner authentication required');
    expect((await store.doc('voiceProfile', '1').get()).get('description')).toBe('Concise');
  });

  it('requires owner authentication', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });

  it('fails closed during privacy erasure', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('refuses a second configured agent', async () => {
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(page.default()).rejects.toThrow('one matching configured owner');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });
});
