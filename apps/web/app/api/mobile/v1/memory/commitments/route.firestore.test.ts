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

describe.skipIf(!localEmulator)('Firestore mobile commitments with PostgreSQL offline', () => {
  const installationId = `mobile-commitments-${randomUUID()}`;
  const foreignInstallationId = `foreign-commitments-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  const url = 'http://localhost/api/mobile/v1/memory/commitments';
  const now = new Date();
  const dueAt = new Date(now.getTime() + 3_600_000);

  const row = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    agentId,
    conversationId: randomUUID(),
    sourceMessageId: null,
    sourceTaskId: null,
    kind: 'promise',
    title: `Commitment ${id}`,
    details: 'Details',
    nextAction: 'Call back',
    status: 'open',
    dueAt,
    snoozedUntil: null,
    resolvedAt: fields.status === 'resolved' || fields.status === 'dismissed' ? now : null,
    resolution: null,
    confidence: '0.90',
    contentHash: id,
    reopenedFromId: null,
    reopenOperationId: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
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
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store
        .doc('commitments', 'open-later')
        .set(row('open-later', { updatedAt: new Date(now.getTime() - 1000) })),
      store.doc('commitments', 'elapsed-snooze').set(
        row('elapsed-snooze', {
          status: 'snoozed',
          snoozedUntil: new Date(now.getTime() - 3_600_000),
          updatedAt: new Date(now.getTime() + 1000),
        }),
      ),
      store.doc('commitments', 'future-snooze').set(
        row('future-snooze', {
          status: 'snoozed',
          snoozedUntil: new Date(now.getTime() + 3_600_000),
        }),
      ),
      store.doc('commitments', 'resolved').set(row('resolved', { status: 'resolved' })),
      store.doc('commitments', 'other-agent').set(row('other-agent', { agentId: otherAgentId })),
      foreignStore.doc('agents', otherAgentId).set({ id: otherAgentId }),
      foreignStore.doc('commitments', 'foreign-installation').set(row('foreign-installation')),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      store.db.recursiveDelete(store.root),
      foreignStore.db.recursiveDelete(foreignStore.root),
    ]);
    await Promise.all([store.db.terminate(), foreignStore.db.terminate()]);
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows the exact commitments route through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/memory/commitments')).toBe(200);
    expect(status('/api/mobile/v1/memory/commitments', 'POST')).toBe(200);
    expect(status('/api/mobile/v1/memory/commitments/other')).toBe(503);
  });

  it('preserves the exact JSON contract and active ranking without PostgreSQL', async () => {
    const { GET } = await import('./route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['commitments', 'closedCommitments']);
    expect(body.closedCommitments).toContainEqual(
      expect.objectContaining({ id: 'resolved', status: 'resolved', updatedAt: now.toISOString() }),
    );
    expect(body.commitments.map((item: { id: string }) => item.id)).toEqual([
      'elapsed-snooze',
      'open-later',
    ]);
    expect(body.commitments[0]).toEqual({
      id: 'elapsed-snooze',
      kind: 'promise',
      title: 'Commitment elapsed-snooze',
      details: 'Details',
      nextAction: 'Call back',
      dueAt: dueAt.toISOString(),
      status: 'snoozed',
    });
    expect(JSON.stringify(body)).not.toContain('foreign-installation');
  });

  it('authenticates first and fails closed for erasure, owner mismatch, and malformed rows', async () => {
    const { GET } = await import('./route.js');
    const { POST } = await import('./route.js');
    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);
    auth.mobile.mockResolvedValueOnce(false);
    expect(
      (
        await POST(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'dismiss', id: 'open-later' }),
          }),
        )
      ).status,
    ).toBe(401);
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', otherAgentId);
    resetConfigForTest();
    try {
      await expect(GET(new Request(url))).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', otherAgentId).delete();
    }
    const ref = store.doc('commitments', 'open-later');
    await ref.update({ dueAt: 'invalid' });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('malformed active row');
    } finally {
      await ref.update({ dueAt });
    }
  });

  it('atomically resolves, snoozes, dismisses, and corrects only configured-owner loops', async () => {
    const { POST } = await import('./route.js');
    const send = (action: string, id: string, extra: Record<string, unknown> = {}) =>
      POST(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, id, ...extra }),
        }),
      );
    await Promise.all(
      ['resolve-me', 'snooze-me', 'dismiss-me', 'correct-me'].map((id) =>
        store.doc('commitments', id).set(row(id)),
      ),
    );

    const resolvedResponse = await send('resolve', 'resolve-me');
    expect(resolvedResponse.status, JSON.stringify(await resolvedResponse.clone().json())).toBe(
      200,
    );
    expect((await store.doc('commitments', 'resolve-me').get()).data()).toMatchObject({
      status: 'resolved',
      resolution: 'Owner confirmed this loop is resolved.',
      snoozedUntil: null,
    });
    expect((await send('snooze', 'snooze-me')).status).toBe(200);
    const snoozed = await store.doc('commitments', 'snooze-me').get();
    expect(snoozed.get('status')).toBe('snoozed');
    expect(snoozed.get('snoozedUntil').toDate().getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600_000,
    );
    expect((await send('dismiss', 'dismiss-me')).status).toBe(200);
    expect((await store.doc('commitments', 'dismiss-me').get()).data()).toMatchObject({
      status: 'dismissed',
      resolution: 'Dismissed by owner',
      snoozedUntil: null,
    });
    expect(
      (
        await send('correct', 'correct-me', {
          title: '  Send   the deck ',
          details: '  By Friday  ',
          nextAction: '  Email it  ',
        })
      ).status,
    ).toBe(200);
    expect((await store.doc('commitments', 'correct-me').get()).data()).toMatchObject({
      title: 'Send the deck',
      details: 'By Friday',
      nextAction: 'Email it',
      confidence: '1.00',
    });

    expect((await send('dismiss', 'other-agent')).status).toBe(409);
    expect((await send('dismiss', 'foreign-installation')).status).toBe(409);
    expect((await store.doc('commitments', 'other-agent').get()).get('status')).toBe('open');
    expect(
      (await foreignStore.doc('commitments', 'foreign-installation').get()).get('status'),
    ).toBe('open');
  });

  it('rejects commitment writes while privacy erasure is active', async () => {
    const { POST } = await import('./route.js');
    await store.doc('commitments', 'erase-fenced').set(row('erase-fenced'));
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      const response = await POST(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'resolve', id: 'erase-fenced' }),
        }),
      );
      expect(response.status).toBe(409);
      expect((await store.doc('commitments', 'erase-fenced').get()).get('status')).toBe('open');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('reopens a matching closed owner row through the authenticated route and replays by operation id', async () => {
    const { POST } = await import('./route.js');
    const closedAt = new Date(now.getTime() - 1000);
    await store.doc('commitments', 'reopen-route').set(
      row('reopen-route', {
        status: 'resolved',
        resolvedAt: closedAt,
        updatedAt: closedAt,
        resolution: 'Closed by owner',
      }),
    );
    const send = () =>
      POST(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'reopen',
            id: 'reopen-route',
            expectedUpdatedAt: closedAt.toISOString(),
            operationId: 'd274bc5a-8c2f-4d50-9449-32352555d24b',
          }),
        }),
      );
    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ ok: true, replay: false });
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...firstBody, replay: true });
    expect((await store.doc('commitments', 'reopen-route').get()).data()).toMatchObject({
      status: 'resolved',
      resolution: 'Closed by owner',
      reopenedFromId: null,
    });
    expect((await store.doc('commitments', firstBody.commitmentId).get()).data()).toMatchObject({
      status: 'open',
      reopenedFromId: 'reopen-route',
    });
  });

  it('applies the same 30-row overview limit and preserves a null due date', async () => {
    const { GET } = await import('./route.js');
    const ids = Array.from({ length: 31 }, (_, index) => `extra-${index}`);
    await Promise.all(
      ids.map((id, index) =>
        store.doc('commitments', id).set(
          row(id, {
            dueAt: index === 30 ? null : dueAt,
            updatedAt: new Date(now.getTime() + 10_000 + index),
          }),
        ),
      ),
    );
    try {
      const response = await GET(new Request(url));
      const body = await response.json();
      expect(body.commitments).toHaveLength(30);
      expect(body.commitments[0]).toMatchObject({ id: 'extra-30', dueAt: null });
    } finally {
      await Promise.all(ids.map((id) => store.doc('commitments', id).delete()));
    }
  });
});
