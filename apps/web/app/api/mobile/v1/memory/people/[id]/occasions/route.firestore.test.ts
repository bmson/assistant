import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
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

describe.skipIf(!localEmulator)(
  'Firestore mobile occasion creation with PostgreSQL offline',
  () => {
    const installationId = `mobile-occasion-${randomUUID()}`;
    const agentId = randomUUID();
    const personId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    const url = `http://localhost/api/mobile/v1/memory/people/${personId}/occasions`;

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
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
        store.doc('contacts', personId).set({ id: personId, name: 'Rae' }),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    it('permits only POST for the exact UUID occasion route through the Firestore proxy', async () => {
      const { proxy } = await import('../../../../../../../../proxy.js');
      const status = (path: string, method = 'POST') =>
        proxy(new NextRequest(`http://localhost${path}`, { method })).status;
      expect(status(`/api/mobile/v1/memory/people/${personId}/occasions`)).toBe(200);
      expect(status(`/api/mobile/v1/memory/people/${personId}/occasions`, 'GET')).toBe(503);
      expect(status('/api/mobile/v1/memory/people/not-a-uuid/occasions')).toBe(503);
      expect(status(`/api/mobile/v1/memory/people/${personId}/occasions/extra`)).toBe(503);
    });

    it('validates input, creates an owner-confirmed occasion, and uses no PostgreSQL', async () => {
      const { POST } = await import('./route.js');
      const { getDb } = await import('@/lib/server');
      expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
      const invalid = await POST(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'birthday', month: '2', day: '30' }),
        }),
        { params: Promise.resolve({ id: personId }) },
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: 'That date does not exist. Check the month, day, and year.',
      });

      const response = await POST(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'birthday',
            label: 'Birthday',
            month: '4',
            day: '12',
            year: '1987',
            leadDays: '14',
            notes: 'Ask about a cake',
          }),
        }),
        { params: Promise.resolve({ id: personId }) },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ok: true });
      const occasions = await store.collection('occasions').get();
      expect(occasions.size).toBe(1);
      expect(occasions.docs[0]?.data()).toMatchObject({
        agentId,
        contactId: personId,
        kind: 'birthday',
        year: 1987,
        leadDays: 14,
        notes: 'Ask about a cake',
        ownerConfirmed: true,
        quarantined: false,
        originTrust: 'owner',
      });
    }, 30_000);

    it('returns a truthful not-found response and rejects unauthenticated callers', async () => {
      const { POST } = await import('./route.js');
      const missingId = randomUUID();
      const missing = await POST(
        new Request(`http://localhost/api/mobile/v1/memory/people/${missingId}/occasions`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'birthday', month: '4', day: '12' }),
        }),
        { params: Promise.resolve({ id: missingId }) },
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'Person not found.' });

      auth.mobile.mockResolvedValueOnce(false);
      const denied = await POST(new Request(url), { params: Promise.resolve({ id: personId }) });
      expect(denied.status).toBe(401);
    });
  },
);
