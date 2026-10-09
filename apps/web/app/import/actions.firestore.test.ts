import { createHash, randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, embeddingSpaceKey } from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn(), authed: vi.fn(), mobile: vi.fn() }));
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@/auth', () => ({ requireOwner: auth.owner, isAuthed: auth.authed }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));
vi.mock('next/navigation', () => ({ redirect: navigation.redirect }));
vi.mock('@assistant/core/model-router', () => ({
  ModelRouter: class {
    embed() {
      throw new Error('Import commands never embed');
    }
  },
  createConnectedModelProviders: vi.fn(),
}));
// The installation's workspace store, in memory: uploaded bytes land here.
vi.mock('@assistant/tools/workspace', () => {
  class MemoryWorkspaceStore {
    async read(relPath: string) {
      const content = files.get(relPath);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    }
    async write(relPath: string, content: string) {
      files.set(relPath, content);
      return { bytes: content.length };
    }
    async list() {
      return [];
    }
    async delete(relPath: string) {
      files.delete(relPath);
    }
  }
  return { LocalWorkspaceStore: MemoryWorkspaceStore, GcsWorkspaceStore: MemoryWorkspaceStore };
});

import { POST as uploadArchive } from '@/app/api/import/upload/route';
import { POST as mobileImports } from '@/app/api/mobile/v1/imports/route';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import {
  deleteSourceAction,
  purgeSourceAction,
  reviewSourceAction,
  startImportAction,
} from './actions';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);
const space: EmbeddingSpace = {
  provider: 'vertex',
  model: 'fixture',
  dimensions: 1536,
  revision: '1',
};

describe.skipIf(!localEmulator)('Firestore import commands with PostgreSQL offline', () => {
  const installationId = `web-imports-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

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
    auth.authed.mockResolvedValue(true);
    auth.mobile.mockResolvedValue(true);
    navigation.redirect.mockReset();
    files.clear();
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  async function source(tag: string) {
    const rows = await store
      .collection('importSources')
      .where('agentId', '==', agentId)
      .where('source', '==', tag)
      .get();
    return rows.docs[0]?.data() ?? null;
  }

  async function memory(tag: string, content: string, quarantined: boolean): Promise<string> {
    const id = randomUUID();
    const contentHash = createHash('sha256').update(content).digest('hex');
    await Promise.all([
      store.doc('memories', id).set({
        id,
        agentId,
        createdAt: new Date('2026-09-20T12:00:00Z'),
        expiresAt: null,
        embedding: FieldValue.vector([1, ...new Array(space.dimensions - 1).fill(0)]),
        embeddingSpace: embeddingSpaceKey(space),
        retrievalRevision: randomUUID(),
        sourceTaskId: null,
        kind: 'fact',
        confidence: '0.60',
        contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content,
        importance: 3,
        quarantined,
        subjectContactId: null,
        domain: null,
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: false,
        pinned: false,
        source: tag,
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      }),
      store.doc('memoryContentHashes', contentHash).set({ memoryId: id }),
    ]);
    return id;
  }

  function uploadForm(fields: Record<string, string>, name: string, content: string) {
    const form = new FormData();
    form.set('file', new File([content], name, { type: 'text/plain' }));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return form;
  }

  it('opens the import surfaces in the proxy while PostgreSQL stays fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const allowed: Array<[string, string]> = [
      ['/api/import/upload', 'POST'],
      ['/api/mobile/v1/imports', 'POST'],
    ];
    for (const [path, method] of allowed)
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(200);
  });

  it('uploads an archive to the workspace and queues its import in Firestore', async () => {
    await uploadArchive(
      new Request('http://localhost/api/import/upload', {
        method: 'POST',
        body: uploadForm({ source: 'Old Mail' }, 'Old Mail.txt', 'Ada moved to Seattle.'),
      }),
    );
    expect(navigation.redirect).toHaveBeenCalledWith('/import');
    const row = await source('old-mail');
    expect(row).toMatchObject({ agentId, status: 'pending', kind: 'text', memoriesSaved: 0 });
    expect(row?.workspacePath).toMatch(/^import\/uploads\/[0-9a-f-]{36}-Old_Mail\.txt$/);
    expect(files.get(String(row?.workspacePath))).toBe('Ada moved to Seattle.');
    const task = (await store.doc('tasks', String(row?.taskId)).get()).data();
    expect(task).toMatchObject({
      agentId,
      status: 'pending',
      trust: 'owner',
      trigger: {
        payload: {
          job: 'import.run',
          source: 'old-mail',
          path: row?.workspacePath,
          kind: 'text',
        },
      },
    });
    const wake = await store.collection('outbox').where('taskId', '==', row?.taskId).get();
    expect(wake.size).toBe(1);

    // A voice upload from the phone seeds the writing-sample job instead.
    const voice = await mobileImports(
      new Request('http://localhost/api/mobile/v1/imports', {
        method: 'POST',
        body: uploadForm({ voice: '1', register: 'sms' }, 'sms-export.txt', 'See you soon!'),
      }),
    );
    expect(voice.status).toBe(201);
    expect(await voice.json()).toEqual({ ok: true, destination: '/profile/voice' });
    const voiceRow = await source('voice-samples-sms-export.txt');
    expect(voiceRow).toMatchObject({ status: 'pending' });
    expect(
      (await store.doc('tasks', String(voiceRow?.taskId)).get()).get('trigger.payload'),
    ).toMatchObject({ job: 'voice.ingest', register: 'sms' });
  });

  it('starts, reviews, purges, and deletes sources from the web and phone', async () => {
    files.set('import/ready.txt', 'Plain notes about the past.');
    const start = () =>
      mobileImports(
        new Request('http://localhost/api/mobile/v1/imports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'start',
            source: 'ready',
            workspacePath: 'import/ready.txt',
          }),
        }),
      );
    expect((await start()).status).toBe(200);
    expect(await source('ready')).toMatchObject({
      status: 'pending',
      workspacePath: 'import/ready.txt',
    });
    const repeated = await start();
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toEqual({ error: 'import "ready" is already pending' });
    await expect(startImportAction('import/ready.txt', 'ready')).resolves.toEqual({
      error: 'import "ready" is already pending',
    });

    const held = await memory('ready', 'Grace Hopper worked at the lab.', true);
    const alsoHeld = await memory('ready', 'Grace Hopper hated coffee.', true);
    const kept = await memory('ready', 'The owner grew up in Reykjavik.', false);
    await reviewSourceAction('ready', 'approve');
    expect((await store.doc('memories', held).get()).get('quarantined')).toBe(false);
    expect((await store.doc('memories', alsoHeld).get()).get('quarantined')).toBe(false);

    const doubtful = await memory('ready', 'Grace Hopper lived on the moon.', true);
    const review = await mobileImports(
      new Request('http://localhost/api/mobile/v1/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'review', source: 'ready', verdict: 'reject' }),
      }),
    );
    expect(review.status).toBe(200);
    expect((await store.doc('memories', doubtful).get()).exists).toBe(false);
    const doubtfulHash = createHash('sha256')
      .update('Grace Hopper lived on the moon.')
      .digest('hex');
    expect((await store.doc('memoryTombstones', doubtfulHash).get()).exists).toBe(true);

    await purgeSourceAction('ready');
    for (const id of [held, alsoHeld, kept])
      expect((await store.doc('memories', id).get()).exists).toBe(false);
    const purged = await source('ready');
    expect(purged).toMatchObject({ status: 'purged', memoriesSaved: 0 });
    expect((await store.doc('tasks', String(purged?.taskId)).get()).get('status')).toBe(
      'cancelled',
    );
    expect((await store.doc('ownerCards', agentId).get()).exists).toBe(true);

    await expect(startImportAction('import/ready.txt', 'ready')).resolves.toEqual({});
    await deleteSourceAction('ready');
    expect(await source('ready')).toBeNull();
    expect(files.has('import/ready.txt')).toBe(false);

    const missing = await mobileImports(
      new Request('http://localhost/api/mobile/v1/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', source: 'ready' }),
      }),
    );
    // A completed deletion receipt makes retries idempotent after the source
    // row and uploaded file are gone.
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true });
  }, 30_000);

  it('refuses import commands during a privacy erasure', async () => {
    files.set('import/ready.txt', 'Plain notes about the past.');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(startImportAction('import/ready.txt', 'ready')).resolves.toEqual({
      error: 'Privacy erasure is in progress',
    });
    expect(await source('ready')).toBeNull();
  });
});
