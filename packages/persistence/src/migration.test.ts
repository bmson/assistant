import { describe, expect, it, vi } from 'vitest';
import {
  assertSupportedMigrationTables,
  checksum,
  checksumForMigrationVersion,
  checksumV3,
  compositeMigrationId,
  deserializeMigrationValue,
  type MigrationBundle,
  type MigrationRecord,
  type SerializedValue,
  serializeMigrationTimestamp,
  serializeMigrationValue,
  serializeMigrationValueV3,
  serializeMigrationVector,
  validateMigrationBundle,
  validateMigrationReferences,
} from './migration.js';
import { toolCallReceiptKeyId } from './tool-call-receipts.js';

const agent = (id: string): MigrationRecord => ({
  table: 'agents',
  collection: 'agents',
  id,
  data: { id, name: 'Owner', email: 'owner@example.test', workspacePrefix: 'workspace/test' },
  checksum: checksum({
    id,
    name: 'Owner',
    email: 'owner@example.test',
    workspacePrefix: 'workspace/test',
  }),
});

describe('workspace migration format', () => {
  it('serializes dates and vectors deterministically', () => {
    expect(serializeMigrationValue({ z: new Date('2026-01-02T03:04:05.000Z'), a: [1, 2] })).toEqual(
      {
        a: [1, 2],
        z: { $assistantMigration: ['date', '2026-01-02T03:04:05.000Z'] },
      },
    );
    expect(checksum({ b: 1, a: 2 })).toBe(checksum({ a: 2, b: 1 }));
  });

  it('keeps v1/v2 checksums legacy while v3 Unicode ordering is locale-independent', () => {
    expect(checksum({ a: 1, b: { c: 'legacy' } })).toBe(
      '07c644bf9c61f72f5a668e2562e720f6d38fd8702977141dbb26bf7446644c2f',
    );
    const value = { z: 1, ä: 2, a: { é: 3, e: 4 } };
    const legacy = checksum(value);
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: string,
      other,
    ) {
      return String(this) < other ? 1 : -1;
    });
    expect(checksumForMigrationVersion(value, 2)).not.toBe(legacy);
    expect(() => serializeMigrationValueV3(value)).not.toThrow();
    expect(checksumForMigrationVersion(value, 3)).toBe(checksumV3(value));
    localeCompare.mockRestore();
    expect(serializeMigrationValueV3(value)).toEqual({
      a: { e: 4, é: 3 },
      z: 1,
      ä: 2,
    });
  });

  it('preserves PostgreSQL microseconds while accepting legacy millisecond dates', () => {
    const first = serializeMigrationTimestamp('2026-09-19 12:34:56.123456+00');
    const second = serializeMigrationTimestamp('2026-09-19 12:34:56.123789+00');
    expect(first).toEqual({
      $assistantMigration: ['timestamp', '2026-09-19T12:34:56.123456Z'],
    });
    expect(checksum(first)).not.toBe(checksum(second));
    const precise = deserializeMigrationValue(first) as {
      seconds: bigint;
      nanoseconds: number;
    };
    expect(precise.seconds).toBe(1_789_821_296n);
    expect(precise.nanoseconds).toBe(123_456_000);
    expect(
      deserializeMigrationValue({
        $assistantMigration: ['date', '2026-09-19T12:34:56.123Z'],
      }),
    ).toEqual(new Date('2026-09-19T12:34:56.123Z'));
  });

  it('round-trips only calendar-valid PostgreSQL timestamps at microsecond precision', () => {
    const invalidInputs = [
      '2026-02-30 12:34:56.123456+00',
      '2026-02-29 12:34:56.123456+00',
      '2026-13-01 12:34:56.123456+00',
      '2026-04-30 24:00:00.123456+00',
    ];
    for (const input of invalidInputs) {
      expect(() => serializeMigrationTimestamp(input), input).toThrow(
        `Invalid PostgreSQL migration timestamp: ${input}`,
      );
    }

    const leapDay = serializeMigrationTimestamp('2024-02-29 12:34:56.000001+00');
    expect(leapDay).toEqual({
      $assistantMigration: ['timestamp', '2024-02-29T12:34:56.000001Z'],
    });
    expect(deserializeMigrationValue(leapDay)).toMatchObject({
      seconds: 1_709_210_096n,
      nanoseconds: 1_000,
    });
    const beforeEpoch = serializeMigrationTimestamp('1969-12-31 23:59:59.999999+00');
    expect(deserializeMigrationValue(beforeEpoch)).toMatchObject({
      seconds: -1n,
      nanoseconds: 999_999_000,
    });

    for (const payload of [
      '2026-02-30T12:34:56.123456Z',
      '2026-02-29T12:34:56.123456Z',
      '2026-13-01T12:34:56.123456Z',
      '2026-04-30T24:00:00.123456Z',
    ]) {
      expect(
        () => deserializeMigrationValue({ $assistantMigration: ['timestamp', payload] }),
        payload,
      ).toThrow('Malformed migration tag');
    }
  });

  it('rejects unsupported tables before any database work', () => {
    expect(() => assertSupportedMigrationTables(['agents', 'not_a_real_table'])).toThrow(
      'Unsupported migration tables: not_a_real_table',
    );
  });

  it('enumerates the complete PostgreSQL schema without duplicate tables', async () => {
    const { MIGRATION_TABLES } = await import('./migration.js');
    expect(MIGRATION_TABLES).toHaveLength(91);
    expect(new Set(MIGRATION_TABLES.map(({ table }) => table))).toHaveProperty('size', 91);
    expect(MIGRATION_TABLES.some(({ table }) => table === 'recall_surfaces')).toBe(true);
    expect(MIGRATION_TABLES.map(({ table }) => table)).toEqual(
      expect.arrayContaining([
        'memory_import_lineage',
        'occasion_import_lineage',
        'skill_library_revisions',
        'model_role_revisions',
        'knowledge_graph_assertions',
        'knowledge_graph_assertion_evidence',
        'mission_reports',
        'notification_outbox',
        'memory_embedding_refreshes',
        'email_attachment_custodies',
        'email_observer_budgets',
        'email_observer_sources',
        'email_observer_work',
      ]),
    );
  });

  it('rejects records outside the selected workspace and missing references', () => {
    expect(() =>
      validateMigrationReferences(
        [
          agent('agent-1'),
          {
            table: 'goals',
            collection: 'goals',
            id: 'goal-1',
            data: { id: 'goal-1', agentId: 'agent-2' },
            checksum: '',
          },
        ],
        'agent-1',
      ),
    ).toThrow('outside source workspace');
  });

  it('accepts bounded 2048-dimensional Firestore refresh receipts and rejects invalid widths or vectors', () => {
    const memoryId = 'memory-2048';
    const receipt = (
      targetDimensions: number,
      preparedVector: SerializedValue | null,
    ): MigrationRecord => ({
      table: 'memory_embedding_refreshes',
      collection: 'memoryEmbeddingRefreshes',
      id: 'refresh-2048',
      data: {
        id: 'refresh-2048',
        agentId: 'owner',
        memoryId,
        sourceHash: 'a'.repeat(64),
        targetSpaceKey: 'b'.repeat(64),
        targetDimensions,
        status: 'prepared',
        preparedVector,
      },
      checksum: '',
    });
    const memory: MigrationRecord = {
      table: 'memories',
      collection: 'memories',
      id: memoryId,
      data: { id: memoryId, agentId: 'owner', embeddingSpaceKey: null },
      checksum: '',
    };
    const vector = new Array(2048).fill(0);
    vector[0] = 0.5;
    const valid = [agent('owner'), memory, receipt(2048, serializeMigrationVector(vector))];

    expect(() => validateMigrationReferences(valid, 'owner')).not.toThrow();
    expect(() =>
      validateMigrationReferences([agent('owner'), memory, receipt(0, null)], 'owner'),
    ).toThrow('Invalid memory_embedding_refreshes/refresh-2048 receipt');
    expect(() =>
      validateMigrationReferences([agent('owner'), memory, receipt(2049, null)], 'owner'),
    ).toThrow('Invalid memory_embedding_refreshes/refresh-2048 receipt');
    expect(() =>
      validateMigrationReferences(
        [agent('owner'), memory, receipt(2048, serializeMigrationVector([0.5]))],
        'owner',
      ),
    ).toThrow('Invalid memory_embedding_refreshes/refresh-2048 prepared vector');
    expect(() =>
      validateMigrationReferences(
        [agent('owner'), memory, receipt(2048, { $assistantMigration: ['vector', [Number.NaN]] })],
        'owner',
      ),
    ).toThrow('Malformed migration tag');
  });
});

describe('migration format integrity', () => {
  it('round trips reserved tags, nested JSON, bytes, dates and numeric arrays without changing user data', () => {
    const input = {
      nested: { $assistantMigration: ['date', '2026-01-01T00:00:00.000Z'], extra: true },
      escape: { $assistantMigrationEscape: { $assistantMigration: ['bytes', 'YQ=='] } },
      numbers: [1, 2, 3],
      date: new Date('2026-01-01T00:00:00.000Z'),
      bytes: Buffer.from('example'),
      bigint: 9_007_199_254_740_993n,
    };
    expect(deserializeMigrationValue(serializeMigrationValue(input))).toEqual(input);
  });
  it.each([
    { $assistantMigration: ['date', 'not-a-date'] },
    { $assistantMigration: ['date', '2026-02-30T00:00:00.000Z'] },
    { $assistantMigration: ['bytes', 'invalid!'] },
    { $assistantMigration: ['vector', ['1']] },
    { $assistantMigration: ['unknown', 'x'] },
    { $assistantMigration: ['date', '2026-01-01T00:00:00.000Z'], extra: 1 },
    {
      $assistantMigration: [
        'object',
        [
          ['a', 1],
          ['a', 2],
        ],
      ],
    },
  ])('rejects a malformed typed payload %j', (input) => {
    expect(() => deserializeMigrationValue(input as SerializedValue)).toThrow('Malformed');
  });
  function bundle(): MigrationBundle {
    const record = agent('owner');
    return {
      manifest: {
        format: 'assistant-workspace-migration',
        formatVersion: 1,
        mode: 'export',
        source: { kind: 'postgresql', agentId: 'owner', scope: 'installation', snapshot: '1:1:' },
        target: {
          projectId: 'customer-project',
          databaseId: '(default)',
          installationId: 'assistant',
        },
        coverage: { complete: false, supportedTables: ['agents'], omittedTables: ['tasks'] },
        tables: {
          agents: { collection: 'agents', count: 1, checksum: checksum([record]) },
        } as MigrationBundle['manifest']['tables'],
        recordCount: 1,
        bundleChecksum: checksum([record]),
        unsupportedTables: [],
      },
      records: [record],
    };
  }
  function validate(input: MigrationBundle) {
    validateMigrationBundle(input, { sourceAgentId: 'owner', target: input.manifest.target });
  }
  it('rejects unsupported source and fabricated coverage metadata', () => {
    const input = bundle();
    input.manifest.coverage.supportedTables = [];
    expect(() => validate(input)).toThrow('coverage metadata');
    input.manifest.coverage.supportedTables = ['agents'];
    input.manifest.source.snapshot = '';
    expect(() => validate(input)).toThrow('source metadata');
  });
  it('checks count and table summaries independently of valid record checksums', () => {
    const input = bundle();
    validate(input);
    input.manifest.recordCount++;
    expect(() => validate(input)).toThrow('record count');
    input.manifest.recordCount--;
    input.manifest.tables.agents.checksum = 'incorrect';
    expect(() => validate(input)).toThrow('summary mismatch');
  });
  it('validates v3 bundles with deterministic Unicode checksums', () => {
    const input = bundle();
    input.manifest.formatVersion = 3;
    const record = input.records[0];
    if (!record) throw new Error('Missing fixture record');
    record.data.äther = 'unicode';
    record.checksum = checksumV3(record.data);
    input.manifest.tables.agents = {
      collection: 'agents',
      count: 1,
      checksum: checksumV3([record]),
    };
    input.manifest.bundleChecksum = checksumV3([record]);
    expect(() => validate(input)).not.toThrow();
  });
  it('rejects duplicate records even with newly recomputed bundle and table checksums', () => {
    const input = bundle();
    const first = input.records[0];
    if (!first) throw new Error('Missing fixture record');
    input.records.push(first);
    input.manifest.recordCount = 2;
    input.manifest.bundleChecksum = checksum(input.records);
    input.manifest.tables.agents = {
      collection: 'agents',
      count: 2,
      checksum: checksum(input.records),
    };
    expect(() => validate(input)).toThrow('Duplicate');
  });
});

describe('migration required ownership', () => {
  it('rejects cross-parent card, segment and commitment links even within the same owner', () => {
    const row = (
      table: MigrationRecord['table'],
      collection: MigrationRecord['collection'],
      id: string,
      data: MigrationRecord['data'],
    ): MigrationRecord => ({ table, collection, id, data: { id, ...data }, checksum: '' });
    const base = [
      agent('owner'),
      row('conversations', 'conversations', 'a', { agentId: 'owner' }),
      row('conversations', 'conversations', 'b', { agentId: 'owner' }),
      row('messages', 'messages', 'message-a', { conversationId: 'a' }),
      row('messages', 'messages', 'message-b', { conversationId: 'b' }),
      row('generated_cards', 'generatedCards', 'card-a', {
        agentId: 'owner',
        conversationId: 'a',
        messageId: 'message-a',
        currentRevisionId: 'revision-a',
      }),
      row('generated_cards', 'generatedCards', 'card-b', {
        agentId: 'owner',
        conversationId: 'b',
        currentRevisionId: 'revision-b',
      }),
      row('generated_card_revisions', 'generatedCardRevisions', 'revision-a', { cardId: 'card-a' }),
      row('generated_card_revisions', 'generatedCardRevisions', 'revision-b', { cardId: 'card-b' }),
      row('conversation_segments', 'conversationSegments', 'segment', {
        agentId: 'owner',
        conversationId: 'a',
        startMessageId: 'message-a',
        endMessageId: 'message-a',
      }),
      row('commitments', 'commitments', 'commitment', {
        agentId: 'owner',
        conversationId: 'a',
        sourceMessageId: 'message-a',
      }),
    ];
    expect(() => validateMigrationReferences(base, 'owner')).not.toThrow();
    for (const [id, field, value] of [
      ['card-a', 'currentRevisionId', 'revision-b'],
      ['card-a', 'messageId', 'message-b'],
      ['segment', 'startMessageId', 'message-b'],
      ['segment', 'endMessageId', 'message-b'],
      ['commitment', 'sourceMessageId', 'message-b'],
    ] as const) {
      const modified = base.map((entry) =>
        entry.id === id ? { ...entry, data: { ...entry.data, [field]: value } } : entry,
      );
      expect(() => validateMigrationReferences(modified, 'owner'), `${id}.${field}`).toThrow(
        'parent linkage',
      );
    }
  });

  it('requires the owner and mission parent of durable mission report receipts', () => {
    const report: MigrationRecord = {
      table: 'mission_reports',
      collection: 'missionReports',
      id: 'report',
      data: { id: 'report', agentId: 'owner', missionId: 'root' },
      checksum: '',
    };
    const root: MigrationRecord = {
      table: 'tasks',
      collection: 'tasks',
      id: 'root',
      data: { id: 'root', agentId: 'owner' },
      checksum: '',
    };
    expect(() =>
      validateMigrationReferences([agent('owner'), root, report], 'owner'),
    ).not.toThrow();
    expect(() => validateMigrationReferences([agent('owner'), report], 'owner')).toThrow(
      'reference missionId',
    );
    expect(() =>
      validateMigrationReferences(
        [agent('owner'), root, { ...report, data: { ...report.data, agentId: 'foreign' } }],
        'owner',
      ),
    ).toThrow('outside source workspace');
  });
  it('rejects a task with an absent owner instead of importing an unclaimable row', () => {
    const task: MigrationRecord = {
      table: 'tasks',
      collection: 'tasks',
      id: 'task',
      data: { id: 'task' },
      checksum: '',
    };
    expect(() => validateMigrationReferences([agent('owner'), task], 'owner')).toThrow(
      'reference agentId',
    );
  });
  it('preserves import lineage only when both its source and owned target are present', () => {
    const source = {
      table: 'import_sources' as const,
      collection: 'importSources' as const,
      id: 'source-row',
      data: { id: 'source-row', agentId: 'owner', source: 'archive-2024' },
      checksum: '',
    };
    const memory = {
      table: 'memories' as const,
      collection: 'memories' as const,
      id: 'memory-row',
      data: { id: 'memory-row', agentId: 'owner' },
      checksum: '',
    };
    const occasion = {
      table: 'occasions' as const,
      collection: 'occasions' as const,
      id: 'occasion-row',
      data: { id: 'occasion-row', agentId: 'owner', contactId: 'contact-row' },
      checksum: '',
    };
    const contact = {
      table: 'contacts' as const,
      collection: 'contacts' as const,
      id: 'contact-row',
      data: { id: 'contact-row', agentId: 'owner' },
      checksum: '',
    };
    const memoryData = { source: 'archive-2024', memoryId: 'memory-row' };
    const occasionData = { source: 'archive-2024', occasionId: 'occasion-row' };
    const memoryLineage: MigrationRecord = {
      table: 'memory_import_lineage',
      collection: 'memoryImportLineage',
      id: compositeMigrationId('memory_import_lineage', memoryData) ?? '',
      data: memoryData,
      checksum: '',
    };
    const occasionLineage: MigrationRecord = {
      table: 'occasion_import_lineage',
      collection: 'occasionImportLineage',
      id: compositeMigrationId('occasion_import_lineage', occasionData) ?? '',
      data: occasionData,
      checksum: '',
    };
    expect(memoryLineage.id).not.toBe(occasionLineage.id);
    expect(() =>
      validateMigrationReferences(
        [agent('owner'), source, memory, contact, occasion, memoryLineage, occasionLineage],
        'owner',
      ),
    ).not.toThrow();
    expect(() =>
      validateMigrationReferences([agent('owner'), memory, memoryLineage], 'owner'),
    ).toThrow('reference source');
    expect(() =>
      validateMigrationReferences([agent('owner'), source, occasionLineage], 'owner'),
    ).toThrow('reference occasionId');
  });
  it('rejects approval links to another task even when both IDs exist', () => {
    const row = (
      table: MigrationRecord['table'],
      collection: MigrationRecord['collection'],
      id: string,
      data: MigrationRecord['data'],
    ): MigrationRecord => ({ table, collection, id, data: { id, ...data }, checksum: '' });
    const rows = [
      agent('owner'),
      row('tasks', 'tasks', 'one', { agentId: 'owner' }),
      row('tasks', 'tasks', 'two', { agentId: 'owner' }),
      row('tool_calls', 'toolCalls', 'call', { taskId: 'one', approvalId: 'approval' }),
      row('approvals', 'approvals', 'approval', { taskId: 'two', toolCallId: 'call' }),
    ];
    expect(() => validateMigrationReferences(rows, 'owner')).toThrow(
      'Inconsistent approval tool linkage',
    );
  });
  it('requires compact effect receipts and replay keys to round-trip as one owner-scoped unit', () => {
    const row = (
      table: MigrationRecord['table'],
      collection: MigrationRecord['collection'],
      id: string,
      data: MigrationRecord['data'],
    ): MigrationRecord => ({ table, collection, id, data: { id, ...data }, checksum: '' });
    const modelHash = 'a'.repeat(64);
    const idempotencyHash = 'b'.repeat(64);
    const receipt = row('tool_call_receipts', 'toolCallReceipts', 'receipt', {
      agentId: 'owner',
      taskId: 'pruned-task',
      toolCallId: 'receipt',
      modelToolCallIdHash: modelHash,
      idempotencyKeyHash: idempotencyHash,
      toolName: 'gmail.send',
      effectOutcome: 'unknown',
      recordedAt: serializeMigrationTimestamp('2026-10-07 12:00:00+00'),
    });
    const modelKeyId = toolCallReceiptKeyId('model_tool_call', modelHash);
    const idempotencyKeyId = toolCallReceiptKeyId('idempotency', idempotencyHash);
    const modelKey = row('tool_call_receipt_keys', 'toolCallReceiptKeys', modelKeyId, {
      agentId: 'owner',
      taskId: 'pruned-task',
      receiptId: 'receipt',
      kind: 'model_tool_call',
      digest: modelHash,
    });
    const idempotencyKey = row('tool_call_receipt_keys', 'toolCallReceiptKeys', idempotencyKeyId, {
      agentId: 'owner',
      taskId: 'pruned-task',
      receiptId: 'receipt',
      kind: 'idempotency',
      digest: idempotencyHash,
    });
    expect(() =>
      validateMigrationReferences([agent('owner'), receipt, modelKey, idempotencyKey], 'owner'),
    ).not.toThrow();
    expect(() => validateMigrationReferences([agent('owner'), receipt, modelKey], 'owner')).toThrow(
      'Missing compact tool-call receipt key',
    );
    const orphanDigest = 'c'.repeat(64);
    const orphanKey = row(
      'tool_call_receipt_keys',
      'toolCallReceiptKeys',
      toolCallReceiptKeyId('idempotency', orphanDigest),
      {
        agentId: 'owner',
        taskId: 'pruned-task',
        receiptId: 'missing',
        kind: 'idempotency',
        digest: orphanDigest,
      },
    );
    expect(() =>
      validateMigrationReferences(
        [agent('owner'), receipt, modelKey, idempotencyKey, orphanKey],
        'owner',
      ),
    ).toThrow('Invalid compact tool-call receipt key');
    expect(() =>
      validateMigrationReferences(
        [
          agent('owner'),
          { ...receipt, data: { ...receipt.data, effectOutcome: 'executed' } },
          modelKey,
          idempotencyKey,
        ],
        'owner',
      ),
    ).toThrow('Invalid compact tool-call receipt');
  });
});
