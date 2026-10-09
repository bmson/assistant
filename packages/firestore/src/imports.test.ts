import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreImportCommandRepository, FirestoreImportJobRepository } from './imports.js';
import { wakeIntentId } from './outbox.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space = { provider: 'synthetic', model: 'fixture', dimensions: 1536, revision: '1' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore import source identity', () => {
  let store: InstallationStore;
  const agentId = randomUUID();

  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  function legacySource(id: string, source: string) {
    const now = new Date('2026-09-01T00:00:00Z');
    return store.doc('importSources', id).set(
      encodeRecord({
        id,
        agentId,
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
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  const start = {
    source: 'mail-2021',
    workspacePath: 'import/mail-2021.mbox',
    kind: 'mbox',
    job: 'import.run' as const,
    payload: {},
    budgetUsdLimit: '0.50',
  };

  it('adopts a source imported from PostgreSQL instead of creating a second one', async () => {
    const legacyId = randomUUID();
    await legacySource(legacyId, 'mail-2021');
    const commands = new FirestoreImportCommandRepository(store, agentId);
    const started = await commands.start(start);
    expect(started.sourceId).toBe(legacyId);
    const rows = await store.collection('importSources').where('source', '==', 'mail-2021').get();
    expect(rows.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({
        id: legacyId,
        status: 'pending',
        taskId: started.taskId,
        workspacePath: 'import/mail-2021.mbox',
        kind: 'mbox',
        itemsProcessed: 0,
      }),
    ]);
    await expect(commands.start(start)).rejects.toThrow('import "mail-2021" is already pending');
  });

  it('fails on a duplicated legacy source instead of guessing', async () => {
    await legacySource(randomUUID(), 'mail-2021');
    await legacySource(randomUUID(), 'mail-2021');
    await expect(new FirestoreImportCommandRepository(store, agentId).start(start)).rejects.toThrow(
      'Duplicate import source identity',
    );
  });

  it('restarts a purged source after completed deletion without changing its identity', async () => {
    const source = `completed-purge-${randomUUID().slice(0, 8)}`;
    const sourceId = randomUUID();
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const deletionId = createHash('sha256')
      .update(`import-delete\0${agentId}\0${source}`)
      .digest('hex');
    const now = new Date('2026-10-01T00:00:00Z');
    await store.doc('importSources', sourceId).set(
      encodeRecord({
        id: sourceId,
        agentId,
        source,
        workspacePath: `import/${source}.txt`,
        kind: 'text',
        status: 'purged',
        taskId: null,
        itemsTotal: 1,
        itemsProcessed: 1,
        memoriesSaved: 0,
        memoriesQuarantined: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await store
      .doc('importSourceKeys', createHash('sha256').update(`${agentId}\0${source}`).digest('hex'))
      .set({
        agentId,
        source,
        sourceId,
      });
    await store.doc('importSourceDeletionJobs', deletionId).set({
      id: deletionId,
      agentId,
      sourceHash,
      sourceId,
      mode: 'purge',
      purgedMemories: 1,
      status: 'complete',
      createdAt: now,
      updatedAt: now,
    });

    const started = await new FirestoreImportCommandRepository(store, agentId).start({
      ...start,
      source,
      workspacePath: `import/${source}.txt`,
    });

    expect(started.sourceId).toBe(sourceId);
    expect(started.taskId).not.toBe(sourceId);
    expect((await store.doc('importSources', sourceId).get()).data()).toMatchObject({
      id: sourceId,
      agentId,
      source,
      status: 'pending',
      taskId: started.taskId,
    });
    expect((await store.doc('importSourceDeletionJobs', deletionId).get()).exists).toBe(false);
    const wakeId = wakeIntentId(started.taskId, 0);
    expect((await store.doc('outbox', wakeId).get()).data()).toMatchObject({
      id: wakeId,
      taskId: started.taskId,
      generation: 0,
      status: 'pending',
    });
    expect(
      (await store.collection('outbox').where('taskId', '==', started.taskId).get()).size,
    ).toBe(1);
  });

  it('refuses job writes outside the configured owner or without the live lease', async () => {
    const commands = new FirestoreImportCommandRepository(store, agentId);
    const started = await commands.start(start);
    const fence = {
      agentId,
      source: 'mail-2021',
      taskId: started.taskId,
      queueGeneration: 0,
      leaseToken: randomUUID(),
    };
    // The task is pending, not running under this lease.
    expect(await new FirestoreImportJobRepository(store, agentId, space).load(fence)).toBeNull();
    expect(
      await new FirestoreImportJobRepository(store, randomUUID(), space).load(fence),
    ).toBeNull();
    await expect(
      new FirestoreImportCommandRepository(store, randomUUID()).start(start),
    ).rejects.toThrow('Imports require exactly one matching configured owner');
  });

  it('resumes bounded purge after interruption and retains archive plus snapshot assets', async () => {
    const source = `paged-purge-${randomUUID().slice(0, 8)}`;
    const sourceId = randomUUID();
    const taskId = randomUUID();
    const snapshotPath = `.assistant/imports/${source}/${taskId}/manifest.json`;
    await store.doc('importSources', sourceId).set(
      encodeRecord({
        id: sourceId,
        agentId,
        source,
        workspacePath: `import/${source}.txt`,
        kind: 'text',
        status: 'done',
        taskId: null,
        itemsTotal: 60,
        itemsProcessed: 60,
        memoriesSaved: 60,
        memoriesQuarantined: 0,
        error: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    const assetId = `${sourceId}-${createHash('sha256').update(snapshotPath).digest('hex')}`;
    await store.doc('importSnapshotAssets', assetId).set({
      id: assetId,
      agentId,
      source,
      taskId,
      workspacePath: snapshotPath,
    });
    const ids: string[] = Array.from({ length: 60 }, () => randomUUID()).sort();
    const predecessorId = randomUUID();
    await store.doc('memories', predecessorId).set({
      id: predecessorId,
      agentId,
      source: 'unrelated',
      contentHash: createHash('sha256').update(predecessorId).digest('hex'),
      content: 'Independent predecessor',
      category: 'knowledge',
      quarantined: false,
      expiresAt: new Date('2026-10-02T00:00:00Z'),
      supersededById: ids[0],
    });
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (!id) continue;
      const contentHash = createHash('sha256').update(`${source}:${index}`).digest('hex');
      await store.doc('memories', id).set({
        id,
        agentId,
        source: index === 0 ? source : null,
        contentHash,
        content: `Source ${source} fact ${index}`,
        category: 'knowledge',
        quarantined: false,
        supersededById: ids[index + 1] ?? null,
      });
      if (index === 0) {
        const lineageId = createHash('sha256')
          .update(JSON.stringify([source, id]))
          .digest('hex');
        await store.doc('memoryImportLineage', lineageId).set({
          id: lineageId,
          agentId,
          source,
          memoryId: id,
        });
      }
    }

    const transaction = store.db.runTransaction.bind(store.db);
    let transactions = 0;
    const interruptedDb = new Proxy(store.db, {
      get(target, property, receiver) {
        if (property === 'runTransaction')
          return (...args: Parameters<typeof store.db.runTransaction>) => {
            transactions += 1;
            if (transactions === 4) throw new Error('simulated Firestore purge interruption');
            return transaction(...args);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const interruptedStore = new Proxy(store, {
      get(target, property, receiver) {
        return property === 'db' ? interruptedDb : Reflect.get(target, property, receiver);
      },
    }) as InstallationStore;
    await expect(
      new FirestoreImportCommandRepository(interruptedStore, agentId).purge(source),
    ).rejects.toThrow('simulated Firestore purge interruption');
    expect((await store.doc('importSources', sourceId).get()).get('status')).toBe('purged');

    const blockedCommands = new FirestoreImportCommandRepository(store, agentId);
    await expect(
      blockedCommands.start({ ...start, source, workspacePath: `import/${source}.txt` }),
    ).rejects.toThrow(`import "${source}" is still being removed`);
    await expect(blockedCommands.remove(source)).rejects.toThrow(
      'Import source purge is still in progress',
    );

    const freshCommands = new FirestoreImportCommandRepository(store, agentId);
    await expect(freshCommands.purge(source)).resolves.toEqual({ agentId, purged: 60 });
    expect((await store.doc('importSources', sourceId).get()).get('workspacePath')).toBe(
      `import/${source}.txt`,
    );
    expect((await store.doc('importSnapshotAssets', assetId).get()).get('workspacePath')).toBe(
      snapshotPath,
    );
    expect((await store.collection('memories').where('source', '==', source).get()).empty).toBe(
      true,
    );
    const remainingLineage = await store
      .collection('memoryImportLineage')
      .where('source', '==', source)
      .get();
    expect(remainingLineage.empty).toBe(true);
    expect(
      (await store.collection('memories').where('agentId', '==', agentId).get()).docs.some((doc) =>
        ids.includes(doc.id),
      ),
    ).toBe(false);
    expect((await store.doc('memories', predecessorId).get()).data()).toMatchObject({
      supersededById: null,
      expiresAt: null,
    });
  }, 120_000);

  it('refuses to purge source-tagged memory owned by another agent', async () => {
    const source = `foreign-purge-${randomUUID().slice(0, 8)}`;
    const sourceId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignMemoryId = randomUUID();
    await store.doc('importSources', sourceId).set(
      encodeRecord({
        id: sourceId,
        agentId,
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
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    await store.doc('memories', foreignMemoryId).set({
      id: foreignMemoryId,
      agentId: foreignAgentId,
      source,
      contentHash: createHash('sha256').update(foreignMemoryId).digest('hex'),
      content: 'Foreign owner fact',
      category: 'knowledge',
      quarantined: false,
    });
    await expect(
      new FirestoreImportCommandRepository(store, agentId).purge(source),
    ).rejects.toThrow('Import source memory belongs to another agent');
    expect((await store.doc('memories', foreignMemoryId).get()).exists).toBe(true);
    expect((await store.doc('importSources', sourceId).get()).get('status')).toBe('purged');

    const lineageSource = `${source}-lineage`;
    const lineageSourceId = randomUUID();
    const linkedForeignMemoryId = randomUUID();
    await store.doc('importSources', lineageSourceId).set(
      encodeRecord({
        id: lineageSourceId,
        agentId,
        source: lineageSource,
        workspacePath: `import/${lineageSource}.txt`,
        kind: 'text',
        status: 'done',
        taskId: null,
        itemsTotal: 1,
        itemsProcessed: 1,
        memoriesSaved: 1,
        memoriesQuarantined: 0,
        error: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
    await store.doc('memories', linkedForeignMemoryId).set({
      id: linkedForeignMemoryId,
      agentId: foreignAgentId,
      source: null,
      contentHash: createHash('sha256').update(linkedForeignMemoryId).digest('hex'),
      content: 'Foreign owner lineage target',
      category: 'knowledge',
      quarantined: false,
    });
    const lineageId = createHash('sha256')
      .update(JSON.stringify([lineageSource, linkedForeignMemoryId]))
      .digest('hex');
    await store.doc('memoryImportLineage', lineageId).set({
      id: lineageId,
      agentId,
      source: lineageSource,
      memoryId: linkedForeignMemoryId,
    });
    await expect(
      new FirestoreImportCommandRepository(store, agentId).purge(lineageSource),
    ).rejects.toThrow('Import memory lineage points to another agent');
    expect((await store.doc('memories', linkedForeignMemoryId).get()).exists).toBe(true);
  });
});
