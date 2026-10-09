import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  embeddingSpaceKey,
  FirestoreSkillContextRepository,
} from '@assistant/firestore';
import { FieldValue } from '@google-cloud/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn(), embed: vi.fn() }));
vi.mock('@/lib/server', () => ({
  embedFirestoreSkillText: auth.embed,
  getApplication: vi.fn(),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile skill mutations with PostgreSQL offline', () => {
  const installationId = `mobile-skills-actions-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const skillId = randomUUID();
  const otherSkillId = randomUUID();
  const initial = new Date('2026-09-20T12:00:00Z');
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let route: typeof import('./route.js');
  let collectionRoute: typeof import('../route.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    route = await import('./route.js');
    collectionRoute = await import('../route.js');
  });

  beforeEach(async () => {
    auth.allowed.mockResolvedValue(true);
    auth.embed.mockReset().mockResolvedValue([1, ...new Array(1535).fill(0)]);
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({ id: agentId });
    const skill = (id: string, owner: string) => ({
      id,
      agentId: owner,
      name: 'Test',
      preconditions: '',
      steps: 'Do it',
      gotchas: '',
      embedding: null,
      sourceTaskId: null,
      originTrust: 'owner',
      ownerAuthored: true,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      lastVerifiedAt: null,
      deprecated: false,
      createdAt: initial,
      updatedAt: initial,
    });
    await Promise.all([
      store.doc('skills', skillId).set(skill(skillId, agentId)),
      store.doc('skills', otherSkillId).set(skill(otherSkillId, otherAgentId)),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (id: string, deprecated: unknown) =>
    route.POST(
      new Request(`http://localhost/api/mobile/v1/skills/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deprecated }),
      }),
      context(id),
    );
  const remove = (id: string) =>
    route.DELETE(
      new Request(`http://localhost/api/mobile/v1/skills/${id}`, { method: 'DELETE' }),
      context(id),
    );

  it('exposes create, edit, deprecation, and deletion through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    for (const method of ['POST', 'PATCH', 'DELETE'])
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/skills/${skillId}`, { method }))
          .status,
      ).toBe(200);
    for (const method of ['GET'])
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/skills/${skillId}`, { method }))
          .status,
      ).toBe(503);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/skills', { method: 'POST' })).status,
    ).toBe(200);
    expect(
      proxy(
        new NextRequest('http://localhost/api/mobile/v1/skills/not-a-uuid', { method: 'DELETE' }),
      ).status,
    ).toBe(503);
  });

  it('toggles deprecation and hard-deletes the owner skill', async () => {
    expect((await post(skillId, true)).status).toBe(200);
    let skill = await store.doc('skills', skillId).get();
    expect(skill.get('deprecated')).toBe(true);
    expect(skill.get('updatedAt').toDate().getTime()).toBeGreaterThan(initial.getTime());
    expect((await post(skillId, false)).status).toBe(200);
    skill = await store.doc('skills', skillId).get();
    expect(skill.get('deprecated')).toBe(false);
    expect((await remove(skillId)).status).toBe(200);
    expect((await store.doc('skills', skillId).get()).exists).toBe(false);
  });

  it('rejects missing, foreign, malformed, and ambiguous records without deleting them', async () => {
    expect((await remove(randomUUID())).status).toBe(409);
    expect((await remove(otherSkillId)).status).toBe(409);
    expect((await store.doc('skills', otherSkillId).get()).exists).toBe(true);
    await store.doc('skills', skillId).update({ steps: 42 });
    expect((await post(skillId, true)).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).get('deprecated')).toBe(false);
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    expect((await remove(skillId)).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).exists).toBe(true);
  });

  it('respects the privacy-erasure fence and auth and validates input', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    expect((await remove(skillId)).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).exists).toBe(true);
    await store.doc('privacyErasureJobs', agentId).delete();
    expect((await post(skillId, 'yes')).status).toBe(400);
    auth.allowed.mockResolvedValueOnce(false);
    expect((await remove(skillId)).status).toBe(401);
  });

  const body = (name: string, steps = 'Steps') =>
    JSON.stringify({ name, steps, preconditions: 'When', gotchas: 'Beware' });
  const create = (name: string, steps?: string) =>
    collectionRoute.POST(
      new Request('http://localhost/api/mobile/v1/skills', {
        method: 'POST',
        body: body(name, steps),
        headers: { 'content-type': 'application/json' },
      }),
    );
  const edit = (id: string, name: string) =>
    route.PATCH(
      new Request(`http://localhost/api/mobile/v1/skills/${id}`, {
        method: 'PATCH',
        body: body(name),
        headers: { 'content-type': 'application/json' },
      }),
      context(id),
    );

  it('creates a recall-compatible owner skill and upserts by name', async () => {
    expect((await create('  New skill  ')).status).toBe(201);
    expect(auth.embed).toHaveBeenCalledWith('New skill\nWhen: When\nSteps: Steps\nGotchas: Beware');
    const query = await store.collection('skills').where('agentId', '==', agentId).get();
    const newSkill = query.docs.find((doc) => doc.get('name') === 'New skill');
    expect(newSkill).toBeDefined();
    expect(newSkill?.get('embedding').toArray()).toHaveLength(1536);
    expect(newSkill?.get('embeddingSpace')).toBe(
      embeddingSpaceKey({ provider: 'vertex', model: 'fixture', dimensions: 1536, revision: '1' }),
    );
    expect(newSkill?.get('originTrust')).toBe('owner');
    expect(newSkill?.get('ownerAuthored')).toBe(true);
    expect(newSkill?.get('retrievalRevision')).toEqual(expect.any(String));
    const recall = await new FirestoreSkillContextRepository(store, {
      provider: 'vertex',
      model: 'fixture',
      dimensions: 1536,
      revision: '1',
    }).recall({
      agentId,
      embedding: [1, ...new Array(1535).fill(0)],
      embeddingSpaceKey: embeddingSpaceKey({
        provider: 'vertex',
        model: 'fixture',
        dimensions: 1536,
        revision: '1',
      }),
      minSimilarity: 0.7,
    });
    expect(recall.some((match) => match.skill.id === newSkill?.get('id'))).toBe(true);
    expect((await create('New skill', 'Revised')).status).toBe(201);
    const again = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(again.size).toBe(2);
    expect((await newSkill?.ref.get())?.get('steps')).toBe('Revised');
  });

  it('rejects foreign, missing, and malformed edit targets before embedding or changing rows', async () => {
    const before = (await store.doc('skills', otherSkillId).get()).data();
    auth.embed.mockClear();

    expect((await edit(otherSkillId, 'Foreign')).status).toBe(409);
    expect(auth.embed).not.toHaveBeenCalled();
    expect((await store.doc('skills', otherSkillId).get()).data()).toEqual(before);

    expect((await edit(randomUUID(), 'Missing')).status).toBe(409);
    expect(auth.embed).not.toHaveBeenCalled();
    expect((await edit('not-a-uuid', 'Malformed')).status).toBe(400);
    expect(auth.embed).not.toHaveBeenCalled();
  });

  it('edits only the existing owner skill with a fresh vector and revision', async () => {
    await store.doc('skills', skillId).update({ deprecated: true, ownerAuthored: false });
    auth.embed.mockClear();
    expect((await edit(skillId, 'Revised skill')).status).toBe(200);
    expect(auth.embed).toHaveBeenCalledExactlyOnceWith(
      'Revised skill\nWhen: When\nSteps: Steps\nGotchas: Beware',
    );
    const skill = await store.doc('skills', skillId).get();
    expect(skill.get('name')).toBe('Revised skill');
    expect(skill.get('embedding').toArray()).toHaveLength(1536);
    expect(skill.get('embeddingSpace')).toEqual(expect.any(String));
    expect(skill.get('retrievalRevision')).toEqual(expect.any(String));
    expect(skill.get('deprecated')).toBe(false);
    expect(skill.get('ownerAuthored')).toBe(true);
    expect((await edit(otherSkillId, 'Foreign')).status).toBe(409);
    expect((await edit(randomUUID(), 'Missing')).status).toBe(409);
  });

  it('rejects bad vectors, duplicate names, erasure, and ambiguous agents without writes', async () => {
    auth.embed.mockResolvedValueOnce([1, 2]);
    expect((await create('Bad vector')).status).toBe(409);
    expect((await store.collection('skills').where('name', '==', 'Bad vector').get()).size).toBe(0);
    expect((await create('Other')).status).toBe(201);
    expect((await edit(skillId, 'Other')).status).toBe(409);
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    auth.embed.mockClear();
    expect((await create('Blocked')).status).toBe(409);
    expect(auth.embed).not.toHaveBeenCalled();
    await store.doc('privacyErasureJobs', agentId).delete();
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    auth.embed.mockClear();
    expect((await edit(skillId, 'Blocked')).status).toBe(409);
    expect(auth.embed).not.toHaveBeenCalled();
    expect((await store.doc('skills', skillId).get()).get('name')).toBe('Test');
  });

  it('rejects provider errors and malformed migrated matches without stale-vector writes', async () => {
    auth.embed.mockRejectedValueOnce(new Error('Vertex unavailable'));
    expect((await edit(skillId, 'Changed')).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).get('name')).toBe('Test');
    await store.doc('skills', skillId).update({ originTrust: 'untrusted' });
    expect((await create('Test')).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).get('steps')).toBe('Do it');
  });

  it('rejects migrated vectors without provenance instead of overwriting them', async () => {
    await store
      .doc('skills', skillId)
      .update({ embedding: FieldValue.vector([1, ...new Array(1535).fill(0)]) });
    expect((await edit(skillId, 'Revised')).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).get('name')).toBe('Test');
  });

  it('requires authentication and valid input before embedding', async () => {
    auth.allowed.mockResolvedValueOnce(false);
    expect((await create('No auth')).status).toBe(401);
    expect(auth.embed).not.toHaveBeenCalled();
    expect((await create('', 'Steps')).status).toBe(400);
    expect(auth.embed).not.toHaveBeenCalled();
  });
});
