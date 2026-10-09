import { createHash, randomUUID } from 'node:crypto';
import { cardFormAdmissionActiveEventId } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreCardFormAdmissionRepository } from './card-form-admission.js';
import { inventoryFirestoreDatabase, type ManagedFirestoreRawClient } from './managed-backup.js';
import { documentKey, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const testProjectId = 'demo-assistant-test';
const snapshotTime = new Date('2026-10-08T12:00:00.000Z');

type TestStores = {
  source: InstallationStore;
  restored: InstallationStore;
  agentId: string;
  cardId: string;
  formId: string;
  revisionId: string;
  conversationId: string;
};

async function seedForm(
  source: InstallationStore,
  restored: InstallationStore,
): Promise<TestStores> {
  const agentId = randomUUID();
  const cardId = randomUUID();
  const formId = 'meeting';
  const revisionId = randomUUID();
  const conversationId = randomUUID();
  await source.doc('agents', agentId).set({ id: agentId, name: 'Backup fixture owner' });
  await source.doc('conversations', conversationId).set({
    id: conversationId,
    agentId,
    channel: 'chat',
    trust: 'owner',
    updatedAt: new Date(),
  });
  await source.doc('generatedCardRevisions', revisionId).set({
    id: revisionId,
    cardId,
    version: 1,
    spec: {
      blocks: [
        {
          type: 'form',
          id: formId,
          title: 'Meeting details',
          serverAction: 'submit_owner_chat_turn',
          submitLabel: 'Send',
          warningFactIds: [],
          fields: [{ id: 'date', type: 'date', label: 'Date', required: true, sensitive: false }],
        },
      ],
    },
  });
  await source.doc('generatedCards', cardId).set({
    id: cardId,
    agentId,
    conversationId,
    currentRevisionId: revisionId,
    status: 'active',
    expiresAt: null,
    dismissedAt: null,
  });
  return {
    source,
    restored,
    agentId,
    cardId,
    formId,
    revisionId,
    conversationId,
  };
}

async function copyCollectionTree(
  source: ReturnType<InstallationStore['collection']>,
  target: ReturnType<InstallationStore['collection']>,
): Promise<void> {
  const snapshot = await source.get();
  for (const document of snapshot.docs) {
    const destination = target.doc(document.id);
    await destination.set(document.data());
    for (const child of await document.ref.listCollections())
      await copyCollectionTree(child, destination.collection(child.id));
  }
}

/** Local emulator-only snapshot copy; this does not call managed export/import APIs. */
async function copyInstallation(
  source: InstallationStore,
  restored: InstallationStore,
): Promise<void> {
  for (const collection of await source.root.listCollections())
    await copyCollectionTree(collection, restored.root.collection(collection.id));
}

function submission(input: {
  agentId: string;
  cardId: string;
  conversationId: string;
  revisionId: string;
  formId: string;
  operationId?: string;
}) {
  return {
    protocol: 'card-form-v1',
    conversationId: input.conversationId,
    cardId: input.cardId,
    expectedRevisionId: input.revisionId,
    formId: input.formId,
    operationId: input.operationId ?? randomUUID(),
    values: { date: '2026-10-21' },
    ownerMessageText: 'Please check whether October 21 works for the meeting.',
  };
}

async function createPendingFormTask(stores: TestStores) {
  const repo = new FirestoreCardFormAdmissionRepository(stores.source, stores.agentId);
  const request = submission(stores);
  const result = await repo.submit({
    agentId: stores.agentId,
    submission: request,
    prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
  });
  if (!result.ok) throw new Error(`could not seed pending form task: ${result.error}`);
  return { repo, request, result };
}

function inventoryFixture(databaseId: string, installationId: string): ManagedFirestoreRawClient {
  const documentsRoot = `projects/${testProjectId}/databases/${databaseId}/documents`;
  const installationPath = `${documentsRoot}/installations/${documentKey(installationId)}`;
  const agentId = 'b4df2561-882f-4ecb-ae72-8336165213c7';
  const cardId = 'fbd91bfe-93a7-4a0a-ae0e-13591aee5e93';
  const formId = 'meeting';
  const operationId = '2dbaaf60-0e2c-48ec-bc6c-f170c54e6804';
  const taskId = 'd591d113-159e-4710-9669-6c9c49d0417d';
  const activeExternalId = cardFormAdmissionActiveEventId({ agentId, cardId, formId });
  const activeDocumentId = documentKey(createHash('sha256').update(activeExternalId).digest('hex'));
  const timestamp = { seconds: 1_791_460_800, nanos: 0 };
  const installationDocument = {
    name: installationPath,
    createTime: timestamp,
    fields: { id: { stringValue: installationId } },
  };
  const taskDocument = {
    name: `${installationPath}/tasks/${documentKey(taskId)}`,
    createTime: timestamp,
    fields: {
      id: { stringValue: taskId },
      agentId: { stringValue: agentId },
      status: { stringValue: 'pending' },
      cardFormAdmission: {
        mapValue: { fields: { cardId: { stringValue: cardId }, formId: { stringValue: formId } } },
      },
    },
  };
  const guardDocument = {
    name: `${installationPath}/taskEventKeys/${activeDocumentId}`,
    createTime: timestamp,
    fields: {
      taskId: { stringValue: taskId },
      agentId: { stringValue: agentId },
      cardId: { stringValue: cardId },
      formId: { stringValue: formId },
      operationId: { stringValue: operationId },
    },
  };
  return {
    listCollectionIds: vi.fn<ManagedFirestoreRawClient['listCollectionIds']>(async ({ parent }) => {
      if (parent === documentsRoot) return [['installations']];
      if (parent === installationPath) return [['tasks', 'taskEventKeys']];
      return [[]];
    }),
    listDocuments: vi.fn<ManagedFirestoreRawClient['listDocuments']>(
      async ({ parent, collectionId }) => {
        if (parent === documentsRoot && collectionId === 'installations')
          return [[installationDocument]];
        if (parent === installationPath && collectionId === 'tasks') return [[taskDocument]];
        if (parent === installationPath && collectionId === 'taskEventKeys')
          return [[guardDocument]];
        return [[]];
      },
    ),
  };
}

describe('local managed-backup inventory and restored card-form guard', () => {
  it('includes the active task and guard pair in equal source and copied-snapshot inventories', async () => {
    const sourceIdentity = {
      projectId: testProjectId,
      databaseId: 'source-fixture',
      installationId: 'inventory-fixture',
    };
    const restoredIdentity = { ...sourceIdentity, databaseId: 'restored-fixture' };
    const sourceRaw = inventoryFixture(sourceIdentity.databaseId, sourceIdentity.installationId);
    const restoredRaw = inventoryFixture(
      restoredIdentity.databaseId,
      restoredIdentity.installationId,
    );
    const source = await inventoryFirestoreDatabase(sourceRaw, sourceIdentity, snapshotTime);
    const restored = await inventoryFirestoreDatabase(restoredRaw, restoredIdentity, snapshotTime);
    expect(source).toMatchObject({
      documents: 3,
      collections: {
        [`installations/${documentKey(sourceIdentity.installationId)}/tasks`]: 1,
        [`installations/${documentKey(sourceIdentity.installationId)}/taskEventKeys`]: 1,
      },
      installationRoots: [`installations/${documentKey(sourceIdentity.installationId)}`],
      outOfScopeDocuments: 0,
      externalReferences: 0,
    });
    expect(restored.canonicalHash).toBe(source.canonicalHash);
    expect(restored.collections).toEqual(source.collections);
    expect(sourceRaw.listDocuments).toHaveBeenCalled();
    expect(restoredRaw.listDocuments).toHaveBeenCalled();
  });

  it.skipIf(!emulatorEnabled)(
    'copies a pending form receipt and guard, blocks a duplicate operation, then releases only after terminal status',
    async () => {
      const source = emulatorStore();
      let restored: InstallationStore | undefined;
      try {
        restored = emulatorStore();
        const seeded = await seedForm(source, restored);
        const { request, result } = await createPendingFormTask(seeded);
        await copyInstallation(source, restored);

        const activeId = createHash('sha256')
          .update(
            cardFormAdmissionActiveEventId({
              agentId: seeded.agentId,
              cardId: seeded.cardId,
              formId: seeded.formId,
            }),
          )
          .digest('hex');
        expect((await restored.doc('taskEventKeys', activeId).get()).data()).toMatchObject({
          taskId: result.taskId,
          agentId: seeded.agentId,
          cardId: seeded.cardId,
          formId: seeded.formId,
          operationId: request.operationId,
        });
        expect((await restored.doc('tasks', result.taskId).get()).get('trigger')).toMatchObject({
          payload: {
            cardFormAdmission: {
              operationId: request.operationId,
              expectedRevisionId: seeded.revisionId,
            },
          },
        });

        const repo = new FirestoreCardFormAdmissionRepository(restored, seeded.agentId);
        const replay = await repo.submit({
          agentId: seeded.agentId,
          submission: request,
          prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
        });
        expect(replay).toMatchObject({
          ok: true,
          created: false,
          taskId: result.taskId,
          messageId: result.messageId,
        });
        const blocked = await repo.submit({
          agentId: seeded.agentId,
          submission: {
            ...request,
            operationId: randomUUID(),
            ownerMessageText: 'Please check the next date.',
          },
          prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
        });
        expect(blocked).toMatchObject({
          ok: false,
          status: 409,
          reason: 'active_form',
          activeTaskId: result.taskId,
          taskStatus: 'pending',
        });
        expect((await restored.collection('tasks').get()).size).toBe(1);
        expect((await restored.collection('messages').get()).size).toBe(1);
        expect((await restored.collection('outbox').get()).size).toBe(1);

        await restored.doc('tasks', result.taskId).update({ status: 'done' });
        const replacementOperationId = randomUUID();
        const accepted = await repo.submit({
          agentId: seeded.agentId,
          submission: {
            ...request,
            operationId: replacementOperationId,
            ownerMessageText: 'Please check the next date.',
          },
          prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
        });
        expect(accepted).toMatchObject({ ok: true, created: true });
        if (!accepted.ok) throw new Error('terminal form task failed to release guard');
        expect((await restored.doc('taskEventKeys', activeId).get()).data()).toMatchObject({
          taskId: accepted.taskId,
          operationId: replacementOperationId,
        });
        expect(accepted.taskId).not.toBe(result.taskId);
        expect((await restored.collection('tasks').get()).size).toBe(2);
        expect((await restored.collection('messages').get()).size).toBe(2);
      } finally {
        await Promise.all([disposeStore(source), ...(restored ? [disposeStore(restored)] : [])]);
      }
    },
  );

  it.skipIf(!emulatorEnabled)(
    'fails closed when a copied active-form guard is malformed or orphaned',
    async () => {
      const source = emulatorStore();
      let restored: InstallationStore | undefined;
      try {
        restored = emulatorStore();
        const seeded = await seedForm(source, restored);
        const { request, result } = await createPendingFormTask(seeded);
        await copyInstallation(source, restored);
        const activeId = createHash('sha256')
          .update(
            cardFormAdmissionActiveEventId({
              agentId: seeded.agentId,
              cardId: seeded.cardId,
              formId: seeded.formId,
            }),
          )
          .digest('hex');
        const before = {
          tasks: (await restored.collection('tasks').get()).size,
          messages: (await restored.collection('messages').get()).size,
          outbox: (await restored.collection('outbox').get()).size,
        };
        const repo = new FirestoreCardFormAdmissionRepository(restored, seeded.agentId);
        await restored.doc('taskEventKeys', activeId).update({ agentId: randomUUID() });
        await expect(
          repo.submit({
            agentId: seeded.agentId,
            submission: { ...request, operationId: randomUUID() },
            prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
          }),
        ).rejects.toThrow('Card form active-operation identity collision');
        await restored
          .doc('taskEventKeys', activeId)
          .update({ agentId: seeded.agentId, taskId: randomUUID() });
        await expect(
          repo.submit({
            agentId: seeded.agentId,
            submission: { ...request, operationId: randomUUID() },
            prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
          }),
        ).rejects.toThrow('Card form active-operation index points to a missing task');
        expect((await restored.collection('tasks').get()).size).toBe(before.tasks);
        expect((await restored.collection('messages').get()).size).toBe(before.messages);
        expect((await restored.collection('outbox').get()).size).toBe(before.outbox);
        expect((await restored.doc('tasks', result.taskId).get()).get('status')).toBe('pending');
      } finally {
        await Promise.all([disposeStore(source), ...(restored ? [disposeStore(restored)] : [])]);
      }
    },
  );
});
