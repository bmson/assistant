import { createHash, randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, embeddingSpaceKey } from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn(), mobile: vi.fn() }));
const router = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));
vi.mock('@assistant/core/model-router', () => ({
  ModelRouter: class {
    embed(...args: unknown[]) {
      return router.embed(...args);
    }
  },
  createConnectedModelProviders: vi.fn(),
}));

import { PATCH as patchEntity } from '@/app/api/mobile/v1/knowledge/[id]/route';
import {
  POST as cleanupAction,
  GET as cleanupFindings,
} from '@/app/api/mobile/v1/knowledge/cleanup/route';
import { GET as graph } from '@/app/api/mobile/v1/knowledge/graph/route';
import { POST as relationAction } from '@/app/api/mobile/v1/knowledge/relations/[id]/route';
import { GET as sourceImpact } from '@/app/api/mobile/v1/knowledge/sources/[id]/route';
import { GET as workspace } from '@/app/api/mobile/v1/knowledge/workspace/route';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import {
  approveKnowledgeMemory,
  correctKnowledgeRelation,
  keepKnowledgeMemory,
  loadConnectionSource,
  loadKnowledgeNeighborhood,
  loadKnowledgeSourceImpact,
  mergeKnowledgeEntity,
  reextractDatedSources,
  removeDisconnectedKnowledgeItems,
  renameKnowledgeEntity,
  retryQuarantinedKnowledgeSources,
  retypeKnowledgeEntity,
  searchKnowledgeEntities,
} from './actions';
import KnowledgePage from './page';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);
const space: EmbeddingSpace = {
  provider: 'vertex',
  model: 'fixture',
  dimensions: 1536,
  revision: '1',
};
const vector = [1, ...new Array(space.dimensions - 1).fill(0)];
const blank = { error: null, success: null };

describe.skipIf(!localEmulator)('Firestore knowledge workspace with PostgreSQL offline', () => {
  const installationId = `web-knowledge-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  const friendId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const now = new Date();
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  beforeAll(() => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('FIRESTORE_EMBEDDING_SPACE', JSON.stringify(space));
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('VERTEX_PROJECT', 'demo-assistant-test');
    vi.stubEnv('VERTEX_LOCATION', 'us-central1');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
  });

  beforeEach(async () => {
    auth.owner.mockResolvedValue(undefined);
    auth.mobile.mockResolvedValue(true);
    router.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => vector));
    await store.db.recursiveDelete(store.root);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Ada Owner',
        trust: 'owner',
        relationship: 'self',
        aliases: [],
        createdAt: at(1000),
        updatedAt: at(1000),
      }),
      store.doc('contacts', friendId).set({
        id: friendId,
        name: 'Grace',
        trust: 'known',
        relationship: 'friend',
        aliases: [],
        createdAt: at(1000),
        updatedAt: at(1000),
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  async function fact(content: string, patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const contentHash = createHash('sha256').update(content).digest('hex');
    await Promise.all([
      store.doc('memories', id).set({
        id,
        agentId,
        createdAt: at(30),
        expiresAt: null,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
        retrievalRevision: randomUUID(),
        sourceTaskId: null,
        kind: 'fact',
        confidence: '0.70',
        contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content,
        importance: 3,
        quarantined: false,
        subjectContactId: ownerContactId,
        domain: 'home',
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: false,
        pinned: false,
        source: 'owner',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
        ...patch,
      }),
      store.doc('memoryContentHashes', contentHash).set({ memoryId: id }),
      store.doc('knowledgeGraphSources', id).set({
        memoryId: id,
        agentId,
        status: 'ready',
        contentHash,
        subjectContactId: ownerContactId,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
        attempts: 1,
        lastError: null,
        nextRetryAt: null,
        createdAt: at(30),
        updatedAt: at(30),
      }),
    ]);
    return id;
  }

  async function entity(label: string, kind: string, patch: Record<string, unknown> = {}) {
    const id = randomUUID();
    await store.doc('knowledgeGraphEntities', id).set({
      id,
      agentId,
      label,
      preferredLabel: null,
      kind,
      canonicalKey: `${kind}:${label.toLowerCase()}`,
      contactId: null,
      createdAt: at(30),
      updatedAt: at(30),
      ...patch,
    });
    return id;
  }

  async function relation(
    subjectEntityId: string,
    objectEntityId: string,
    sourceMemoryId: string,
    patch: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    await store.doc('knowledgeGraphRelations', id).set({
      id,
      agentId,
      subjectEntityId,
      objectEntityId,
      sourceMemoryId,
      predicate: 'lives_in',
      confidence: '0.90',
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      validFrom: null,
      validUntil: null,
      evidenceQuote: 'quoted',
      sourceFingerprint: id,
      ordinal: 0,
      createdAt: at(10),
      ...patch,
    });
    return id;
  }

  /** Grace lives in Oslo and works at Acme; one disconnected item and one quarantined memory. */
  async function seedGraph() {
    const grace = await entity('Grace', 'person', {
      contactId: friendId,
      canonicalKey: `contact:${friendId}`,
    });
    const oslo = await entity('Oslo', 'place');
    const acme = await entity('Acme', 'organization');
    const orphan = await entity('Nobody', 'topic');
    const livesMemory = await fact('Grace lives in Oslo');
    const worksMemory = await fact('Grace works at Acme');
    const lives = await relation(grace, oslo, livesMemory, { createdAt: at(5) });
    const works = await relation(grace, acme, worksMemory, {
      predicate: 'works_at',
      reviewStatus: 'confirmed',
    });
    const held = await fact('Grace might move to Bergen', { quarantined: true });
    await store
      .doc('knowledgeGraphSources', held)
      .update({ status: 'quarantined', lastError: 'provider failed' });
    return { grace, oslo, acme, orphan, livesMemory, worksMemory, lives, works, held };
  }

  const json = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (path: string, body: unknown, method = 'POST') =>
    new Request(`http://localhost${path}`, { method, body: JSON.stringify(body) });
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };

  it('opens the knowledge workspace in the proxy while PostgreSQL stays fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const id = randomUUID();
    const allowed: Array<[string, string]> = [
      ['/profile/knowledge', 'GET'],
      ['/profile/knowledge', 'POST'],
      ['/api/mobile/v1/knowledge/workspace', 'GET'],
      ['/api/mobile/v1/knowledge/graph', 'GET'],
      ['/api/mobile/v1/knowledge/cleanup', 'GET'],
      ['/api/mobile/v1/knowledge/cleanup', 'POST'],
      [`/api/mobile/v1/knowledge/${id}`, 'PATCH'],
      [`/api/mobile/v1/knowledge/sources/${id}`, 'GET'],
      [`/api/mobile/v1/knowledge/relations/${id}`, 'POST'],
    ];
    for (const [path, method] of allowed)
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(
        path.startsWith('/api/') ? 200 : method === 'GET' ? 307 : 410,
      );
    for (const [path, method] of [
      ['/api/mobile/v1/knowledge/workspace', 'POST'],
      ['/api/mobile/v1/knowledge/cleanup', 'DELETE'],
      [`/api/mobile/v1/knowledge/${id}`, 'DELETE'],
      ['/api/mobile/v1/knowledge/bad/graph', 'GET'],
    ])
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(503);
  });

  it('serves the mobile workspace overview and cleanup findings', async () => {
    const seeded = await seedGraph();
    const overview = await json(await workspace(new Request('http://localhost/x')));
    expect(overview).toMatchObject({
      status: 200,
      body: {
        memory: { totalUsable: 2, awaitingReview: 1 },
        graph: {
          activeEntities: 3,
          activeRelations: 2,
          orphanedEntities: 1,
          failedSources: 1,
        },
        // Orphans, the held memory with its failed projection, and the unreviewed edge.
        cleanupCount: 3,
      },
    });
    const cleanup = await json(await cleanupFindings(new Request('http://localhost/x')));
    const findings = cleanup.body.findings as Array<Record<string, unknown>>;
    expect(findings.map((row) => row.id)).toEqual([
      'projection_orphan:all',
      `quarantined:${seeded.held}`,
      `unreviewed_connection:${seeded.lives}`,
    ]);
    expect(findings[1]).toMatchObject({
      detail: 'Grace might move to Bergen',
      relatedKinds: ['projection_failed'],
    });
    auth.mobile.mockResolvedValueOnce(false);
    expect((await workspace(new Request('http://localhost/x'))).status).toBe(401);
  });

  it('serves the mobile map for everyone, one entity, and one person', async () => {
    const seeded = await seedGraph();
    const all = await json(await graph(new Request('http://localhost/x')));
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ totalEdges: 2, truncated: false, focusId: null });
    expect((all.body.edges as Array<{ id: string }>).map((edge) => edge.id)).toEqual([
      seeded.lives,
      seeded.works,
    ]);
    expect((all.body.edges as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceContent: 'Grace lives in Oslo',
      presentation: { sentence: expect.stringContaining('Grace') },
    });

    const person = await json(
      await graph(new Request(`http://localhost/x?person=${friendId}&q=acme`)),
    );
    expect(person.body).toMatchObject({ focusId: seeded.grace, totalEdges: 1 });
    expect(
      (person.body.nodes as Array<{ id: string; contactId: string | null }>).find(
        (node) => node.id === seeded.grace,
      )?.contactId,
    ).toBe(friendId);

    const isolated = await json(
      await graph(new Request(`http://localhost/x?entity=${seeded.orphan}`)),
    );
    expect(isolated.body).toMatchObject({
      focusId: seeded.orphan,
      nodes: [{ id: seeded.orphan, label: 'Nobody', degree: 0 }],
    });
    expect((await graph(new Request(`http://localhost/x?entity=${randomUUID()}`))).status).toBe(
      404,
    );
    expect((await graph(new Request(`http://localhost/x?person=${ownerContactId}`))).status).toBe(
      404,
    );
    expect((await graph(new Request('http://localhost/x?entity=bad'))).status).toBe(400);
  });

  it('renders the library, map, and cleanup views of the page from Firestore', async () => {
    const seeded = await seedGraph();
    const render = async (params: Record<string, string>) =>
      renderToStaticMarkup(await KnowledgePage({ searchParams: Promise.resolve(params) }));
    const library = await render({});
    expect(auth.owner).toHaveBeenCalled();
    expect(library).toContain('Memory library');
    expect(library).toContain('Grace lives in Oslo');
    expect(library).toContain('3 to review');
    const map = await render({ view: 'map', entity: seeded.grace });
    expect(map).toContain('Connections around Grace');
    expect(map).toContain('Grace works at Acme');
    const cleanup = await render({ view: 'cleanup' });
    expect(cleanup).toContain('Remove disconnected graph items');
    expect(cleanup).toContain('Grace might move to Bergen');
  });

  it('renames, retypes, and merges entities over the mobile route', async () => {
    const seeded = await seedGraph();
    const patch = async (id: string, body: unknown) =>
      json(await patchEntity(post(`/api/mobile/v1/knowledge/${id}`, body, 'PATCH'), idParams(id)));
    expect(await patch(seeded.oslo, { action: 'rename', label: '  Oslo,  Norway ' })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(
      (await store.doc('knowledgeGraphEntities', seeded.oslo).get()).get('preferredLabel'),
    ).toBe('Oslo, Norway');
    expect(await patch(seeded.oslo, { action: 'rename', label: ' ' })).toMatchObject({
      status: 409,
      body: { error: 'Enter a display name.' },
    });
    expect(await patch(seeded.acme, { action: 'retype', kind: 'project' })).toMatchObject({
      status: 200,
    });
    expect((await store.doc('knowledgeGraphEntities', seeded.acme).get()).data()).toMatchObject({
      kind: 'project',
      canonicalKey: 'project:acme',
    });
    expect(await patch(seeded.acme, { action: 'retype', kind: 'date' })).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('Dates keep a canonical identity') },
    });
    const other = await entity('Acme Holdings', 'project');
    expect(await patch(other, { action: 'merge', targetId: seeded.acme })).toMatchObject({
      status: 200,
    });
    expect((await store.doc('knowledgeGraphEntities', other).get()).exists).toBe(false);
    expect(await patch(seeded.acme, { action: 'merge', targetId: seeded.acme })).toMatchObject({
      status: 409,
      body: { error: 'Choose a different item to merge into.' },
    });
    expect(await patch(seeded.acme, { action: 'delete' })).toMatchObject({ status: 400 });
  });

  it('runs every mobile cleanup action against Firestore', async () => {
    const seeded = await seedGraph();
    const run = (body: unknown) =>
      cleanupAction(post('/api/mobile/v1/knowledge/cleanup', body)).then(json);
    expect(await run({ action: 'remove-orphans' })).toEqual({ status: 200, body: { ok: true } });
    expect((await store.doc('knowledgeGraphEntities', seeded.orphan).get()).exists).toBe(false);
    expect(await run({ action: 'retry' })).toMatchObject({ status: 200 });
    expect((await store.doc('knowledgeGraphSources', seeded.held).get()).data()).toMatchObject({
      status: 'failed',
      attempts: 0,
    });
    expect(await run({ action: 'approve', memoryId: seeded.held })).toMatchObject({ status: 200 });
    expect((await store.doc('memories', seeded.held).get()).get('quarantined')).toBe(false);
    const expired = await fact('Grace visited last year', { expiresAt: at(1) });
    expect(await run({ action: 'keep', memoryId: expired })).toMatchObject({ status: 200 });
    expect((await store.doc('memories', expired).get()).get('expiresAt')).toBeNull();
    expect(await run({ action: 'forget', memoryId: seeded.livesMemory })).toMatchObject({
      status: 200,
    });
    expect((await store.doc('memories', seeded.livesMemory).get()).exists).toBe(false);
    expect(await run({ action: 'unknown' })).toMatchObject({ status: 400 });
  });

  it('corrects a relation by saving the owner fact first, then retiring the old edge', async () => {
    const seeded = await seedGraph();
    const response = await json(
      await relationAction(
        post(`/api/mobile/v1/knowledge/relations/${seeded.lives}`, {
          action: 'correct',
          subjectId: seeded.grace,
          predicate: 'lives in',
          objectLabel: 'Bergen',
          objectKind: 'place',
          note: 'She moved in the spring',
        }),
        idParams(seeded.lives),
      ),
    );
    expect(response.status).toBe(201);
    expect(response.body.relationId).toBeTruthy();
    expect(
      (await store.doc('knowledgeGraphRelations', seeded.lives).get()).get('reviewStatus'),
    ).toBe('rejected');
    const missing = randomUUID();
    expect(
      await json(
        await relationAction(
          post(`/api/mobile/v1/knowledge/relations/${missing}`, {
            action: 'correct',
            subjectId: seeded.grace,
            predicate: 'lives in',
            objectLabel: 'Bergen',
            objectKind: 'place',
            note: 'She moved in the spring',
          }),
          idParams(missing),
        ),
      ),
    ).toEqual({ status: 400, body: { error: 'That relationship no longer exists.' } });
  });

  it('reports source impact over the mobile route', async () => {
    const seeded = await seedGraph();
    const impact = await json(
      await sourceImpact(
        new Request(`http://localhost/x/${seeded.worksMemory}`),
        idParams(seeded.worksMemory),
      ),
    );
    expect(impact).toEqual({
      status: 200,
      body: {
        memoryId: seeded.worksMemory,
        content: 'Grace works at Acme',
        connectionCount: 1,
        activeConnectionCount: 1,
        retiredProjectionCount: 0,
        orphanedItems: [{ id: seeded.acme, label: 'Acme' }],
      },
    });
    const missing = randomUUID();
    expect(
      (await sourceImpact(new Request(`http://localhost/x/${missing}`), idParams(missing))).status,
    ).toBe(404);
  });

  it('runs the knowledge workspace Server Actions without PostgreSQL', async () => {
    const seeded = await seedGraph();
    await expect(
      renameKnowledgeEntity(seeded.acme, blank, form({ label: 'Acme Corp' })),
    ).resolves.toEqual({ error: null, success: 'Display name updated.' });
    await expect(
      retypeKnowledgeEntity(seeded.acme, blank, form({ kind: 'bogus' })),
    ).resolves.toEqual({ error: 'Choose a valid type.', success: null });
    const duplicate = await entity('Oslo City', 'place');
    await relation(seeded.grace, duplicate, seeded.livesMemory, { createdAt: at(1) });
    await expect(
      mergeKnowledgeEntity(duplicate, blank, form({ targetId: seeded.oslo })),
    ).resolves.toMatchObject({ error: null });
    await expect(searchKnowledgeEntities('acme', '', '')).resolves.toEqual([
      expect.objectContaining({ id: seeded.acme, label: 'Acme Corp' }),
    ]);
    const neighborhood = await loadKnowledgeNeighborhood(seeded.grace);
    expect(neighborhood.total).toBe(2);
    expect(neighborhood.edges[0]).toMatchObject({ id: seeded.works, reviewStatus: 'confirmed' });
    await expect(loadConnectionSource(seeded.works)).resolves.toEqual({
      content: 'Grace works at Acme',
      sentence: expect.stringContaining('Acme Corp'),
    });
    await expect(loadKnowledgeSourceImpact(seeded.livesMemory)).resolves.toMatchObject({
      connectionCount: 1,
    });

    await removeDisconnectedKnowledgeItems();
    expect((await store.doc('knowledgeGraphEntities', seeded.orphan).get()).exists).toBe(false);
    await retryQuarantinedKnowledgeSources();
    expect((await store.doc('knowledgeGraphSources', seeded.held).get()).get('status')).toBe(
      'failed',
    );
    await approveKnowledgeMemory(seeded.held);
    expect((await store.doc('memories', seeded.held).get()).get('quarantined')).toBe(false);
    const dated = await fact('Grace flies to Oslo tomorrow');
    await reextractDatedSources();
    expect((await store.doc('knowledgeGraphSources', dated).get()).get('status')).toBe('failed');
    const expired = await fact('Grace had a cold', { expiresAt: at(1) });
    await keepKnowledgeMemory(expired);
    expect((await store.doc('memories', expired).get()).get('expiresAt')).toBeNull();

    await expect(
      correctKnowledgeRelation(
        seeded.works,
        blank,
        form({
          subjectId: seeded.grace,
          predicate: 'works at',
          objectLabel: 'Initech',
          objectKind: 'organization',
          note: 'Changed jobs in August',
        }),
      ),
    ).resolves.toMatchObject({ error: null });
    expect(
      (await store.doc('knowledgeGraphRelations', seeded.works).get()).get('reviewStatus'),
    ).toBe('rejected');
  }, 30_000);

  it('requires the owner before changing the graph', async () => {
    const seeded = await seedGraph();
    auth.owner.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(
      renameKnowledgeEntity(seeded.acme, blank, form({ label: 'Mine' })),
    ).rejects.toThrow('unauthorized');
    expect(
      (await store.doc('knowledgeGraphEntities', seeded.acme).get()).get('preferredLabel'),
    ).toBe(null);
  });
});
