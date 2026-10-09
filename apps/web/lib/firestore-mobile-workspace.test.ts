import { randomUUID } from 'node:crypto';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ isMobileAuthed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.isMobileAuthed,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/agent-readiness-source', () => ({
  getAgentReadinessSource: () => ({ read: async () => null }),
}));

vi.mock('@assistant/application/provider-billing', () => ({ getProviderBilling: async () => [] }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile workspace with PostgreSQL offline', () => {
  const installationId = `mobile-workspace-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const now = new Date();

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://unreachable@127.0.0.1:1/offline');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      JSON.stringify({
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        revision: '1',
      }),
    );
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    auth.isMobileAuthed.mockResolvedValue(true);
    await Promise.all([
      store.doc('agents', agentId).set({
        id: agentId,
        name: 'Owner Assistant',
        email: 'owner@example.test',
        calendarId: null,
        phoneE164: null,
        avatarUrl: null,
        signature: 'Owner signature',
        timezone: 'UTC',
        locale: 'en-US',
        workspacePrefix: 'owner',
        browserProfilePath: null,
        credentialRefs: {},
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      }),
      store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 5_000_000,
        monthlyLimitMicros: 50_000_000,
        softPct: 80,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('composes the native response from owner-scoped Firestore reads without SQL', async () => {
    const { getDb } = await import('./server.js');
    const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const source = {
      read: async () => ({ ready: true, database: 'firestore', modules: [] }),
    };
    const result = await getFirestoreMobileWorkspace(source);
    expect(result).toMatchObject({
      chats: { current: [], archived: [] },
      sectionPagination: {
        chats: {
          current: { loaded: 0, hasMore: false, complete: true, archived: false },
          archived: { loaded: 0, hasMore: false, complete: true, archived: true },
        },
        skills: { loaded: 0, hasMore: false, complete: true },
        anomalies: { loaded: 0, hasMore: false, complete: true },
        improvements: { loaded: 0, hasMore: false, complete: true },
      },
      memory: { ownerName: 'Owner', ownerContactId, facts: [] },
      settings: { agent: { name: 'Owner Assistant' }, goalAutomationCount: 0 },
      costs: { dailySpentUsd: 0, monthlySpentUsd: 0, heldUsd: 0 },
      skills: [],
      anomalies: [],
      improvements: [],
      imports: { sources: [] },
    });
    expect(
      result.capabilities.every((capability) => !capability.enabled && !capability.ready),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(foreignAgentId);

    const { GET } = await import('../app/api/mobile/v1/workspace/route.js');
    const response = await GET(new Request('http://localhost/api/mobile/v1/workspace'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      memory: { ownerContactId },
      settings: { agent: { name: 'Owner Assistant' } },
    });
  });

  it('refuses to return any section while privacy erasure is active', async () => {
    const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(getFirestoreMobileWorkspace({ read: async () => null })).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    await store.doc('privacyErasureJobs', agentId).delete();
  });

  it('marks a malformed memory section unavailable while independent screens remain available', async () => {
    await store.doc('contacts', 'broken-contact').set({
      id: 'different-document-id',
      name: 'Malformed',
      trust: 'owner',
    });
    try {
      const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
      const result = await getFirestoreMobileWorkspace({ read: async () => null });
      expect(result.sectionAvailability.memory).toMatchObject({
        status: 'unavailable',
        version: 1,
      });
      expect(result.sectionAvailability.chats).toMatchObject({ status: 'available', version: 1 });
      expect(result.sectionAvailability.settings).toMatchObject({
        status: 'available',
        version: 1,
      });
      expect(result.sectionAvailability.costs).toMatchObject({ status: 'available', version: 1 });
      expect(result.chats).toEqual({ current: [], archived: [] });
      expect(result.memory.facts).toEqual([]);

      const { GET } = await import('../app/api/mobile/v1/workspace/route.js');
      const legacyClient = await GET(new Request('http://localhost/api/mobile/v1/workspace'));
      expect(legacyClient.status).toBe(503);
      const sectionAwareClient = await GET(
        new Request('http://localhost/api/mobile/v1/workspace', {
          headers: { 'x-assistant-workspace-sections': '1' },
        }),
      );
      expect(sectionAwareClient.status).toBe(200);
      expect(await sectionAwareClient.json()).toMatchObject({
        sectionAvailability: { memory: { status: 'unavailable', version: 1 } },
      });
    } finally {
      await store.doc('contacts', 'broken-contact').delete();
    }
  });

  it('keeps costs available when only provider billing exceeds its read budget', async () => {
    const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
    const result = await getFirestoreMobileWorkspace(
      { read: async () => null },
      {
        billingTimeoutMs: 5,
        billingReader: async () => new Promise((resolve) => setTimeout(() => resolve([]), 50)),
      },
    );
    expect(result.sectionAvailability.billing).toMatchObject({ status: 'unavailable', version: 1 });
    expect(result.sectionAvailability.costs).toMatchObject({ status: 'available', version: 1 });
    expect(result.sectionAvailability.chats).toMatchObject({ status: 'available', version: 1 });
    expect(result.costs.billing).toEqual([]);
    expect(result.costs.dailySpentUsd).toBe(0);
  });

  it('isolates a bounded memory contact scan overflow from other workspace sections', async () => {
    const overflowContactIds = Array.from(
      { length: 500 },
      (_, index) => `overflow-contact-${index}`,
    );
    await Promise.all(
      overflowContactIds.map((id) =>
        store
          .doc('contacts', id)
          .set({ id, name: id, trust: 'known', aliases: [], relationship: '' }),
      ),
    );
    try {
      const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
      const result = await getFirestoreMobileWorkspace({ read: async () => null });
      expect(result.sectionAvailability.memory).toMatchObject({
        status: 'unavailable',
        version: 1,
      });
      expect(result.sectionAvailability.chats).toMatchObject({ status: 'available', version: 1 });
      expect(result.sectionAvailability.skills).toMatchObject({ status: 'available', version: 1 });
    } finally {
      await Promise.all(overflowContactIds.map((id) => store.doc('contacts', id).delete()));
    }
  });

  it('rejects a partial workspace if privacy erasure changes during composition', async () => {
    let startRead: (() => void) | undefined;
    let finishRead: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startRead = resolve;
    });
    const delayedRead = new Promise<null>((resolve) => {
      finishRead = () => resolve(null);
    });
    const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
    const pending = getFirestoreMobileWorkspace(
      {
        read: async () => {
          startRead?.();
          return delayedRead;
        },
      },
      { sectionTimeoutMs: 2_000 },
    );
    await started;
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    finishRead?.();
    await expect(pending).rejects.toThrow('Privacy erasure');
    await store.doc('privacyErasureJobs', agentId).delete();
  });

  it('dismisses and suspends owner anomalies through the mobile route while PostgreSQL is offline', async () => {
    const anomalyId = randomUUID();
    const suspendId = randomUUID();
    const policyId = randomUUID();
    await Promise.all([
      store.doc('anomalies', anomalyId).set({
        id: anomalyId,
        agentId,
        status: 'open',
        policyId: null,
      }),
      store.doc('anomalies', suspendId).set({
        id: suspendId,
        agentId,
        status: 'open',
        policyId,
      }),
      store.doc('approvalPolicies', policyId).set({
        id: policyId,
        agentId,
        enabled: true,
      }),
    ]);

    const { POST } = await import('../app/api/mobile/v1/anomalies/[id]/route.js');
    const dismiss = await POST(
      new Request(`http://localhost/api/mobile/v1/anomalies/${anomalyId}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'dismiss' }),
      }),
      { params: Promise.resolve({ id: anomalyId }) },
    );
    expect(dismiss.status).toBe(200);
    expect((await store.doc('anomalies', anomalyId).get()).get('status')).toBe('dismissed');

    const suspend = await POST(
      new Request(`http://localhost/api/mobile/v1/anomalies/${suspendId}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'suspend-policy' }),
      }),
      { params: Promise.resolve({ id: suspendId }) },
    );
    expect(suspend.status).toBe(200);
    expect((await store.doc('anomalies', suspendId).get()).get('status')).toBe('suspended');
    expect((await store.doc('approvalPolicies', policyId).get()).get('enabled')).toBe(false);

    const { getDb } = await import('./server.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
  });

  it('requires mobile owner authentication at the GET route', async () => {
    const { GET } = await import('../app/api/mobile/v1/workspace/route.js');
    auth.isMobileAuthed.mockResolvedValueOnce(false);
    const unauthorized = await GET(new Request('http://localhost/api/mobile/v1/workspace'));
    expect(unauthorized.status).toBe(401);
  });
});
