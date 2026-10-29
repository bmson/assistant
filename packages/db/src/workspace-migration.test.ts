import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  idempotencyIdentityDigest,
  MIGRATION_TABLES,
  modelToolCallIdentityDigest,
  OWNER_EDITOR_RUNTIME_EXCLUSIONS_V1,
  toolCallReceiptKeyId,
} from '@assistant/persistence';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { allocateTestTarget, assertAllocatedTestTarget } from './test-target.js';
import {
  exportWorkspaceSnapshot,
  filterPortableMaintenanceCursorRows,
} from './workspace-migration.js';

describe('portable owner editor cursor filtering', () => {
  it('filters only the reserved editor epoch cursor before portable record checksums', () => {
    const rows = [
      { name: 'owner-editor-epoch:owner', cursor: '{"epoch":"private"}' },
      { name: 'privacy-erasure-generation:owner', cursor: 'generation-1' },
      { name: 'approval-recovery', cursor: 'task-1' },
    ];
    expect(filterPortableMaintenanceCursorRows(rows)).toEqual(rows.slice(1));
  });
});

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && new URL(databaseUrl).pathname.endsWith('_test'));

async function withDisposableWorkspaceDatabase<T>(
  run: (client: postgres.Sql, databaseUrl: string) => Promise<T>,
): Promise<T> {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const target = allocateTestTarget(process.env.DATABASE_URL);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  let result: { value: T } | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
    });
    result = { value: await run(client, target.databaseUrl) };
  } catch (error) {
    primaryError = error;
  } finally {
    const attemptCleanup = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (client) await attemptCleanup(() => client!.end({ timeout: 5 }));
    if (created)
      await attemptCleanup(async () => {
        const [owned] = await admin<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_database') AS marker
          FROM pg_database WHERE datname = ${target.databaseName}
        `;
        if (owned?.marker !== `assistant-test-target:${target.token}`)
          throw new Error('Workspace export test database ownership mismatch');
        await admin.unsafe(`DROP DATABASE "${target.databaseName}" WITH (FORCE)`);
      });
    await attemptCleanup(() => admin.end({ timeout: 5 }));
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Workspace export test and cleanup failed',
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Workspace export test cleanup failed');
  if (!result) throw new Error('Workspace export test produced no result');
  return result.value;
}

describe.skipIf(!enabled)('PostgreSQL workspace migration export', () => {
  const ids = {
    agent: randomUUID(),
    conversation: randomUUID(),
    task: randomUUID(),
    missionReport: `report-${randomUUID()}`,
    contact: randomUUID(),
    memory: randomUUID(),
    occasion: randomUUID(),
    importSourceId: randomUUID(),
    importSource: `lineage-${randomUUID()}`,
    callbackReceipt: `callback-${randomUUID()}`,
    refreshReceipt: `refresh-${randomUUID()}`,
    file: randomUUID(),
    message: randomUUID(),
    message2: randomUUID(),
    sample: randomUUID(),
    activeToolCall: randomUUID(),
    ownerCallToolCall: randomUUID(),
    ownerCallApproval: randomUUID(),
    ownerCallGrantHistorical: randomUUID(),
    ownerCallGrantCurrent: randomUUID(),
    ownerCallEmptySlotApproval: randomUUID(),
    ownerCallUsagePolicy: randomUUID(),
    callSession: randomUUID(),
    compactToolCall: randomUUID(),
    failedReceipt: randomUUID(),
    completedReceipt: randomUUID(),
    mailbox: `migration-${randomUUID()}@example.test`,
  };
  let sql: postgres.Sql;

  afterEach(async () => {
    if (!sql) return;
    await sql`delete from call_sessions where id = ${ids.callSession}`;
    await sql`delete from gmail_sync_state where mailbox = ${ids.mailbox}`;
    await sql`delete from import_sources where id = ${ids.importSourceId}`;
    await sql`delete from occasions where id = ${ids.occasion}`;
    await sql`delete from memories where id = ${ids.memory}`;
    await sql`delete from contacts where id = ${ids.contact}`;
    await sql`delete from files where id = ${ids.file}`;
    await sql`delete from messages where id = ${ids.message}`;
    await sql`delete from messages where id = ${ids.message2}`;
    await sql`delete from writing_samples where id = ${ids.sample}`;
    await sql`delete from tool_call_receipt_keys where receipt_id = ${ids.compactToolCall}`;
    await sql`delete from tool_call_receipts where id in (${ids.compactToolCall}, ${ids.failedReceipt}, ${ids.completedReceipt})`;
    await sql`delete from tool_calls where id in (${ids.activeToolCall}, ${ids.compactToolCall})`;
    await sql`delete from tasks where id = ${ids.task}`;
    await sql`delete from conversations where id = ${ids.conversation}`;
    await sql`delete from agents where id = ${ids.agent}`;
    await sql.end({ timeout: 5 });
    sql = undefined as unknown as postgres.Sql;
  });

  it('exports a consistent, workspace-scoped snapshot with deterministic record checksums', async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await sql`insert into agents (id, name, email, workspace_prefix) values (${ids.agent}, 'Migration test owner', ${`${ids.agent}@example.test`}, ${`workspace/${ids.agent}`})`;
    await sql`insert into conversations (id, agent_id, channel, trust) values (${ids.conversation}, ${ids.agent}, 'chat', 'owner')`;
    await sql`insert into tasks (id, agent_id, type, status, conversation_id, trust) values (${ids.task}, ${ids.agent}, 'adhoc', 'waiting_event', ${ids.conversation}, 'owner')`;
    await sql`insert into messages (id, conversation_id, task_id, role, parts, text, origin, created_at) values (${ids.message}, ${ids.conversation}, ${ids.task}, 'assistant', ${sql.json([])}, 'snapshot message', 'assistant', '2026-09-19 12:34:56.123456+00'::timestamptz), (${ids.message2}, ${ids.conversation}, ${ids.task}, 'assistant', ${sql.json([])}, 'snapshot message 2', 'assistant', '2026-09-19 12:34:56.123789+00'::timestamptz)`;
    await sql`insert into files (id, agent_id, workspace_path, bytes) values (${ids.file}, ${ids.agent}, 'migration/precision.bin', ${Number.MAX_SAFE_INTEGER})`;

    const bundle = await exportWorkspaceSnapshot({
      databaseUrl,
      agentId: ids.agent,
      target: {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: 'migration-test',
      },
      tables: ['agents', 'conversations', 'files', 'messages', 'tasks'],
    });

    expect(bundle.manifest.source.kind).toBe('postgresql');
    expect(bundle.manifest.source.agentId).toBe(ids.agent);
    expect(bundle.records.map((record) => `${record.table}/${record.id}`)).toEqual(
      [
        `agents/${ids.agent}`,
        `conversations/${ids.conversation}`,
        `files/${ids.file}`,
        `messages/${ids.message}`,
        `messages/${ids.message2}`,
        `tasks/${ids.task}`,
      ].sort(),
    );
    expect(bundle.records.find((record) => record.id === ids.message)?.data.text).toBe(
      'snapshot message',
    );
    const messageRecords = bundle.records.filter((record) => record.table === 'messages');
    expect(messageRecords.find((record) => record.id === ids.message)?.data.createdAt).toEqual({
      $assistantMigration: ['timestamp', '2026-09-19T12:34:56.123456Z'],
    });
    expect(messageRecords.find((record) => record.id === ids.message2)?.data.createdAt).toEqual({
      $assistantMigration: ['timestamp', '2026-09-19T12:34:56.123789Z'],
    });
    expect(messageRecords.find((record) => record.id === ids.message)?.checksum).not.toBe(
      messageRecords.find((record) => record.id === ids.message2)?.checksum,
    );
    expect(bundle.manifest.formatVersion).toBe(3);
    expect(bundle.records.find((record) => record.id === ids.file)?.data.bytes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(bundle.manifest.recordCount).toBe(6);
    expect(bundle.manifest.bundleChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exports every declared PostgreSQL table for a single-owner installation', async () => {
    if (!databaseUrl) return;
    await withDisposableWorkspaceDatabase(async (client, isolatedUrl) => {
      const owner = { id: ids.agent };
      await client`insert into agents (id, name, email, workspace_prefix) values (${owner.id}, 'Migration test owner', ${`${owner.id}@example.test`}, ${`workspace/${owner.id}`})`;
      await client`insert into models (id, label, capabilities, enabled) values ('synthetic/migration-export', 'Migration export model', '{}'::jsonb, true)`;
      await client`insert into tasks (id, agent_id, type, status, trust) values (${ids.task}, ${owner.id}, 'adhoc', 'waiting_event', 'owner')`;
      const modelToolCallId = 'model-call-private-identity';
      const idempotencyKey = 'private-idempotency-identity';
      const modelHash = modelToolCallIdentityDigest(owner.id, ids.task, modelToolCallId);
      const idempotencyHash = idempotencyIdentityDigest(idempotencyKey);
      if (!modelHash || !idempotencyHash) throw new Error('receipt identity fixture invalid');
      await client`insert into tool_calls (id, task_id, step, tool_name, args, risk, status, decision) values (${ids.activeToolCall}, ${ids.task}, 1, 'gmail.send', ${JSON.stringify({ to: 'private@example.test', body: 'private active payload' })}::jsonb, 'approval', 'approved', ${JSON.stringify({ modelToolCallId, privateContext: 'do not compact active row' })}::jsonb)`;
      await client`insert into tool_calls (id, task_id, step, tool_name, args, risk, status, decision) values (${ids.ownerCallToolCall}, ${ids.task}, 2, 'phone.call', ${JSON.stringify({ brief: { to: '+14155550123', maxMinutes: 8 } })}::jsonb, 'approval', 'approved', '{}'::jsonb)`;
      await client`insert into approvals (id, task_id, tool_call_id, short_code, summary, status, expires_at) values (${ids.ownerCallApproval}, ${ids.task}, ${ids.ownerCallToolCall}, 'A20001', 'Owner approved a bounded call request', 'approved', '2026-12-01 00:00:00+00')`;
      await client`update tool_calls set approval_id = ${ids.ownerCallApproval} where id = ${ids.ownerCallToolCall}`;
      const historicalRequestFingerprint = 'c'.repeat(64);
      const historicalScopeFingerprint = 'b'.repeat(64);
      const currentRequestFingerprint = 'd'.repeat(64);
      const currentScopeFingerprint = 'a'.repeat(64);
      await client`insert into owner_call_grant_operations (owner_id, approval_id, grant_id, purpose, schema_version, operation_version, task_id, tool_call_id, slot_generation, request_fingerprint, grant_scope_fingerprint, phase, registered_at, review_expires_at, grant_expires_at, admitted_at, committed_at, closed_at, rejected_at, created_policy_id, wake_generation, updated_at) values
        (${owner.id}, ${ids.ownerCallApproval}, ${ids.ownerCallGrantHistorical}, 'owner-call-grant-operation.v1', 1, 1, ${ids.task}, ${ids.ownerCallToolCall}, 1, ${historicalRequestFingerprint}, ${historicalScopeFingerprint}, 'closed_no_effect', '2026-10-19 08:00:00.000001+00', '2026-10-19 09:00:00.000001+00', '2026-10-20 08:00:00.000001+00', null, null, '2026-10-19 08:01:00.000002+00', null, null, null, '2026-10-19 08:01:00.000002+00'),
        (${owner.id}, ${ids.ownerCallApproval}, ${ids.ownerCallGrantCurrent}, 'owner-call-grant-operation.v1', 1, 1, ${ids.task}, ${ids.ownerCallToolCall}, 2, ${currentRequestFingerprint}, ${currentScopeFingerprint}, 'admitted', '2026-10-20 10:15:16.123456+00', '2026-10-20 10:45:16.123456+00', '2026-10-21 10:15:16.123456+00', '2026-10-20 10:16:17.654321+00', null, null, null, null, null, '2026-10-20 10:16:17.654321+00')`;
      await client`insert into owner_call_grant_operation_slots (owner_id, approval_id, purpose, schema_version, generation, current_grant_id, updated_at) values
        (${owner.id}, ${ids.ownerCallApproval}, 'owner-call-grant-operation.v1', 1, 2, ${ids.ownerCallGrantCurrent}, '2026-10-20 10:16:17.654321+00'),
        (${owner.id}, ${ids.ownerCallEmptySlotApproval}, 'owner-call-grant-operation.v1', 1, 0, null, '2026-10-20 10:16:17.654321+00')`;
      await client`insert into owner_call_grant_usage (owner_id, policy_id, grant_scope_fingerprint, events, updated_at) values (${owner.id}, ${ids.ownerCallUsagePolicy}, ${'e'.repeat(64)}, ${JSON.stringify(
        [
          {
            toolCallId: ids.ownerCallToolCall,
            at: '2026-10-20T10:17:18.123456Z',
            costUsdMicros: 500000,
          },
          {
            toolCallId: ids.failedReceipt,
            at: '2026-10-20T10:17:19.654321Z',
            costUsdMicros: 250000,
          },
        ],
      )}::jsonb, '2026-10-20 10:17:19.654321+00')`;
      const voiceReceipt = {
        id: 'c'.repeat(64),
        provider: 'openai',
        kind: 'note',
        argsDigest: 'd'.repeat(64),
        effectId: null,
        committedAt: '2026-10-08T12:00:00.000Z',
      };
      await client`insert into call_sessions (id, agent_id, task_id, tool_call_id, status, "to", brief, voice_model, max_minutes, callback_token, voice_tool_receipts) values (${ids.callSession}, ${owner.id}, ${ids.task}, ${ids.activeToolCall}, 'in_progress', '+14155550123', ${JSON.stringify({ goal: 'Book dinner' })}::jsonb, 'openai:gpt-realtime', 10, 'opaque-callback-token', ${JSON.stringify([voiceReceipt])}::jsonb)`;
      await client`insert into tool_call_receipts (id, agent_id, task_id, tool_call_id, model_tool_call_id_hash, idempotency_key_hash, tool_name, effect_outcome, recorded_at) values (${ids.compactToolCall}, ${owner.id}, ${ids.task}, ${ids.compactToolCall}, ${modelHash}, ${idempotencyHash}, 'gmail.send', 'unknown', '2026-10-07 12:00:00+00'), (${ids.failedReceipt}, ${owner.id}, ${ids.task}, ${ids.failedReceipt}, null, null, 'gmail.send', 'failed', '2026-10-07 12:00:00+00'), (${ids.completedReceipt}, ${owner.id}, ${ids.task}, ${ids.completedReceipt}, null, null, 'gmail.send', 'completed', '2026-10-07 12:00:00+00')`;
      await client`insert into tool_call_receipt_keys (id, agent_id, task_id, receipt_id, kind, digest) values (${toolCallReceiptKeyId('model_tool_call', modelHash)}, ${owner.id}, ${ids.task}, ${ids.compactToolCall}, 'model_tool_call', ${modelHash}), (${toolCallReceiptKeyId('idempotency', idempotencyHash)}, ${owner.id}, ${ids.task}, ${ids.compactToolCall}, 'idempotency', ${idempotencyHash})`;
      await client`insert into mission_reports (id, agent_id, mission_id, outcome, text) values (${ids.missionReport}, ${owner.id}, ${ids.task}, 'completed', 'The mission report is part of the owner workspace.')`;
      await client`insert into gmail_sync_state (mailbox, last_history_id) values (${ids.mailbox}, 9223372036854775807)`;
      await client`insert into writing_samples (id, register, text, context) values (${ids.sample}, 'email_casual', 'Owner voice sample for migration ownership', 'upload:test')`;
      await client`insert into contacts (id, name) values (${ids.contact}, 'Migration lineage test contact')`;
      await client`insert into import_sources (id, agent_id, source, workspace_path, kind, status) values (${ids.importSourceId}, ${owner.id}, ${ids.importSource}, 'import/migration-lineage.mbox', 'mbox', 'done')`;
      await client`insert into memories (id, agent_id, category, kind, content, content_hash, source) values (${ids.memory}, ${owner.id}, 'knowledge', 'fact', 'Migration lineage test fact', ${`lineage-${ids.memory}`}, ${ids.importSource})`;
      await client`insert into occasions (id, agent_id, contact_id, kind, month, day, source) values (${ids.occasion}, ${owner.id}, ${ids.contact}, 'birthday', 6, 12, ${ids.importSource})`;
      await client`insert into memory_import_lineage (source, memory_id) values (${ids.importSource}, ${ids.memory})`;
      const preparedVector = `[${Array.from({ length: 1536 }, (_, index) => (index === 0 ? 0.5 : 0)).join(',')}]`;
      await client`insert into memory_embedding_refreshes (id, agent_id, memory_id, source_hash, target_space_key, target_dimensions, status, prepared_vector) values (${ids.refreshReceipt}, ${owner.id}, ${ids.memory}, ${`a`.repeat(64)}, ${`b`.repeat(64)}, 1536, 'prepared', ${preparedVector}::vector)`;
      await client`insert into occasion_import_lineage (source, occasion_id) values (${ids.importSource}, ${ids.occasion})`;
      await client`insert into execution_job_callback_receipts (idempotency_key, task_id, token_hash, payload_digest, queue_generation) values (${ids.callbackReceipt}, ${ids.task}, repeat('a', 64), repeat('b', 64), 2)`;
      const complete = await exportWorkspaceSnapshot({
        databaseUrl: isolatedUrl,
        agentId: owner.id,
        target: {
          projectId: 'demo-assistant-test',
          databaseId: '(default)',
          installationId: 'migration-test',
        },
        embeddingSpace: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          revision: '1',
        },
      });
      const physicalTables = await client<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name
      `;
      const runtimeExclusions = new Set<string>(OWNER_EDITOR_RUNTIME_EXCLUSIONS_V1.tables);
      expect(
        physicalTables.map((row) => row.table_name).filter((name) => !runtimeExclusions.has(name)),
      ).toEqual(MIGRATION_TABLES.map(({ table }) => table).sort());
      expect(Object.keys(complete.manifest.tables)).toHaveLength(MIGRATION_TABLES.length);
      const exportedModel = complete.records.find((record) => record.table === 'models');
      expect(exportedModel?.data).toHaveProperty('promptCostPerMTok');
      expect(exportedModel?.data).toHaveProperty('completionCostPerMTok');
      expect(exportedModel?.data).not.toHaveProperty('promptCostPerMtok');
      expect(
        complete.records.find(
          (record) => record.table === 'call_sessions' && record.id === ids.callSession,
        )?.data.voiceToolReceipts,
      ).toEqual([voiceReceipt]);
      expect(complete.manifest.coverage).toEqual({
        complete: true,
        supportedTables: expect.arrayContaining([
          'agents',
          'messages',
          'knowledge_graph_relations',
          'email_attachment_custodies',
          'email_observer_budgets',
          'email_observer_sources',
          'email_observer_work',
          'owner_call_grant_operations',
          'owner_call_grant_operation_slots',
          'owner_call_grant_usage',
        ]),
        omittedTables: [],
        runtimeExclusions: OWNER_EDITOR_RUNTIME_EXCLUSIONS_V1,
      });
      const tupleDocumentId = (parts: string[]) =>
        createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
      const historicalOperationId = tupleDocumentId([
        'owner-call-grant-operation-v1',
        owner.id,
        ids.ownerCallApproval,
        ids.ownerCallGrantHistorical,
      ]);
      const currentOperationId = tupleDocumentId([
        'owner-call-grant-operation-v1',
        owner.id,
        ids.ownerCallApproval,
        ids.ownerCallGrantCurrent,
      ]);
      const currentSlotId = tupleDocumentId([
        'owner-call-grant-slot-v1',
        owner.id,
        ids.ownerCallApproval,
      ]);
      const emptySlotId = tupleDocumentId([
        'owner-call-grant-slot-v1',
        owner.id,
        ids.ownerCallEmptySlotApproval,
      ]);
      const historicalOperation = complete.records.find(
        (record) =>
          record.table === 'owner_call_grant_operations' && record.id === historicalOperationId,
      );
      expect(historicalOperation?.data).toEqual({
        ownerId: owner.id,
        approvalId: ids.ownerCallApproval,
        grantId: ids.ownerCallGrantHistorical,
        purpose: 'owner-call-grant-operation.v1',
        schemaVersion: 1,
        operationVersion: 1,
        taskId: ids.task,
        toolCallId: ids.ownerCallToolCall,
        slotGeneration: 1,
        requestFingerprint: historicalRequestFingerprint,
        grantScopeFingerprint: historicalScopeFingerprint,
        phase: 'closed_no_effect',
        registeredAt: { $assistantMigration: ['timestamp', '2026-10-19T08:00:00.000001Z'] },
        reviewExpiresAt: { $assistantMigration: ['timestamp', '2026-10-19T09:00:00.000001Z'] },
        grantExpiresAt: { $assistantMigration: ['timestamp', '2026-10-20T08:00:00.000001Z'] },
        admittedAt: null,
        committedAt: null,
        closedAt: { $assistantMigration: ['timestamp', '2026-10-19T08:01:00.000002Z'] },
        rejectedAt: null,
        createdPolicyId: null,
        wakeGeneration: null,
        updatedAt: { $assistantMigration: ['timestamp', '2026-10-19T08:01:00.000002Z'] },
      });
      const currentOperation = complete.records.find(
        (record) =>
          record.table === 'owner_call_grant_operations' && record.id === currentOperationId,
      );
      expect(currentOperation?.data).toEqual({
        ownerId: owner.id,
        approvalId: ids.ownerCallApproval,
        grantId: ids.ownerCallGrantCurrent,
        purpose: 'owner-call-grant-operation.v1',
        schemaVersion: 1,
        operationVersion: 1,
        taskId: ids.task,
        toolCallId: ids.ownerCallToolCall,
        slotGeneration: 2,
        requestFingerprint: currentRequestFingerprint,
        grantScopeFingerprint: currentScopeFingerprint,
        phase: 'admitted',
        registeredAt: { $assistantMigration: ['timestamp', '2026-10-20T10:15:16.123456Z'] },
        reviewExpiresAt: { $assistantMigration: ['timestamp', '2026-10-20T10:45:16.123456Z'] },
        grantExpiresAt: { $assistantMigration: ['timestamp', '2026-10-21T10:15:16.123456Z'] },
        admittedAt: { $assistantMigration: ['timestamp', '2026-10-20T10:16:17.654321Z'] },
        committedAt: null,
        closedAt: null,
        rejectedAt: null,
        createdPolicyId: null,
        wakeGeneration: null,
        updatedAt: { $assistantMigration: ['timestamp', '2026-10-20T10:16:17.654321Z'] },
      });
      expect(
        complete.records.filter((record) => record.table === 'owner_call_grant_operations'),
      ).toHaveLength(2);
      const grantSlots = complete.records.filter(
        (record) => record.table === 'owner_call_grant_operation_slots',
      );
      expect(grantSlots).toHaveLength(2);
      expect(grantSlots.find((record) => record.id === currentSlotId)?.data).toEqual({
        ownerId: owner.id,
        approvalId: ids.ownerCallApproval,
        purpose: 'owner-call-grant-operation.v1',
        schemaVersion: 1,
        generation: 2,
        currentGrantId: ids.ownerCallGrantCurrent,
        updatedAt: { $assistantMigration: ['timestamp', '2026-10-20T10:16:17.654321Z'] },
      });
      expect(grantSlots.find((record) => record.id === emptySlotId)?.data).toEqual({
        ownerId: owner.id,
        approvalId: ids.ownerCallEmptySlotApproval,
        purpose: 'owner-call-grant-operation.v1',
        schemaVersion: 1,
        generation: 0,
        currentGrantId: null,
        updatedAt: { $assistantMigration: ['timestamp', '2026-10-20T10:16:17.654321Z'] },
      });
      const usageFingerprint = 'e'.repeat(64);
      const usageRecordId = `${owner.id}_${ids.ownerCallUsagePolicy}_${usageFingerprint}`;
      const usageRecord = complete.records.find(
        (record) => record.table === 'owner_call_grant_usage' && record.id === usageRecordId,
      );
      expect(usageRecord?.data).toEqual({
        ownerId: owner.id,
        policyId: ids.ownerCallUsagePolicy,
        grantScopeFingerprint: usageFingerprint,
        events: [
          {
            toolCallId: ids.ownerCallToolCall,
            at: { $assistantMigration: ['timestamp', '2026-10-20T10:17:18.123456Z'] },
            costUsdMicros: 500_000,
          },
          {
            toolCallId: ids.failedReceipt,
            at: { $assistantMigration: ['timestamp', '2026-10-20T10:17:19.654321Z'] },
            costUsdMicros: 250_000,
          },
        ],
        updatedAt: { $assistantMigration: ['timestamp', '2026-10-20T10:17:19.654321Z'] },
      });
      expect(
        complete.records.filter((record) => record.table === 'owner_call_grant_usage'),
      ).toHaveLength(1);
      expect(
        complete.records.find(
          (record) => record.table === 'gmail_sync_state' && record.id === ids.mailbox,
        )?.data.lastHistoryId,
      ).toEqual({ $assistantMigration: ['bigint', '9223372036854775807'] });
      expect(
        complete.records.find(
          (record) => record.table === 'writing_samples' && record.id === ids.sample,
        )?.data.agentId,
      ).toBe(owner.id);
      expect(
        complete.records.find((record) => record.table === 'memory_import_lineage')?.data,
      ).toMatchObject({ source: ids.importSource, memoryId: ids.memory });
      const refreshReceipt = complete.records.find(
        (record) =>
          record.table === 'memory_embedding_refreshes' && record.id === ids.refreshReceipt,
      );
      expect(refreshReceipt?.data.embeddingSpaceKey).toBeUndefined();
      expect(refreshReceipt?.data.preparedVector).toEqual({
        $assistantMigration: ['vector', expect.arrayContaining([0.5])],
      });
      expect(
        complete.records.find((record) => record.table === 'memories' && record.id === ids.memory)
          ?.data.embeddingSpaceKey,
      ).toBeNull();
      expect(
        complete.records.find((record) => record.table === 'occasion_import_lineage')?.data,
      ).toMatchObject({ source: ids.importSource, occasionId: ids.occasion });
      expect(
        complete.records.find(
          (record) =>
            record.table === 'execution_job_callback_receipts' && record.id === ids.callbackReceipt,
        )?.data,
      ).toMatchObject({ taskId: ids.task, queueGeneration: 2 });
      expect(
        complete.records.find(
          (record) => record.table === 'mission_reports' && record.id === ids.missionReport,
        )?.data,
      ).toMatchObject({
        agentId: owner.id,
        missionId: ids.task,
        outcome: 'completed',
        text: 'The mission report is part of the owner workspace.',
      });
      const activeCall = complete.records.find(
        (record) => record.table === 'tool_calls' && record.id === ids.activeToolCall,
      );
      expect(activeCall?.data).toMatchObject({
        args: { to: 'private@example.test', body: 'private active payload' },
        decision: {
          modelToolCallId: 'model-call-private-identity',
          privateContext: 'do not compact active row',
        },
      });
      const compact = complete.records.find(
        (record) => record.table === 'tool_call_receipts' && record.id === ids.compactToolCall,
      );
      expect(compact?.data).toMatchObject({
        agentId: owner.id,
        taskId: ids.task,
        toolCallId: ids.compactToolCall,
        modelToolCallIdHash: modelHash,
        idempotencyKeyHash: idempotencyHash,
        effectOutcome: 'unknown',
      });
      for (const field of ['args', 'result', 'error', 'modelToolCallId', 'idempotencyKey'])
        expect(compact?.data).not.toHaveProperty(field);
      const receiptKeys = complete.records.filter(
        (record) => record.table === 'tool_call_receipt_keys',
      );
      expect(receiptKeys).toHaveLength(2);
      expect(receiptKeys.map((record) => record.data.digest)).toEqual(
        expect.arrayContaining([modelHash, idempotencyHash]),
      );
      expect(
        complete.records
          .filter(
            (record) =>
              record.table === 'tool_call_receipts' &&
              new Set<string>([ids.failedReceipt, ids.completedReceipt]).has(record.id),
          )
          .map((record) => record.data.effectOutcome),
      ).toEqual(expect.arrayContaining(['failed', 'completed']));
    });
  });

  it('exports only the selected owner’s owner-call grant rows from a multi-agent database', async () => {
    await withDisposableWorkspaceDatabase(async (client, isolatedUrl) => {
      const ownerId = randomUUID();
      const otherOwnerId = randomUUID();
      const approvalIds = [randomUUID(), randomUUID()] as const;
      const grantIds = [randomUUID(), randomUUID()] as const;
      const taskIds = [randomUUID(), randomUUID()] as const;
      const toolCallIds = [randomUUID(), randomUUID()] as const;
      const fingerprints = ['a'.repeat(64), 'b'.repeat(64)] as const;
      await client`insert into agents (id, name, email, workspace_prefix) values
        (${ownerId}, 'Selected owner', ${`${ownerId}@example.test`}, ${`workspace/${ownerId}`}),
        (${otherOwnerId}, 'Other owner', ${`${otherOwnerId}@example.test`}, ${`workspace/${otherOwnerId}`})`;
      await client`insert into owner_call_grant_operations (owner_id, approval_id, grant_id, purpose, schema_version, operation_version, task_id, tool_call_id, slot_generation, request_fingerprint, grant_scope_fingerprint, phase, registered_at, review_expires_at, grant_expires_at, admitted_at, committed_at, closed_at, rejected_at, created_policy_id, wake_generation, updated_at) values
        (${ownerId}, ${approvalIds[0]}, ${grantIds[0]}, 'owner-call-grant-operation.v1', 1, 1, ${taskIds[0]}, ${toolCallIds[0]}, 1, ${fingerprints[0]}, ${fingerprints[0]}, 'registered', '2026-10-20 10:00:00+00', '2026-10-20 11:00:00+00', '2026-10-21 10:00:00+00', null, null, null, null, null, null, '2026-10-20 10:00:00+00'),
        (${otherOwnerId}, ${approvalIds[1]}, ${grantIds[1]}, 'owner-call-grant-operation.v1', 1, 1, ${taskIds[1]}, ${toolCallIds[1]}, 1, ${fingerprints[1]}, ${fingerprints[1]}, 'registered', '2026-10-20 10:00:00+00', '2026-10-20 11:00:00+00', '2026-10-21 10:00:00+00', null, null, null, null, null, null, '2026-10-20 10:00:00+00')`;
      await client`insert into owner_call_grant_operation_slots (owner_id, approval_id, purpose, schema_version, generation, current_grant_id, updated_at) values
        (${ownerId}, ${approvalIds[0]}, 'owner-call-grant-operation.v1', 1, 1, ${grantIds[0]}, '2026-10-20 10:00:00+00'),
        (${otherOwnerId}, ${approvalIds[1]}, 'owner-call-grant-operation.v1', 1, 1, ${grantIds[1]}, '2026-10-20 10:00:00+00')`;
      await client`insert into owner_call_grant_usage (owner_id, policy_id, grant_scope_fingerprint, events, updated_at) values
        (${ownerId}, ${randomUUID()}, ${fingerprints[0]}, '[]'::jsonb, '2026-10-20 10:00:00+00'),
        (${otherOwnerId}, ${randomUUID()}, ${fingerprints[1]}, '[]'::jsonb, '2026-10-20 10:00:00+00')`;

      const exported = await exportWorkspaceSnapshot({
        databaseUrl: isolatedUrl,
        agentId: ownerId,
        target: {
          projectId: 'demo-assistant-test',
          databaseId: '(default)',
          installationId: 'migration-test',
        },
        tables: [
          'agents',
          'owner_call_grant_operations',
          'owner_call_grant_operation_slots',
          'owner_call_grant_usage',
        ],
      });
      expect(
        exported.records.filter((record) => record.table === 'agents').map((record) => record.id),
      ).toEqual([ownerId]);
      expect([...new Set(exported.records.map((record) => record.table))].sort()).toEqual(
        [
          'agents',
          'owner_call_grant_operations',
          'owner_call_grant_operation_slots',
          'owner_call_grant_usage',
        ].sort(),
      );
      for (const table of [
        'owner_call_grant_operations',
        'owner_call_grant_operation_slots',
        'owner_call_grant_usage',
      ]) {
        const rows = exported.records.filter((record) => record.table === table);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.data.ownerId).toBe(ownerId);
        expect(rows[0]?.data.ownerId).not.toBe(otherOwnerId);
      }
      expect(exported.manifest.coverage.complete).toBe(false);
      expect(exported.manifest.coverage.supportedTables).toEqual([
        'agents',
        'owner_call_grant_operations',
        'owner_call_grant_operation_slots',
        'owner_call_grant_usage',
      ]);
    });
  });

  it('rejects installation-wide export when PostgreSQL has multiple agents', async () => {
    if (!databaseUrl) return;
    const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const second = randomUUID();
    try {
      await client`insert into agents (id, name, email, workspace_prefix) values (${second}, 'Second', ${`${second}@example.test`}, ${`workspace/${second}`})`;
      await expect(
        exportWorkspaceSnapshot({
          databaseUrl,
          agentId: ids.agent,
          target: { projectId: 'demo', databaseId: '(default)', installationId: 'x' },
          tables: ['agents', 'contacts'],
        }),
      ).rejects.toThrow('exactly one PostgreSQL agent');
      await client`delete from agents where id = ${second}`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
