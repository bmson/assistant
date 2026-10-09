import { createHash, randomUUID } from 'node:crypto';
import {
  cardFormAdmissionActiveEventId,
  cardFormAdmissionExternalEventId,
  checksum,
  checksumV3,
  compositeMigrationId,
  deterministicMigrationCompare,
  embeddingSpaceIdentityKey,
  idempotencyIdentityDigest,
  MIGRATION_TABLES,
  type MigrationBundle,
  type MigrationRecord,
  modelToolCallIdentityDigest,
  serializeMigrationTimestamp,
  serializeMigrationValue,
  serializeMigrationVector,
  toolCallReceiptKeyId,
} from '@assistant/persistence';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreCardFormAdmissionRepository } from './card-form-admission.js';
import { FirestoreMemoryEmbeddingRefreshRepository } from './memory-embedding-refresh.js';
import { FirestoreProfileMemoryMaintenance } from './profile-memory-maintenance.js';
import { FirestoreScheduleRepository } from './schedules.js';
import { decodeRecord } from './store.js';
import { FirestoreTaskLeaseRepository } from './tasks.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { activateWorkspaceBundle, importWorkspaceBundle } from './workspace-migration.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function bundle(target: MigrationBundle['manifest']['target'], taskCount = 1): MigrationBundle {
  const agentId = randomUUID();
  const agentData = {
    id: agentId,
    name: 'Imported owner',
    email: 'owner@example.test',
    workspacePrefix: 'workspace/test',
  };
  const records: MigrationRecord[] = [
    {
      table: 'agents',
      collection: 'agents',
      id: agentId,
      data: agentData,
      checksum: checksum(agentData),
    },
  ];
  for (let index = 0; index < taskCount; index++) {
    const id = randomUUID();
    const data = {
      id,
      agentId,
      type: 'adhoc',
      status: 'pending',
      trigger: {},
      state: {},
      trust: 'owner',
    };
    records.push({ table: 'tasks', collection: 'tasks', id, data, checksum: checksum(data) });
  }
  const ordered = [...records].sort((a, b) =>
    `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`),
  );
  return {
    manifest: {
      format: 'assistant-workspace-migration',
      formatVersion: 1,
      mode: 'export',
      source: { kind: 'postgresql', agentId, scope: 'installation', snapshot: '1-1-1' },
      target,
      tables: {
        agents: { collection: 'agents', count: 1, checksum: checksum([records[0]]) },
        tasks: {
          collection: 'tasks',
          count: taskCount,
          checksum: checksum(
            records
              .slice(1)
              .sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`)),
          ),
        },
      } as MigrationBundle['manifest']['tables'],
      coverage: {
        complete: false,
        supportedTables: ['agents', 'tasks'],
        omittedTables: ['remaining PostgreSQL tables'],
      },
      recordCount: records.length,
      bundleChecksum: checksum(ordered),
      unsupportedTables: [],
    },
    records,
  };
}

function addRecord(source: MigrationBundle, record: MigrationRecord): void {
  record.checksum = checksum(record.data);
  source.records.push(record);
  source.records.sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
  const records = source.records.filter((candidate) => candidate.table === record.table);
  source.manifest.tables[record.table] = {
    collection: record.collection,
    count: records.length,
    checksum: checksum(records),
  };
  source.manifest.coverage.supportedTables = Object.keys(
    source.manifest.tables,
  ) as MigrationBundle['manifest']['coverage']['supportedTables'];
  source.manifest.recordCount = source.records.length;
  source.manifest.bundleChecksum = checksum(source.records);
}

function refreshRecord(source: MigrationBundle, record: MigrationRecord): void {
  record.checksum = checksum(record.data);
  source.records.sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
  const records = source.records.filter((candidate) => candidate.table === record.table);
  const summary = source.manifest.tables[record.table];
  if (!summary) throw new Error('fixture summary missing');
  summary.checksum = checksum(records);
  source.manifest.bundleChecksum = checksum(source.records);
}

function addApproval(source: MigrationBundle, shortCode: string): void {
  const taskId = source.records.find((record) => record.table === 'tasks')?.id;
  if (!taskId) throw new Error('fixture task missing');
  const approvalId = randomUUID();
  const toolCallId = randomUUID();
  addRecord(source, {
    table: 'tool_calls',
    collection: 'toolCalls',
    id: toolCallId,
    data: { id: toolCallId, taskId, approvalId },
    checksum: '',
  });
  addRecord(source, {
    table: 'approvals',
    collection: 'approvals',
    id: approvalId,
    data: { id: approvalId, taskId, toolCallId, shortCode },
    checksum: '',
  });
}

function addGraphSource(source: MigrationBundle): string {
  const agentId = source.manifest.source.agentId;
  const memoryId = randomUUID();
  addRecord(source, {
    table: 'memories',
    collection: 'memories',
    id: memoryId,
    data: {
      id: memoryId,
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: 'Graph source migration fixture',
      contentHash: randomUUID(),
    },
    checksum: '',
  });
  addRecord(source, {
    table: 'knowledge_graph_sources',
    collection: 'knowledgeGraphSources',
    id: memoryId,
    data: {
      memoryId,
      contentHash: randomUUID(),
      status: 'quarantined',
      extractionVersion: 1,
      nextRetryAt: null,
      attempts: 1,
      lastError: 'owner review required',
    },
    checksum: '',
  });
  return memoryId;
}

function upgradeFixtureToV3(source: MigrationBundle): void {
  source.manifest.formatVersion = 3;
  for (const record of source.records) record.checksum = checksumV3(record.data);
  source.records.sort((left, right) =>
    deterministicMigrationCompare(`${left.table}:${left.id}`, `${right.table}:${right.id}`),
  );
  for (const [table, summary] of Object.entries(source.manifest.tables)) {
    const records = source.records.filter((record) => record.table === table);
    summary.checksum = checksumV3(records);
  }
  source.manifest.bundleChecksum = checksumV3(source.records);
}

function completeV3Bundle(target: MigrationBundle['manifest']['target']): MigrationBundle {
  const source = bundle(target);
  const agent = source.records.find((record) => record.table === 'agents');
  const task = source.records.find((record) => record.table === 'tasks');
  if (!agent || !task) throw new Error('test owner/task missing');
  source.manifest.formatVersion = 3;
  source.manifest.source.exportedAt = '2026-09-23T06:30:00.000000Z';
  source.manifest.tables = Object.fromEntries(
    MIGRATION_TABLES.map(({ table, collection }) => [
      table,
      { collection, count: 0, checksum: checksumV3([]) },
    ]),
  ) as MigrationBundle['manifest']['tables'];
  agent.checksum = checksumV3(agent.data);
  source.manifest.tables.agents = {
    collection: 'agents',
    count: 1,
    checksum: checksumV3([agent]),
  };
  task.checksum = checksumV3(task.data);
  source.manifest.tables.tasks = {
    collection: 'tasks',
    count: 1,
    checksum: checksumV3([task]),
  };
  source.manifest.coverage = {
    complete: true,
    supportedTables: MIGRATION_TABLES.map(({ table }) => table),
    omittedTables: [],
  };
  source.manifest.recordCount = source.records.length;
  source.manifest.bundleChecksum = checksumV3(source.records);
  return source;
}

function cardFormBundle(
  target: MigrationBundle['manifest']['target'],
  taskCount = 1,
  status = 'pending',
  malformedBinding = false,
): {
  source: MigrationBundle;
  submission: Record<string, unknown>;
  cardId: string;
  revisionId: string;
  conversationId: string;
  messageId: string;
} {
  const source = bundle(target, taskCount);
  const agentId = source.manifest.source.agentId;
  const conversationId = randomUUID();
  const cardId = randomUUID();
  const taskRevisionId = randomUUID();
  const revisionId = randomUUID();
  const form = {
    type: 'form',
    id: 'meeting',
    title: 'Meeting details',
    serverAction: 'submit_owner_chat_turn',
    submitLabel: 'Send',
    warningFactIds: [],
    fields: [{ id: 'date', type: 'date', label: 'Date', required: true, sensitive: false }],
  };
  const text = 'Please check whether this meeting date works.';
  addRecord(source, {
    table: 'conversations',
    collection: 'conversations',
    id: conversationId,
    data: { id: conversationId, agentId, channel: 'chat', trust: 'owner' },
    checksum: '',
  });
  addRecord(source, {
    table: 'generated_cards',
    collection: 'generatedCards',
    id: cardId,
    data: {
      id: cardId,
      agentId,
      conversationId,
      messageId: 'pending',
      currentRevisionId: revisionId,
      status: 'active',
      expiresAt: null,
      dismissedAt: null,
    },
    checksum: '',
  });
  addRecord(source, {
    table: 'generated_card_revisions',
    collection: 'generatedCardRevisions',
    id: taskRevisionId,
    data: { id: taskRevisionId, cardId, version: 1, spec: { blocks: [form] } },
    checksum: '',
  });
  addRecord(source, {
    table: 'generated_card_revisions',
    collection: 'generatedCardRevisions',
    id: revisionId,
    data: { id: revisionId, cardId, version: 2, spec: { blocks: [form] } },
    checksum: '',
  });
  let firstMessageId = '';
  const tasks = source.records.filter((record) => record.table === 'tasks');
  for (const [index, record] of tasks.entries()) {
    const operationId = randomUUID();
    const messageId = randomUUID();
    if (index === 0) firstMessageId = messageId;
    const binding = {
      protocol: 'card-form-v1',
      operationId,
      cardId: malformedBinding && index === 0 ? randomUUID() : cardId,
      expectedRevisionId: taskRevisionId,
      conversationId,
      formId: 'meeting',
      payloadDigest: 'a'.repeat(64),
      messageId,
    };
    record.data = {
      ...record.data,
      type: 'chat_turn',
      status,
      trust: 'owner',
      conversationId,
      externalEventId: cardFormAdmissionExternalEventId({ agentId, operationId }),
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: {
          text,
          triggerMessageId: messageId,
          clientOperationId: operationId,
          chatAdmission: {
            protocol: 'owner-chat-v1',
            clientOperationId: operationId,
            requestHash: binding.payloadDigest,
            triggerMessageId: messageId,
            phase: 'queued',
            triageOutcome: 'actionable',
          },
          cardFormAdmission: binding,
        },
      },
    };
    addRecord(source, {
      table: 'messages',
      collection: 'messages',
      id: messageId,
      data: {
        id: messageId,
        taskId: record.id,
        conversationId,
        role: 'user',
        origin: 'owner',
        text,
      },
      checksum: '',
    });
  }
  const card = source.records.find(
    (record) => record.table === 'generated_cards' && record.id === cardId,
  );
  if (!card) throw new Error('test card missing');
  card.data.messageId = firstMessageId;
  upgradeFixtureToV3(source);
  const firstTask = tasks[0];
  const trigger = firstTask?.data.trigger as
    | { payload?: { cardFormAdmission?: { operationId?: string } } }
    | undefined;
  const operationId = trigger?.payload?.cardFormAdmission?.operationId;
  if (!operationId) throw new Error('test task operation missing');
  return {
    source,
    submission: {
      protocol: 'card-form-v1',
      conversationId,
      cardId,
      expectedRevisionId: revisionId,
      formId: 'meeting',
      operationId,
      values: { date: '2026-10-10' },
      ownerMessageText: text,
    },
    cardId,
    revisionId,
    conversationId,
    messageId: firstMessageId,
  };
}

describe('Firestore migration preview', () => {
  const target = {
    projectId: 'demo-assistant-test',
    databaseId: '(default)',
    installationId: 'preview',
  };
  const previewStore = {} as Parameters<typeof importWorkspaceBundle>[0];

  it.skipIf(!enabled)(
    'round-trips active call identity and private-data-free compact receipts',
    async () => {
      const store = emulatorStore();
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: store.installationId,
      };
      try {
        const source = completeV3Bundle(target);
        const agentId = source.manifest.source.agentId;
        const task = source.records.find((record) => record.table === 'tasks');
        if (!task) throw new Error('migration task missing');
        const activeCallId = randomUUID();
        const compactCallId = randomUUID();
        const modelToolCallId = 'private-model-call-identity';
        const idempotencyKey = 'private-idempotency-key';
        const modelHash = modelToolCallIdentityDigest(agentId, task.id, modelToolCallId);
        const idempotencyHash = idempotencyIdentityDigest(idempotencyKey);
        if (!modelHash || !idempotencyHash) throw new Error('invalid replay identity fixture');
        addRecord(source, {
          table: 'tool_calls',
          collection: 'toolCalls',
          id: activeCallId,
          data: {
            id: activeCallId,
            taskId: task.id,
            step: 1,
            toolName: 'gmail.send',
            args: { to: 'private@example.test', body: 'private full-call body' },
            risk: 'approval',
            status: 'approved',
            idempotencyKey,
            decision: { modelToolCallId, privateContext: 'active only' },
          },
          checksum: '',
        });
        addRecord(source, {
          table: 'tool_call_receipts',
          collection: 'toolCallReceipts',
          id: compactCallId,
          data: {
            id: compactCallId,
            agentId,
            taskId: 'pruned-task',
            toolCallId: compactCallId,
            modelToolCallIdHash: modelHash,
            idempotencyKeyHash: idempotencyHash,
            toolName: 'gmail.send',
            effectOutcome: 'unknown',
            recordedAt: serializeMigrationTimestamp('2026-10-07 12:00:00+00'),
          },
          checksum: '',
        });
        for (const [kind, digest] of [
          ['model_tool_call', modelHash],
          ['idempotency', idempotencyHash],
        ] as const) {
          addRecord(source, {
            table: 'tool_call_receipt_keys',
            collection: 'toolCallReceiptKeys',
            id: toolCallReceiptKeyId(kind, digest),
            data: {
              id: toolCallReceiptKeyId(kind, digest),
              agentId,
              taskId: 'pruned-task',
              receiptId: compactCallId,
              kind,
              digest,
            },
            checksum: '',
          });
        }
        const failedId = randomUUID();
        const completedId = randomUUID();
        for (const [id, effectOutcome] of [
          [failedId, 'failed'],
          [completedId, 'completed'],
        ] as const) {
          addRecord(source, {
            table: 'tool_call_receipts',
            collection: 'toolCallReceipts',
            id,
            data: {
              id,
              agentId,
              taskId: 'pruned-task',
              toolCallId: id,
              modelToolCallIdHash: null,
              idempotencyKeyHash: null,
              toolName: 'gmail.send',
              effectOutcome,
              recordedAt: serializeMigrationTimestamp('2026-10-07 12:00:00+00'),
            },
            checksum: '',
          });
        }

        const imported = await importWorkspaceBundle(store, source, {
          sourceAgentId: agentId,
          target,
          mode: 'write',
        });
        expect(imported.verified).toBe(true);
        expect((await store.doc('toolCalls', activeCallId).get()).data()).toMatchObject({
          args: { to: 'private@example.test', body: 'private full-call body' },
          idempotencyKey,
          decision: { modelToolCallId, privateContext: 'active only' },
        });
        const compact = (await store.doc('toolCallReceipts', compactCallId).get()).data();
        expect(compact).toMatchObject({
          agentId,
          taskId: 'pruned-task',
          modelToolCallIdHash: modelHash,
          idempotencyKeyHash: idempotencyHash,
          effectOutcome: 'unknown',
        });
        expect(compact).not.toHaveProperty('args');
        expect(compact).not.toHaveProperty('result');
        expect(compact).not.toHaveProperty('error');
        expect(compact).not.toHaveProperty('modelToolCallId');
        expect(compact).not.toHaveProperty('idempotencyKey');
        expect(
          (
            await store
              .doc('toolCallReceiptKeys', toolCallReceiptKeyId('model_tool_call', modelHash))
              .get()
          ).exists,
        ).toBe(true);
        expect(
          (
            await store
              .doc('toolCallReceiptKeys', toolCallReceiptKeyId('idempotency', idempotencyHash))
              .get()
          ).exists,
        ).toBe(true);
        expect((await store.doc('toolCallReceipts', failedId).get()).get('effectOutcome')).toBe(
          'failed',
        );
        expect((await store.doc('toolCallReceipts', completedId).get()).get('effectOutcome')).toBe(
          'completed',
        );

        const dangling = structuredClone(source);
        const danglingKey = dangling.records.find(
          (record) => record.table === 'tool_call_receipt_keys',
        );
        if (!danglingKey) throw new Error('receipt key fixture missing');
        danglingKey.data.receiptId = randomUUID();
        refreshRecord(dangling, danglingKey);
        await expect(
          importWorkspaceBundle(store, dangling, {
            sourceAgentId: agentId,
            target,
            mode: 'preview',
          }),
        ).rejects.toThrow('Invalid compact tool-call receipt key');
      } finally {
        await disposeStore(store);
      }
    },
  );

  it('previews a deterministic v3 bundle with Unicode data', async () => {
    const source = bundle(target);
    const owner = source.records[0];
    if (!owner) throw new Error('fixture owner missing');
    owner.data.äther = { é: true, e: false };
    upgradeFixtureToV3(source);
    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).resolves.toMatchObject({ mode: 'preview', records: 2 });
  });

  it('accepts historical approval suffix variants and repeated numeric prefixes', async () => {
    const source = bundle(target);
    for (const shortCode of ['A7', 'A7AA', 'A7-later-format']) addApproval(source, shortCode);

    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).resolves.toMatchObject({ mode: 'preview', records: 8 });
  });

  it('rejects an approval code without PostgreSQL allocator digits', async () => {
    const source = bundle(target);
    addApproval(source, 'A-legacy');

    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).rejects.toThrow('Malformed historical approval code');
  });

  it('previews nested arrays through the reversible Firestore codec', async () => {
    const source = bundle(target);
    const owner = source.records[0];
    if (!owner) throw new Error('fixture owner missing');
    owner.data.unsupported = [[1]];
    refreshRecord(source, owner);
    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).resolves.toMatchObject({ mode: 'preview', records: 2 });
  });

  it('rejects an oversize inline document before attempting a destination write', async () => {
    const source = bundle(target);
    const owner = source.records[0];
    if (!owner) throw new Error('fixture owner missing');
    owner.data.unsupported = 'x'.repeat(900_001);
    refreshRecord(source, owner);
    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).rejects.toThrow('exceeds safe Firestore inline size');
  });

  it('previews bounded byte/count batches with nested Unicode and vector payloads', async () => {
    const source = bundle(target, 500);
    source.manifest.source.embeddingSpace = {
      provider: 'synthetic',
      model: 'migration-packing-fixture',
      dimensions: 1536,
      revision: '1',
    };
    const tasks = source.records
      .filter((record) => record.table === 'tasks')
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const [index, task] of tasks.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      task.id = id;
      task.data.id = id;
      task.data.state = {
        nested: {
          labels: ['ferry 🛳️', 'Reykjavík café'],
          note: index % 5 === 0 ? 'é'.repeat(70_000) : `small-${index}`,
          numeric: [1, 2, 3, 4],
        },
      };
    }
    const memoryId = '00000000-0000-4000-8000-999999999999';
    addRecord(source, {
      table: 'memories',
      collection: 'memories',
      id: memoryId,
      data: {
        id: memoryId,
        agentId: source.manifest.source.agentId,
        content: 'Vector packing fixture',
        contentHash: 'vector-packing-fixture',
        embedding: serializeMigrationVector(
          Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
        ),
      },
      checksum: '',
    });
    upgradeFixtureToV3(source);

    const preview = await importWorkspaceBundle(previewStore, source, {
      sourceAgentId: source.manifest.source.agentId,
      target,
    });
    expect(preview.writeBatches).toBeGreaterThan(1);
    expect(preview.maxBatchBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(preview.maxBatchWrites).toBeLessThanOrEqual(450);
    expect(preview.maxBatchWrites).toBeGreaterThan(1);
  });
});

describe.skipIf(!enabled)('Firestore workspace migration import', () => {
  it('refuses a foreign installation owner before writing or verifying the destination', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    const source = bundle(target);
    const foreign = randomUUID();
    try {
      await store.doc('agents', foreign).set({ id: foreign, name: 'Existing foreign owner' });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'preview',
        }),
      ).resolves.toMatchObject({ mode: 'preview', destinationOwnerChecked: false });
      for (const mode of ['write', 'verify'] as const) {
        await expect(
          importWorkspaceBundle(store, source, {
            sourceAgentId: source.manifest.source.agentId,
            target,
            mode,
          }),
        ).rejects.toThrow('exactly one owner');
      }
      expect((await store.collection('tasks').get()).empty).toBe(true);
      expect((await store.collection('agents').get()).docs.map((doc) => doc.get('id'))).toEqual([
        foreign,
      ]);
    } finally {
      await disposeStore(store);
    }
  });
  it('derives v3 approval policy keys with runtime code-unit ordering', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const policyId = randomUUID();
      const policy = {
        id: policyId,
        agentId: source.manifest.source.agentId,
        toolName: 'unicode.tool',
        templateKey: 'unicode',
        effect: 'allow',
        match: { z: true, ä: { é: 1, e: 2 } },
      };
      addRecord(source, {
        table: 'approval_policies',
        collection: 'approvalPolicies',
        id: policyId,
        data: policy,
        checksum: '',
      });
      upgradeFixtureToV3(source);
      const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
        throw new Error('locale-dependent policy ordering used');
      });
      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      localeCompare.mockRestore();
      expect(result.verified).toBe(true);
      const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .sort(([left], [right]) => deterministicMigrationCompare(left, right))
              .map(([key, item]) => [key, canonical(item)]),
          );
        return value;
      };
      const requested = {
        agentId: policy.agentId,
        toolName: policy.toolName,
        templateKey: policy.templateKey,
        effect: policy.effect,
        match: policy.match,
      };
      const expectedKey = createHash('sha256')
        .update(JSON.stringify(canonical(requested)))
        .digest('hex');
      expect((await store.doc('approvalPolicyKeys', expectedKey).get()).get('policyId')).toBe(
        policyId,
      );
    } finally {
      vi.restoreAllMocks();
      await disposeStore(store);
    }
  });

  it('imports without outbox work and keeps tasks gated until activation', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const owner = source.records.find((record) => record.table === 'agents');
      if (!owner) throw new Error('fixture owner missing');
      owner.data.createdAt = serializeMigrationValue(new Date('2026-09-12T12:34:56.789Z'));
      refreshRecord(source, owner);
      const preview = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      });
      expect(preview.mode).toBe('preview');
      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(result.writes).toBe(4); // agent, task, budget-holds compatibility row, marker
      expect(result.verified).toBe(true);
      const verified = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'verify',
      });
      expect(verified.verified).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
      const task = source.records.find((record) => record.table === 'tasks');
      if (!task) throw new Error('test task missing');
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('pending');
      expect(await new FirestoreTaskLeaseRepository(store).claim(task.id)).toBeNull();
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
      ).rejects.toThrow('not empty');
    } finally {
      await disposeStore(store);
    }
  });

  it.skipIf(!enabled)(
    'rebuilds the active form guard for a migrated nonterminal owner chat task',
    async () => {
      const store = emulatorStore();
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: store.installationId,
      };
      try {
        const fixture = cardFormBundle(target);
        const result = await importWorkspaceBundle(store, fixture.source, {
          sourceAgentId: fixture.source.manifest.source.agentId,
          target,
          mode: 'write',
        });
        expect(result.verified).toBe(true);
        expect(result.collections.taskEventKeys).toBe(2);
        const activeEventId = cardFormAdmissionActiveEventId({
          agentId: fixture.source.manifest.source.agentId,
          cardId: fixture.cardId,
          formId: 'meeting',
        });
        const activeKeyId = createHash('sha256').update(activeEventId).digest('hex');
        expect((await store.doc('taskEventKeys', activeKeyId).get()).data()).toMatchObject({
          taskId: fixture.source.records.find((record) => record.table === 'tasks')?.id,
          agentId: fixture.source.manifest.source.agentId,
          cardId: fixture.cardId,
          formId: 'meeting',
        });
        const initialTaskRecord = fixture.source.records.find((record) => record.table === 'tasks');
        if (!initialTaskRecord) throw new Error('form task fixture missing');
        const importedTaskSnapshot = await store.doc('tasks', initialTaskRecord.id).get();
        const importedTrigger = importedTaskSnapshot.get('trigger') as {
          payload?: { cardFormAdmission?: { expectedRevisionId?: string } };
        };
        const currentCard = await store.doc('generatedCards', fixture.cardId).get();
        expect(currentCard.get('currentRevisionId')).toBe(fixture.revisionId);
        const pinnedRevisionId = importedTrigger.payload?.cardFormAdmission?.expectedRevisionId;
        expect(pinnedRevisionId).not.toBe(fixture.revisionId);
        expect(
          fixture.source.records.some(
            (record) =>
              record.table === 'generated_card_revisions' && record.id === pinnedRevisionId,
          ),
        ).toBe(true);
        expect(importedTrigger.payload?.cardFormAdmission?.expectedRevisionId).toBe(
          fixture.source.records.find(
            (record) =>
              record.table === 'generated_card_revisions' && record.id !== fixture.revisionId,
          )?.id,
        );
        const repository = new FirestoreCardFormAdmissionRepository(
          store,
          fixture.source.manifest.source.agentId,
        );
        const duplicate = await repository.submit({
          agentId: fixture.source.manifest.source.agentId,
          submission: {
            ...fixture.submission,
            operationId: randomUUID(),
            ownerMessageText: 'Please check another date.',
          },
          prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
        });
        expect(duplicate).toMatchObject({ ok: false, status: 409 });
        expect(
          (
            await store
              .collection('tasks')
              .where('agentId', '==', fixture.source.manifest.source.agentId)
              .get()
          ).size,
        ).toBe(1);
        const importedTask = fixture.source.records.find((record) => record.table === 'tasks');
        if (!importedTask) throw new Error('form task fixture missing');
        expect(
          (await store.collection('messages').where('taskId', '==', importedTask.id).get()).size,
        ).toBe(1);

        await store.doc('tasks', importedTask.id).update({ status: 'done' });
        const replacementOperationId = randomUUID();
        const replacement = await repository.submit({
          agentId: fixture.source.manifest.source.agentId,
          submission: {
            ...fixture.submission,
            operationId: replacementOperationId,
            ownerMessageText: 'Please check the updated meeting date.',
          },
          prepare: ({ ownerMessageText }) => ({ ownerMessageText }),
        });
        expect(replacement).toMatchObject({ ok: true, created: true });
        if (!replacement.ok) throw new Error('terminal task should release its form guard');
        const replacementGuard = (await store.doc('taskEventKeys', activeKeyId).get()).data();
        expect(replacementGuard).toMatchObject({
          taskId: replacement.taskId,
          operationId: replacementOperationId,
          agentId: fixture.source.manifest.source.agentId,
          cardId: fixture.cardId,
          formId: 'meeting',
        });
        expect(replacement.taskId).not.toBe(importedTask.id);
        expect(
          (
            await store
              .collection('tasks')
              .where('agentId', '==', fixture.source.manifest.source.agentId)
              .get()
          ).size,
        ).toBe(2);
        expect(
          (
            await store
              .collection('messages')
              .where('conversationId', '==', fixture.conversationId)
              .get()
          ).size,
        ).toBe(2);
        expect((await store.doc('generatedCardRevisions', fixture.revisionId).get()).exists).toBe(
          true,
        );
      } finally {
        await disposeStore(store);
      }
    },
  );

  it('imports source lineage with deterministic composite IDs and owned references', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const agentId = source.manifest.source.agentId;
      const contactId = randomUUID();
      const memoryId = randomUUID();
      const occasionId = randomUUID();
      const importId = randomUUID();
      const sourceTag = `mail-${randomUUID()}`;
      const records: MigrationRecord[] = [
        {
          table: 'contacts',
          collection: 'contacts',
          id: contactId,
          data: { id: contactId, agentId, name: 'Lineage contact' },
          checksum: '',
        },
        {
          table: 'import_sources',
          collection: 'importSources',
          id: importId,
          data: { id: importId, agentId, source: sourceTag, status: 'done' },
          checksum: '',
        },
        {
          table: 'memories',
          collection: 'memories',
          id: memoryId,
          data: { id: memoryId, agentId, content: 'Imported fact', category: 'knowledge' },
          checksum: '',
        },
        {
          table: 'occasions',
          collection: 'occasions',
          id: occasionId,
          data: { id: occasionId, agentId, contactId, kind: 'birthday', month: 6, day: 12 },
          checksum: '',
        },
      ];
      const memoryData = { source: sourceTag, memoryId };
      const occasionData = { source: sourceTag, occasionId };
      records.push(
        {
          table: 'memory_import_lineage',
          collection: 'memoryImportLineage',
          id: compositeMigrationId('memory_import_lineage', memoryData) ?? '',
          data: memoryData,
          checksum: '',
        },
        {
          table: 'occasion_import_lineage',
          collection: 'occasionImportLineage',
          id: compositeMigrationId('occasion_import_lineage', occasionData) ?? '',
          data: occasionData,
          checksum: '',
        },
      );
      for (const record of records) addRecord(source, record);
      upgradeFixtureToV3(source);

      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: agentId,
        target,
        mode: 'write',
      });
      expect(result.verified).toBe(true);
      const memoryLineage = records.at(-2);
      const occasionLineage = records.at(-1);
      if (!memoryLineage || !occasionLineage) throw new Error('lineage records are missing');
      expect((await store.doc('memoryImportLineage', memoryLineage.id).get()).data()).toMatchObject(
        memoryData,
      );
      expect(
        (await store.doc('occasionImportLineage', occasionLineage.id).get()).data(),
      ).toMatchObject(occasionData);
    } finally {
      await disposeStore(store);
    }
  });

  it('activates only a fully verified pinned v3 bundle with explicit cutover evidence', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = completeV3Bundle(target);
      const sourceAgentId = source.manifest.source.agentId;
      const bytes = Buffer.from(JSON.stringify(source));
      const evidence = {
        sourceWriteFenceId: 'change-2026-09-23-001',
        sourceWritesDrainedAt: '2026-09-23T06:30:00.000Z',
        snapshotUri: `gs://${target.projectId}-workspace/workspace/${target.installationId}/migration/snapshots/cutover.json`,
        snapshotGeneration: '1790144100630773',
        snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
      };
      await importWorkspaceBundle(store, source, { sourceAgentId, target, mode: 'write' });
      const task = source.records.find((record) => record.table === 'tasks');
      if (!task) throw new Error('test task missing');
      const leases = new FirestoreTaskLeaseRepository(store);
      expect(await leases.claim(task.id)).toBeNull();
      const activation = () =>
        activateWorkspaceBundle(store, source, {
          sourceAgentId,
          target,
          evidence,
          snapshotBytes: bytes,
        });
      await expect(activation()).resolves.toMatchObject({
        activated: true,
        alreadyActivated: false,
        bundleChecksum: source.manifest.bundleChecksum,
      });
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe('active');
      await expect(activation()).resolves.toMatchObject({
        activated: true,
        alreadyActivated: true,
      });
      await expect(
        activateWorkspaceBundle(store, source, {
          sourceAgentId,
          target,
          evidence: { ...evidence, sourceWriteFenceId: 'different-fence' },
          snapshotBytes: bytes,
        }),
      ).rejects.toThrow('conflicting cutover evidence');
      expect(await leases.claim(task.id)).not.toBeNull();
      await expect(activation()).rejects.toThrow('checksum mismatch');
    } finally {
      await disposeStore(store);
    }
  });

  it('leaves the imported workspace gated when activation evidence does not match the pinned bytes', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = completeV3Bundle(target);
      const sourceAgentId = source.manifest.source.agentId;
      const bytes = Buffer.from(JSON.stringify(source));
      await importWorkspaceBundle(store, source, { sourceAgentId, target, mode: 'write' });
      await expect(
        activateWorkspaceBundle(store, source, {
          sourceAgentId,
          target,
          snapshotBytes: bytes,
          evidence: {
            sourceWriteFenceId: 'change-2026-09-23-002',
            sourceWritesDrainedAt: '2026-09-23T06:31:00.000Z',
            snapshotUri: `gs://${target.projectId}-workspace/workspace/${target.installationId}/migration/snapshots/cutover.json`,
            snapshotGeneration: '1790144100630773',
            snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
          },
        }),
      ).rejects.toThrow('exported before the recorded source drain');
      await expect(
        activateWorkspaceBundle(store, source, {
          sourceAgentId,
          target,
          snapshotBytes: bytes,
          evidence: {
            sourceWriteFenceId: 'change-2026-09-23-002',
            sourceWritesDrainedAt: '2026-09-23T06:30:00.000Z',
            snapshotUri: `gs://${target.projectId}-workspace/workspace/${target.installationId}/migration/snapshots/cutover.json`,
            snapshotGeneration: '1790144100630773',
            snapshotSha256: '0'.repeat(64),
          },
        }),
      ).rejects.toThrow('do not match the supplied SHA-256');
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe(
        'pending_activation',
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('preserves native memory vectors with explicit provenance and hash metadata', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const space = { provider: 'test', model: 'migration', dimensions: 3, revision: '1' };
      source.manifest.source.embeddingSpace = space;
      const agentId = source.manifest.source.agentId;
      const memoryId = randomUUID();
      addRecord(source, {
        table: 'memories',
        collection: 'memories',
        id: memoryId,
        data: {
          id: memoryId,
          agentId,
          contentHash: 'memory-hash',
          embedding: serializeMigrationVector([1, 0, 0]),
          embeddingSpaceKey: null,
        },
        checksum: '',
      });
      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: agentId,
        target,
        mode: 'write',
      });
      expect(result.verified).toBe(true);
      const memory = await store.doc('memories', memoryId).get();
      expect(memory.get('embedding').toArray()).toEqual([1, 0, 0]);
      expect(memory.get('embeddingSpace')).toBeNull();
      expect(memory.get('retrievalRevision')).toBe(
        source.records.find((record) => record.id === memoryId)?.checksum,
      );
      expect((await store.doc('memoryContentHashes', 'memory-hash').get()).get('memoryId')).toBe(
        memoryId,
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('imports a prepared refresh vector as resumable private receipt state', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const space = { provider: 'test', model: 'refresh', dimensions: 2048, revision: '2' };
      source.manifest.source.embeddingSpace = space;
      const agentId = source.manifest.source.agentId;
      const memoryId = randomUUID();
      const contentHash = createHash('sha256').update('portable-refresh-source').digest('hex');
      const targetSpaceKey = embeddingSpaceIdentityKey(space);
      const receiptId = `portable-refresh:${randomUUID()}`;
      const now = new Date('2026-10-07T12:00:00Z');
      const sourceVector = Array.from({ length: 2048 }, (_, index) => (index === 0 ? 1 : 0));
      const preparedVector = Array.from({ length: 2048 }, (_, index) => (index === 0 ? 0.5 : 0));
      addRecord(source, {
        table: 'memories',
        collection: 'memories',
        id: memoryId,
        data: {
          id: memoryId,
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'A completed source carried across installations.',
          contentHash,
          embedding: serializeMigrationVector(sourceVector),
          embeddingSpaceKey: null,
        },
        checksum: '',
      });
      addRecord(source, {
        table: 'memory_embedding_refreshes',
        collection: 'memoryEmbeddingRefreshes',
        id: receiptId,
        data: {
          id: receiptId,
          agentId,
          memoryId,
          sourceHash: contentHash,
          targetSpaceKey,
          targetDimensions: 2048,
          observedSpaceKey: null,
          status: 'prepared',
          preparedVector: serializeMigrationVector(preparedVector),
          privacyGeneration: null,
          claimToken: null,
          leaseUntil: null,
          unknownReason: null,
          createdAt: serializeMigrationTimestamp('2026-10-07 12:00:00+00'),
          updatedAt: serializeMigrationTimestamp('2026-10-07 12:00:00+00'),
        },
        checksum: '',
      });
      await importWorkspaceBundle(store, source, {
        sourceAgentId: agentId,
        target,
        mode: 'write',
      });
      const importedMemory = await store.doc('memories', memoryId).get();
      expect(importedMemory.get('embedding').toArray()).toHaveLength(2048);
      const importedReceipt = await store.doc('memoryEmbeddingRefreshes', receiptId).get();
      expect(importedReceipt.get('targetDimensions')).toBe(2048);
      expect(importedReceipt.get('preparedVector')).toHaveLength(2048);
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const resumed = await repository.claim({
        agentId,
        memoryId,
        sourceHash: contentHash,
        targetSpaceKey,
        targetDimensions: 2048,
        now: new Date(now.getTime() + 1),
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      expect(resumed.kind).toBe('prepared');
      if (resumed.kind === 'prepared') {
        expect(resumed.receipt.preparedVector).toHaveLength(2048);
        expect(resumed.receipt.preparedVector?.[0]).toBe(0.5);
      }
    } finally {
      await disposeStore(store);
    }
  });

  it('preserves explicit memory embedding identity instead of guessing from the bundle manifest', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      source.manifest.source.embeddingSpace = {
        provider: 'test',
        model: 'migration',
        dimensions: 3,
        revision: '2',
      };
      const agentId = source.manifest.source.agentId;
      const memoryId = randomUUID();
      const explicitSpaceKey = 'a'.repeat(64);
      addRecord(source, {
        table: 'memories',
        collection: 'memories',
        id: memoryId,
        data: {
          id: memoryId,
          agentId,
          contentHash: 'memory-explicit-space-hash',
          embedding: serializeMigrationVector([1, 0, 0]),
          embeddingSpaceKey: explicitSpaceKey,
        },
        checksum: '',
      });
      await importWorkspaceBundle(store, source, {
        sourceAgentId: agentId,
        target,
        mode: 'write',
      });
      const memory = await store.doc('memories', memoryId).get();
      expect(memory.get('embeddingSpace')).toBe(explicitSpaceKey);
    } finally {
      await disposeStore(store);
    }
  });

  it('projects v3 graph-source ownership into destination checksums and cleanup', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const memoryId = addGraphSource(source);
      const memoryRecord = source.records.find(
        (record) => record.table === 'memories' && record.id === memoryId,
      );
      if (!memoryRecord) throw new Error('memory fixture missing');
      source.manifest.source.embeddingSpace = {
        provider: 'test',
        model: 'migration',
        dimensions: 3,
        revision: '1',
      };
      memoryRecord.data.embedding = serializeMigrationVector([1, 0, 0]);
      upgradeFixtureToV3(source);
      await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      const graphSource = store.doc('knowledgeGraphSources', memoryId);
      expect((await graphSource.get()).get('agentId')).toBe(source.manifest.source.agentId);
      expect((await graphSource.get()).get('retrievalRevision')).toBe(memoryRecord.checksum);
      await graphSource.update({ retrievalRevision: 'wrong-revision' });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).rejects.toThrow('checksum mismatch');
      await graphSource.update({ retrievalRevision: memoryRecord.checksum });
      await graphSource.update({ agentId: 'foreign-agent' });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).rejects.toThrow('checksum mismatch');
      await graphSource.update({ agentId: source.manifest.source.agentId });
      const deletionHash = `deleted-${memoryId}`;
      await Promise.all([
        store.doc('graphDeletionIntents', memoryId).set({
          memoryId,
          agentId: source.manifest.source.agentId,
          contentHash: deletionHash,
          cleanupCompletedAt: null,
        }),
        store.doc('memoryTombstones', deletionHash).set({ contentHash: deletionHash }),
      ]);
      await store.doc('memories', memoryId).delete();
      await new FirestoreProfileMemoryMaintenance(store).removeOrphanedGraphEntities({
        agentId: source.manifest.source.agentId,
        memoryId,
      });
      expect((await graphSource.get()).exists).toBe(false);
    } finally {
      await disposeStore(store);
    }
  });

  it('attributes imported model calls to the configured owner and verifies the projection', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const id = randomUUID();
      addRecord(source, {
        table: 'model_calls',
        collection: 'modelCalls',
        id,
        data: { id, taskId: null, role: 'extract', model: 'test', costUsd: '0.020000' },
        checksum: '',
      });
      upgradeFixtureToV3(source);
      await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      const modelCall = store.doc('modelCalls', id);
      expect((await modelCall.get()).get('agentId')).toBe(source.manifest.source.agentId);
      await modelCall.update({ agentId: 'foreign-agent' });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).rejects.toThrow('checksum mismatch');
    } finally {
      await disposeStore(store);
    }
  });

  it.each([1, 2] as const)(
    'keeps v%s graph-source documents free of v3 projections',
    async (version) => {
      const store = emulatorStore();
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: store.installationId,
      };
      try {
        const source = bundle(target);
        const memoryId = addGraphSource(source);
        source.manifest.formatVersion = version;
        await importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        });
        expect(
          (await store.doc('knowledgeGraphSources', memoryId).get()).data(),
        ).not.toHaveProperty('agentId');
        expect(
          (await store.doc('knowledgeGraphSources', memoryId).get()).data(),
        ).not.toHaveProperty('retrievalRevision');
      } finally {
        await disposeStore(store);
      }
    },
  );

  it('materializes distinct sub-millisecond timestamps as native Firestore timestamps', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 2);
      source.manifest.formatVersion = 2;
      const tasks = source.records.filter((record) => record.table === 'tasks');
      const first = tasks[0];
      const second = tasks[1];
      if (!first || !second) throw new Error('timestamp fixtures missing');
      first.data.createdAt = serializeMigrationTimestamp('2026-09-19 12:34:56.123456+00');
      second.data.createdAt = serializeMigrationTimestamp('2026-09-19 12:34:56.123789+00');
      refreshRecord(source, first);
      refreshRecord(source, second);
      const mailbox = 'precision@example.test';
      addRecord(source, {
        table: 'gmail_sync_state',
        collection: 'gmailSyncState',
        id: mailbox,
        data: {
          mailbox,
          lastHistoryId: serializeMigrationValue(9_223_372_036_854_775_807n),
        },
        checksum: '',
      });

      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(result.verified).toBe(true);
      const [firstSnapshot, secondSnapshot] = await store.db.getAll(
        store.doc('tasks', first.id),
        store.doc('tasks', second.id),
      );
      if (!firstSnapshot || !secondSnapshot) throw new Error('imported timestamps missing');
      const firstTimestamp = firstSnapshot.get('createdAt') as Timestamp;
      const secondTimestamp = secondSnapshot.get('createdAt') as Timestamp;
      expect(firstTimestamp).toBeInstanceOf(Timestamp);
      expect(firstTimestamp.seconds).toBe(secondTimestamp.seconds);
      expect(firstTimestamp.nanoseconds).toBe(123_456_000);
      expect(secondTimestamp.nanoseconds).toBe(123_789_000);
      const gmail = decodeRecord<Record<string, unknown>>(
        (await store.doc('gmailSyncState', mailbox).get()).data(),
      );
      expect(gmail.lastHistoryId).toBe(9_223_372_036_854_775_807n);
      await store.doc('tasks', first.id).update({
        createdAt: new Timestamp(firstTimestamp.seconds, firstTimestamp.nanoseconds + 1_000),
      });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).rejects.toThrow('checksum mismatch');
    } finally {
      await disposeStore(store);
    }
  });

  it.skipIf(!enabled)(
    'rejects checksummed foreign and cross-parent card/segment links before any destination write',
    async () => {
      const store = emulatorStore();
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: store.installationId,
      };
      const makeLinkedBundle = () => {
        const source = completeV3Bundle(target);
        const agentId = source.manifest.source.agentId;
        const conversationA = randomUUID();
        const conversationB = randomUUID();
        const messageA = randomUUID();
        const messageB = randomUUID();
        const cardA = randomUUID();
        const cardB = randomUUID();
        const revisionA = randomUUID();
        const revisionB = randomUUID();
        const segment = randomUUID();
        for (const id of [conversationA, conversationB])
          addRecord(source, {
            table: 'conversations',
            collection: 'conversations',
            id,
            data: { id, agentId, channel: 'web', purpose: 'owner_chat' },
            checksum: '',
          });
        for (const [id, conversationId] of [
          [messageA, conversationA],
          [messageB, conversationB],
        ] as const)
          addRecord(source, {
            table: 'messages',
            collection: 'messages',
            id,
            data: { id, conversationId, role: 'assistant', text: `Fixture ${id}` },
            checksum: '',
          });
        for (const [id, conversationId, messageId, currentRevisionId] of [
          [cardA, conversationA, messageA, revisionA],
          [cardB, conversationB, messageB, revisionB],
        ] as const)
          addRecord(source, {
            table: 'generated_cards',
            collection: 'generatedCards',
            id,
            data: { id, agentId, conversationId, messageId, currentRevisionId },
            checksum: '',
          });
        for (const [id, cardId] of [
          [revisionA, cardA],
          [revisionB, cardB],
        ] as const)
          addRecord(source, {
            table: 'generated_card_revisions',
            collection: 'generatedCardRevisions',
            id,
            data: { id, cardId, revision: 1, payload: { title: `Card ${id}` } },
            checksum: '',
          });
        addRecord(source, {
          table: 'conversation_segments',
          collection: 'conversationSegments',
          id: segment,
          data: {
            id: segment,
            agentId,
            conversationId: conversationA,
            startMessageId: messageA,
            endMessageId: messageA,
            content: 'Migration segment fixture',
          },
          checksum: '',
        });
        upgradeFixtureToV3(source);
        return { source, ids: { cardA, cardB, messageB, revisionB, segment } };
      };
      const fixtureRecord = (source: MigrationBundle, table: string, id: string) => {
        const record = source.records.find((row) => row.table === table && row.id === id);
        if (!record) throw new Error(`Missing migration fixture record: ${table}/${id}`);
        return record.data;
      };
      const rejected: Array<{
        name: string;
        edit: (source: MigrationBundle, ids: ReturnType<typeof makeLinkedBundle>['ids']) => void;
        error: RegExp;
      }> = [
        {
          name: 'card current revision from another card',
          edit: (source, ids) => {
            fixtureRecord(source, 'generated_cards', ids.cardA).currentRevisionId = ids.revisionB;
          },
          error: /parent linkage: currentRevisionId/,
        },
        {
          name: 'card message from another conversation',
          edit: (source, ids) => {
            fixtureRecord(source, 'generated_cards', ids.cardA).messageId = ids.messageB;
          },
          error: /parent linkage: messageId/,
        },
        {
          name: 'segment start message from another conversation',
          edit: (source, ids) => {
            fixtureRecord(source, 'conversation_segments', ids.segment).startMessageId =
              ids.messageB;
          },
          error: /parent linkage: startMessageId/,
        },
        {
          name: 'segment end message from another conversation',
          edit: (source, ids) => {
            fixtureRecord(source, 'conversation_segments', ids.segment).endMessageId = ids.messageB;
          },
          error: /parent linkage: endMessageId/,
        },
        {
          name: 'foreign owner on card',
          edit: (source, ids) => {
            fixtureRecord(source, 'generated_cards', ids.cardA).agentId = randomUUID();
          },
          error: /outside source workspace: generated_cards/,
        },
        {
          name: 'foreign owner on segment',
          edit: (source, ids) => {
            fixtureRecord(source, 'conversation_segments', ids.segment).agentId = randomUUID();
          },
          error: /outside source workspace: conversation_segments/,
        },
      ];
      try {
        for (const scenario of rejected) {
          const { source, ids } = makeLinkedBundle();
          scenario.edit(source, ids);
          // Recompute every v3 checksum so import reaches the relationship validator,
          // rather than passing because this test merely tampered with bytes.
          upgradeFixtureToV3(source);
          await expect(
            importWorkspaceBundle(store, source, {
              sourceAgentId: source.manifest.source.agentId,
              target,
              mode: 'write',
            }),
            scenario.name,
          ).rejects.toThrow(scenario.error);
          expect(await store.root.listCollections(), scenario.name).toHaveLength(0);
          expect((await store.doc('coordination', 'migration').get()).exists, scenario.name).toBe(
            false,
          );
        }

        const { source, ids } = makeLinkedBundle();
        const imported = await importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        });
        expect(imported.verified).toBe(true);
        expect((await store.doc('generatedCards', ids.cardA).get()).exists).toBe(true);
        expect((await store.doc('generatedCardRevisions', ids.revisionB).get()).exists).toBe(true);
        expect((await store.doc('conversationSegments', ids.segment).get()).exists).toBe(true);
        expect((await store.doc('coordination', 'migration').get()).exists).toBe(true);
      } finally {
        await disposeStore(store);
      }
    },
  );

  it('rejects a tampered bundle before reading or writing the target', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const task = source.records.find((record) => record.table === 'tasks');
      if (!task) throw new Error('test task missing');
      task.data.status = 'done';
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
        }),
      ).rejects.toThrow('checksum mismatch');
      expect((await store.collection('agents').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('resumes an interrupted multi-batch import exactly once', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 500);
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
          failAfterBatches: 1,
        }),
      ).rejects.toThrow('Injected');
      const task = [...source.records]
        .filter((record) => record.table === 'tasks')
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!task) throw new Error('test task missing');
      expect(await new FirestoreTaskLeaseRepository(store).claim(task.id)).toBeNull();
      await store.doc('tasks', task.id).update({ status: 'done' });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
      ).rejects.toThrow('checksum');
      await store.doc('tasks', task.id).update({ status: 'pending' });
      await store.doc('coordination', 'migration').update({
        formatVersion: FieldValue.delete(),
      });
      const resumed = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(resumed.resumed).toBe(true);
      expect((await store.collection('tasks').get()).size).toBe(500);
      expect((await store.collection('outbox').get()).empty).toBe(true);
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe(
        'pending_activation',
      );
      expect((await store.doc('coordination', 'migration').get()).get('formatVersion')).toBe(1);
      await store.doc('coordination', 'migration').update({
        formatVersion: FieldValue.delete(),
      });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).resolves.toMatchObject({ verified: true });
    } finally {
      await disposeStore(store);
    }
  });

  it('resumes a byte-packed variable-size chunk from its absolute write cursor', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 500);
      source.manifest.source.embeddingSpace = {
        provider: 'synthetic',
        model: 'migration-packing-fixture',
        dimensions: 1536,
        revision: '1',
      };
      const tasks = source.records
        .filter((record) => record.table === 'tasks')
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const [index, task] of tasks.entries()) {
        const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
        task.id = id;
        task.data.id = id;
        task.data.state = {
          nested: {
            labels: ['ferry 🛳️', 'Reykjavík café'],
            note: index % 5 === 0 ? 'é'.repeat(70_000) : `small-${index}`,
            numeric: [1, 2, 3, 4],
          },
        };
      }
      const memoryId = '00000000-0000-4000-8000-999999999999';
      addRecord(source, {
        table: 'memories',
        collection: 'memories',
        id: memoryId,
        data: {
          id: memoryId,
          agentId: source.manifest.source.agentId,
          content: 'Vector packing fixture',
          contentHash: 'vector-packing-fixture',
          embedding: serializeMigrationVector(
            Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
          ),
        },
        checksum: '',
      });
      upgradeFixtureToV3(source);
      const preview = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      });
      expect(preview.writeBatches).toBeGreaterThan(1);
      expect(preview.maxBatchBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
          failAfterBatches: 1,
        }),
      ).rejects.toThrow('Injected migration batch failure');
      const marker = store.doc('coordination', 'migration');
      const interruptedAt = (await marker.get()).get('completedWrites');
      expect(interruptedAt).toBeGreaterThan(0);
      expect(interruptedAt).toBeLessThan(source.records.length);
      expect(interruptedAt).toBeLessThan(450);

      const resumed = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(resumed).toMatchObject({ resumed: true, verified: true });
      expect((await store.collection('tasks').get()).size).toBe(500);
      const vector = (await store.doc('memories', memoryId).get()).get('embedding') as {
        toArray?: () => number[];
        _values?: number[];
      };
      expect(vector.toArray?.() ?? vector._values).toHaveLength(1536);
    } finally {
      await disposeStore(store);
    }
  });

  it('requires an explicit matching marker version for v3 resumes', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      upgradeFixtureToV3(source);
      const marker = store.doc('coordination', 'migration');
      await marker.set({
        sourceAgentId: source.manifest.source.agentId,
        target,
        bundleChecksum: source.manifest.bundleChecksum,
        status: 'importing',
        completedWrites: 0,
        totalWrites: 0,
      });
      const resume = () =>
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        });
      await expect(resume()).rejects.toThrow(
        'Existing migration marker belongs to a different bundle or identity',
      );
      await marker.update({ formatVersion: 2 });
      await expect(resume()).rejects.toThrow(
        'Existing migration marker belongs to a different bundle or identity',
      );
      expect((await marker.get()).get('completedWrites')).toBe(0);
    } finally {
      await disposeStore(store);
    }
  });

  it('verifies a completed v2 import whose legacy marker has no format version', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      source.manifest.formatVersion = 2;
      await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      await store.doc('coordination', 'migration').update({
        formatVersion: FieldValue.delete(),
      });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).resolves.toMatchObject({ verified: true });
    } finally {
      await disposeStore(store);
    }
  });

  it('blocks an imported due schedule while activation is pending', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const scheduleId = randomUUID();
      await store.doc('schedules', scheduleId).set({
        id: scheduleId,
        agentId: source.manifest.source.agentId,
        name: 'imported',
        cron: '* * * * *',
        taskTemplate: {},
        enabled: true,
        nextRunAt: new Date('2020-01-01T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await store.doc('coordination', 'migration').set({
        status: 'pending_activation',
        sourceAgentId: source.manifest.source.agentId,
        target,
        bundleChecksum: source.manifest.bundleChecksum,
      });
      const row = await new FirestoreScheduleRepository(store).listDue(
        new Date('2026-09-12T00:00:00Z'),
      );
      expect(row.some((schedule) => schedule.id === scheduleId)).toBe(true);
      const expected = row.find((schedule) => schedule.id === scheduleId);
      if (!expected) throw new Error('schedule missing');
      const result = await new FirestoreScheduleRepository(store).commitOccurrence({
        expected,
        now: new Date('2026-09-12T00:00:00Z'),
        mode: 'due',
        nextRunAt: new Date('2026-09-13T00:00:00Z'),
        enabled: true,
        task: null,
      });
      expect(result).toBeNull();
    } finally {
      await disposeStore(store);
    }
  });

  it('allows only one concurrent resume to advance the cursor', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 500);
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
          failAfterBatches: 1,
        }),
      ).rejects.toThrow('Injected');
      const results = await Promise.allSettled([
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await store.collection('tasks').get()).size).toBe(500);
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe(
        'pending_activation',
      );
    } finally {
      await disposeStore(store);
    }
  });
});

describe('Firestore card-form migration preview', () => {
  const target = {
    projectId: 'demo-assistant-test',
    databaseId: '(default)',
    installationId: 'preview',
  };
  const previewStore = {} as Parameters<typeof importWorkspaceBundle>[0];

  it('derives no active-form guard for any terminal migrated task', async () => {
    for (const status of ['done', 'failed', 'cancelled']) {
      const fixture = cardFormBundle(target, 1, status);
      const preview = await importWorkspaceBundle(previewStore, fixture.source, {
        sourceAgentId: fixture.source.manifest.source.agentId,
        target,
        mode: 'preview',
      });
      expect(preview.collections.taskEventKeys, status).toBe(1);
    }
  });

  it('rejects malformed task/card/message bindings and ambiguous active keys in preview', async () => {
    const foreignOwner = cardFormBundle(target);
    const foreignTask = foreignOwner.source.records.find((record) => record.table === 'tasks');
    if (!foreignTask) throw new Error('form migration task missing');
    foreignTask.data.agentId = randomUUID();
    upgradeFixtureToV3(foreignOwner.source);
    await expect(
      importWorkspaceBundle(previewStore, foreignOwner.source, {
        sourceAgentId: foreignOwner.source.manifest.source.agentId,
        target,
        mode: 'preview',
      }),
    ).rejects.toThrow(/outside source workspace: tasks/);

    const corruptions = [
      [
        'card',
        (admission: Record<string, unknown>) => {
          admission.cardId = randomUUID();
        },
      ],
      [
        'revision',
        (admission: Record<string, unknown>) => {
          admission.expectedRevisionId = randomUUID();
        },
      ],
      [
        'conversation',
        (admission: Record<string, unknown>) => {
          admission.conversationId = randomUUID();
        },
      ],
      [
        'message',
        (admission: Record<string, unknown>) => {
          admission.messageId = randomUUID();
        },
      ],
      [
        'operation',
        (admission: Record<string, unknown>) => {
          admission.operationId = randomUUID();
        },
      ],
      [
        'malformed UUID',
        (admission: Record<string, unknown>) => {
          admission.operationId = 'not-a-uuid';
        },
      ],
      [
        'noncanonical uppercase UUID',
        (admission: Record<string, unknown>) => {
          admission.operationId = '11111111-1111-4111-8111-ABCDEFABCDEF';
        },
      ],
      [
        'non-ASCII form ID',
        (admission: Record<string, unknown>) => {
          admission.formId = 'réunion';
        },
      ],
      [
        'malformed receipt shape',
        (admission: Record<string, unknown>) => {
          admission.unexpected = true;
        },
      ],
    ] as const;
    for (const [name, corrupt] of corruptions) {
      const fixture = cardFormBundle(target);
      const task = fixture.source.records.find((record) => record.table === 'tasks');
      if (!task) throw new Error('form migration task missing');
      const trigger = task.data.trigger as {
        payload?: { cardFormAdmission?: Record<string, unknown> };
      };
      const admission = trigger.payload?.cardFormAdmission;
      if (!admission) throw new Error('form migration receipt missing');
      corrupt(admission);
      upgradeFixtureToV3(fixture.source);
      await expect(
        importWorkspaceBundle(previewStore, fixture.source, {
          sourceAgentId: fixture.source.manifest.source.agentId,
          target,
          mode: 'preview',
        }),
        name,
      ).rejects.toThrow();
    }

    const malformedTaskId = cardFormBundle(target);
    const malformedTask = malformedTaskId.source.records.find((record) => record.table === 'tasks');
    if (!malformedTask) throw new Error('form migration task missing');
    malformedTask.data.id = 'not-a-uuid';
    upgradeFixtureToV3(malformedTaskId.source);
    await expect(
      importWorkspaceBundle(previewStore, malformedTaskId.source, {
        sourceAgentId: malformedTaskId.source.manifest.source.agentId,
        target,
        mode: 'preview',
      }),
    ).rejects.toThrow();

    const badTaskReceipt = cardFormBundle(target);
    const receiptTask = badTaskReceipt.source.records.find((record) => record.table === 'tasks');
    if (!receiptTask) throw new Error('form migration task missing');
    const taskTrigger = receiptTask.data.trigger as {
      payload?: { chatAdmission?: Record<string, unknown> };
    };
    if (!taskTrigger.payload?.chatAdmission) throw new Error('chat admission receipt missing');
    taskTrigger.payload.chatAdmission.requestHash = 'b'.repeat(64);
    upgradeFixtureToV3(badTaskReceipt.source);
    await expect(
      importWorkspaceBundle(previewStore, badTaskReceipt.source, {
        sourceAgentId: badTaskReceipt.source.manifest.source.agentId,
        target,
        mode: 'preview',
      }),
    ).rejects.toThrow(/Card form task owner or operation binding mismatch/);

    const duplicate = cardFormBundle(target, 2);
    await expect(
      importWorkspaceBundle(previewStore, duplicate.source, {
        sourceAgentId: duplicate.source.manifest.source.agentId,
        target,
        mode: 'preview',
      }),
    ).rejects.toThrow(/duplicate destination: taskEventKeys:/);
  });
});
