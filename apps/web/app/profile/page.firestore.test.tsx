import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import * as firestore from '@assistant/firestore';
import { createInstallationStore, FirestoreProfileMemoryHubRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  owner: vi.fn(),
  pgBrowse: vi.fn(() => {
    throw new Error('Unexpected PostgreSQL browse fallback');
  }),
}));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('@/lib/server', async (original) => ({
  ...(await original<typeof import('@/lib/server')>()),
  withPostgresMemoryBrowseRead: auth.pgBrowse,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore memory hub page with PostgreSQL offline', () => {
  const installationId = `web-profile-hub-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let page: typeof import('./page.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');
    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store.doc('contacts', ownerId).set({
        id: ownerId,
        name: 'Ada Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      }),
      store.doc('memories', 'review-me').set({
        id: 'review-me',
        agentId,
        subjectContactId: ownerId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Quarantined claim awaiting review',
        contentHash: 'hash-review',
        confidence: '0.5',
        importance: 3,
        domain: 'other',
        pinned: false,
        ownerConfirmed: false,
        quarantined: true,
        supersededById: null,
        expiresAt: null,
        originTrust: 'unknown',
        sourceTaskId: null,
        lastConsolidatedAt: null,
        validFrom: null,
        validUntil: null,
        createdAt: now,
      }),
      store.doc('commitments', 'loop').set({
        id: 'loop',
        agentId,
        kind: 'promise',
        title: 'Send Grace the slides',
        details: '',
        nextAction: '',
        status: 'open',
        dueAt: null,
        snoozedUntil: null,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('admits only browse reads and renders two static destinations without private panel reads', async () => {
    const { proxy } = await import('@/proxy');
    for (const path of ['/profile', '/profile/knowledge']) {
      for (const method of ['GET', 'HEAD'])
        expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(200);
      for (const method of ['POST', 'DELETE'])
        expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(405);
    }
    const server = await import('@/lib/server');
    expect(() => server.getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const sqlRead = vi.spyOn(server, 'getDb');
    const storeRead = vi.spyOn(firestore, 'createInstallationStore');
    const hubRead = vi.spyOn(FirestoreProfileMemoryHubRepository.prototype, 'load');
    try {
      const html = renderToStaticMarkup(await page.default());
      expect(auth.owner).toHaveBeenCalled();
      expect(sqlRead).not.toHaveBeenCalled();
      expect(auth.pgBrowse).not.toHaveBeenCalled();
      expect(hubRead).not.toHaveBeenCalled();
      expect(storeRead).not.toHaveBeenCalled();
      expect(html).toContain('What I remember');
      expect(html).toContain('Browse only. Editing and cleanup are unavailable here.');
      expect(html.match(/<h2\b/g)).toHaveLength(2);
      expect(html).toContain('href="/people"');
      expect(html).toContain('href="/profile/knowledge?view=library"');
      expect(html).not.toContain('Quarantined claim awaiting review');
      expect(html).not.toContain('Send Grace the slides');
      expect(html).not.toContain('Ada Owner');
      expect(html).not.toContain('<form');
    } finally {
      hubRead.mockRestore();
      storeRead.mockRestore();
      sqlRead.mockRestore();
    }
  });

  it('requires the owner before reading', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });
});
