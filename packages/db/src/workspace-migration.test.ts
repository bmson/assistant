import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  idempotencyIdentityDigest,
  MIGRATION_TABLES,
  modelToolCallIdentityDigest,
  toolCallReceiptKeyId,
} from '@assistant/persistence';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { allocateTestTarget, assertAllocatedTestTarget } from './test-target.js';
import { exportWorkspaceSnapshot } from './workspace-migration.js';

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
    compactToolCall: randomUUID(),
    failedReceipt: randomUUID(),
    completedReceipt: randomUUID(),
    mailbox: `migration-${randomUUID()}@example.test`,
  };
  let sql: postgres.Sql;

  afterEach(async () => {
    if (!sql) return;
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
      expect(Object.keys(complete.manifest.tables)).toHaveLength(MIGRATION_TABLES.length);
      const exportedModel = complete.records.find((record) => record.table === 'models');
      expect(exportedModel?.data).toHaveProperty('promptCostPerMTok');
      expect(exportedModel?.data).toHaveProperty('completionCostPerMTok');
      expect(exportedModel?.data).not.toHaveProperty('promptCostPerMtok');
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
        ]),
        omittedTables: [],
      });
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
