import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreImportOverviewRepository } from './import-overview.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile import overview without PostgreSQL',
  () => {
    let store: InstallationStore;
    let repository: FirestoreImportOverviewRepository;
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const now = new Date('2026-09-22T12:00:00Z');

    beforeEach(async () => {
      store = emulatorStore(() => now);
      repository = new FirestoreImportOverviewRepository(store, agentId);
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    });

    afterEach(async () => disposeStore(store));

    const importSource = (id: string, source: string, updatedAt: Date, ownerId = agentId) => ({
      id,
      agentId: ownerId,
      createdAt: now,
      updatedAt,
      source,
      workspacePath: `import/${source}.txt`,
      kind: 'text',
      status: 'done',
      taskId: null,
      itemsTotal: 1,
      itemsProcessed: 1,
      memoriesSaved: 1,
      memoriesQuarantined: 0,
      error: null,
    });

    const memory = (id: string, source: string | null, ownerId = agentId, quarantined = true) => ({
      id,
      agentId: ownerId,
      category: 'knowledge',
      quarantined,
      expiresAt: new Date('2020-01-01T00:00:00Z'),
      createdAt: now,
      content: `memory ${id}`,
      kind: 'fact',
      domain: null,
      confidence: '1.00',
      importance: 1,
      ownerConfirmed: false,
      pinned: false,
      lastConsolidatedAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      validFrom: null,
      validUntil: null,
      source,
    });

    it('keeps exact owner quarantine counts for a bounded page without reading PostgreSQL', async () => {
      const recent = importSource('recent-source', 'recent', now);
      const old = importSource('old-source', 'old', new Date(now.getTime() - 10_000));
      const voice = importSource('voice-source', 'voice-samples-upload', new Date(0));
      const foreign = importSource('foreign-source', 'foreign', now, otherAgentId);
      const batch = store.db.batch();
      for (const row of [recent, old, voice, foreign])
        batch.set(store.doc('importSources', row.id), row);

      const quarantinedRecent = memory(randomUUID(), 'recent');
      const quarantinedRecent2 = memory(randomUUID(), 'recent');
      const quarantinedVoice = memory(randomUUID(), 'voice-samples-upload');
      const noSource = memory(randomUUID(), null);
      const usable = memory(randomUUID(), 'recent', agentId, false);
      const foreignMemory = memory(randomUUID(), 'foreign', otherAgentId);
      for (const row of [
        quarantinedRecent,
        quarantinedRecent2,
        quarantinedVoice,
        noSource,
        usable,
        foreignMemory,
      ])
        batch.set(store.doc('memories', row.id), row);
      await batch.commit();

      await expect(repository.listPage({ limit: 2 })).resolves.toEqual({
        sources: [old, recent],
        quarantineBySource: { recent: 2 },
        hasMore: true,
        nextCursor: 'recent',
      });
      await expect(
        repository.listPage({
          afterSource: 'recent',
          limit: 2,
          excludeSourcePrefix: 'voice-samples',
        }),
      ).resolves.toMatchObject({
        sources: [],
        quarantineBySource: {},
        hasMore: false,
        nextCursor: null,
      });
    });

    it('continues past excluded voice sources instead of returning a misleading empty end page', async () => {
      const batch = store.db.batch();
      for (let index = 0; index < 55; index += 1) {
        const source = `voice-samples-${String(index).padStart(3, '0')}`;
        batch.set(
          store.doc('importSources', `voice-${index}`),
          importSource(`voice-${index}`, source, now),
        );
      }
      const visible = importSource('visible-source', 'work-archive', now);
      batch.set(store.doc('importSources', visible.id), visible);
      await batch.commit();

      const page = await repository.listPage({ limit: 1, excludeSourcePrefix: 'voice-samples' });
      expect(page.sources.map((row) => row.source)).toEqual(['work-archive']);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('rejects a repository configured for another agent', async () => {
      const missingRepository = new FirestoreImportOverviewRepository(store, randomUUID());
      await expect(missingRepository.listPage({ limit: 10 })).rejects.toThrow(
        'Configured Firestore agent',
      );
    });

    it('rejects a privacy generation change during paged source composition', async () => {
      await store
        .doc('importSources', 'one-source')
        .set(importSource('one-source', 'archive', now));
      let changed = false;
      const originalCollection = store.collection.bind(store);
      const wrapQuery = (query: object): object =>
        new Proxy(query, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (property === 'get' && typeof value === 'function') {
              return async (...args: unknown[]) => {
                const result = await value.apply(target, args);
                if (!changed) {
                  changed = true;
                  await store.doc('privacyErasureJobs', agentId).set({
                    agentId,
                    generation: 'complete-after-read',
                    status: 'complete',
                    counts: {
                      memories: 0,
                      graphRelations: 0,
                      writingSamples: 0,
                      securityIncidents: 0,
                    },
                  });
                }
                return result;
              };
            }
            if (typeof value === 'function')
              return (...args: unknown[]) => wrapQuery(value.apply(target, args));
            return value;
          },
        });
      store.collection = ((name: string) => {
        const collection = originalCollection(name);
        return name === 'importSources'
          ? (wrapQuery(collection) as ReturnType<InstallationStore['collection']>)
          : collection;
      }) as InstallationStore['collection'];

      await expect(repository.listPage({ limit: 10 })).rejects.toThrow(/changed during read/);
    });

    it('fails closed on a malformed owner source document key', async () => {
      await store
        .doc('importSources', 'wrong-key')
        .set(importSource('different-id', 'archive', now));
      await expect(repository.listPage({ limit: 10 })).rejects.toThrow(
        /Malformed or foreign import source/,
      );
    });

    it('continues beyond the former full-scan bound with stable source-key pages', async () => {
      const batch = store.db.batch();
      for (let index = 0; index < 51; index += 1) {
        const source = `archive-${String(index).padStart(3, '0')}`;
        const row = importSource(`source-${index}`, source, now);
        batch.set(store.doc('importSources', row.id), row);
      }
      await batch.commit();

      const first = await repository.listPage({ limit: 50 });
      expect(first.sources).toHaveLength(50);
      expect(first.sources[0]?.source).toBe('archive-000');
      expect(first.sources.at(-1)?.source).toBe('archive-049');
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe('archive-049');
      const second = await repository.listPage({
        afterSource: first.nextCursor ?? undefined,
        limit: 50,
      });
      expect(second.sources.map((row) => row.source)).toEqual(['archive-050']);
      expect(second.hasMore).toBe(false);
    });

    it('scopes tracked workspace path lookup to the configured owner', async () => {
      const owned = importSource('owned-source', 'owned', now);
      const foreign = importSource('foreign-source', 'foreign', now, otherAgentId);
      await store.doc('importSources', owned.id).set(owned);
      await store.doc('importSources', foreign.id).set(foreign);
      await expect(
        repository.trackedWorkspacePaths({
          workspacePaths: [owned.workspacePath, foreign.workspacePath],
        }),
      ).resolves.toEqual([owned.workspacePath]);
    });
  },
);
