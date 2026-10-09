import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { resolveApproval } from './approval-repository.js';
import { createDb } from './client.js';
import {
  allocateTestTarget,
  assertAllocatedTestTarget,
  isolatedTestEnvironment,
} from './test-target.js';

const exec = promisify(execFile);
const folder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
// Snapshot at import prevents an actively authored migration being mistaken for a
// reviewed historical prefix. The full endpoint is the current immutable journal.
// Every shipped historical prefix is an upgrade target, including the 0020
// timestamp inversion. The current prefix is covered by each idempotent rerun.
const historicalPrefixes: number[] = journal.entries
  .slice(0, -1)
  .map((entry: { idx: number }) => entry.idx);
it.each(historicalPrefixes)(
  'upgrades real migration prefix %i and retains owner settings on retry',
  async (prefix) => {
    assertAllocatedTestTarget({
      databaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    });
    const target = allocateTestTarget(process.env.DATABASE_URL);
    const adminUrl = new URL(target.databaseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    const prefixDir = await mkdtemp(join(tmpdir(), 'assistant-upgrade-'));
    let created = false;
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
      created = true;
      await admin.unsafe(
        `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
      );
      client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
      await mkdir(join(prefixDir, 'meta'));
      const entries = journal.entries.slice(0, prefix + 1);
      await writeFile(
        join(prefixDir, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const entry of entries)
        await writeFile(
          join(prefixDir, `${entry.tag}.sql`),
          await readFile(join(folder, `${entry.tag}.sql`)),
        );
      await migrate(drizzle(client), { migrationsFolder: prefixDir });
      const owner = randomUUID();
      await client`INSERT INTO agents (id,name,email,workspace_prefix,timezone,locale,signature) VALUES (${owner},'Synthetic upgrade owner',${`${owner}@example.test`},${`workspace/${owner}`},'America/Los_Angeles','is','Owner supplied signature')`;
      await client`INSERT INTO budgets(scope,limit_usd) VALUES ('daily','73.25')`;
      const [roles] = await client`SELECT to_regclass('public.model_roles') AS exists`;
      if (roles?.exists) {
        await client`INSERT INTO models(id,label,capabilities,enabled) VALUES ('synthetic/custom-chat','Owner model','{}',true), ('synthetic/custom-fallback','Owner fallback','{}',true)`;
        await client`INSERT INTO model_roles(role,primary_model,fallback_model) VALUES ('draft','synthetic/custom-chat','synthetic/custom-fallback')`;
        // Journal prefix 18 is the real schema immediately before migration
        // 0019 (idx 19). Its extract role makes the shipped migrate preflight
        // take the legacy catalog-bootstrap branch before 0019's FK update.
        if (prefix === 18) {
          await client`INSERT INTO models(id,label,capabilities,enabled) VALUES ('synthetic/pre-0019-extract-primary','Legacy extract primary','{}',true), ('synthetic/pre-0019-extract-fallback','Legacy extract fallback','{}',true)`;
          await client`INSERT INTO model_roles(role,primary_model,fallback_model) VALUES ('extract','synthetic/pre-0019-extract-primary','synthetic/pre-0019-extract-fallback')`;
        }
      }
      await client.end();
      client = undefined;
      const env = {
        ...isolatedTestEnvironment(process.env),
        DATABASE_URL: target.databaseUrl,
        TEST_DATABASE_URL: target.databaseUrl,
        ASSISTANT_TEST_TARGET_TOKEN: target.token,
      };
      // Use the shipped preflight and migration entry point, including historical
      // model foreign-key compatibility handling, rather than a bespoke upgrade.
      await exec('pnpm', ['migrate'], { cwd, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
      await exec('pnpm', ['migrate'], { cwd, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
      client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
      expect(await client`SELECT id,timezone,locale,signature FROM agents`).toEqual([
        {
          id: owner,
          timezone: 'America/Los_Angeles',
          locale: 'is',
          signature: 'Owner supplied signature',
        },
      ]);
      expect((await client`SELECT limit_usd FROM budgets WHERE scope='daily'`)[0]?.limit_usd).toBe(
        '73.25',
      );
      if (roles?.exists)
        expect(
          (await client`SELECT primary_model FROM model_roles WHERE role='draft'`)[0]
            ?.primary_model,
        ).toBe('synthetic/custom-chat');
      if (prefix === 18) {
        // These rows are inserted by the shipped preflight only when an
        // existing model_roles.extract row is about to be rewritten by 0019.
        expect(
          await client`SELECT primary_model,fallback_model FROM model_roles WHERE role='extract'`,
        ).toEqual([
          {
            primary_model: 'deepseek/deepseek-chat',
            fallback_model: 'openai/gpt-oss-120b',
          },
        ]);
        expect(
          await client`SELECT id,enabled FROM models WHERE id IN ('deepseek/deepseek-chat','openai/gpt-oss-120b') ORDER BY id`,
        ).toEqual([
          { id: 'deepseek/deepseek-chat', enabled: false },
          { id: 'openai/gpt-oss-120b', enabled: true },
        ]);
      }
      const [identity] =
        await client`SELECT i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='approval_policies_identity_idx'`;
      expect(identity).toMatchObject({ indisunique: true, indisvalid: true });
      expect(identity?.definition).toContain('(agent_id, tool_name, template_key, match, effect)');
      // Prefix 0020 has a newer historical watermark than 0021. Verify the
      // forward correction supports the real approval writer, not just an
      // index/catalog query. Concurrent decisions must remember one policy.
      const pendingApprovals = Array.from({ length: 3 }, () => ({
        taskId: randomUUID(),
        toolCallId: randomUUID(),
        approvalId: randomUUID(),
      }));
      for (const row of pendingApprovals) {
        await client`INSERT INTO tasks (id,agent_id,type,trust,status) VALUES (${row.taskId},${owner},'chat_turn','owner','waiting_approval')`;
        await client`INSERT INTO tool_calls (id,task_id,step,tool_name,risk,status,args) VALUES (${row.toolCallId},${row.taskId},0,'gmail.send','approval','awaiting_approval','{"to":["synthetic@example.test"]}')`;
        await client`INSERT INTO approvals (id,task_id,tool_call_id,short_code,summary,payload,status,expires_at) VALUES (${row.approvalId},${row.taskId},${row.toolCallId},${`A${row.approvalId}`},'Synthetic send','{"to":["synthetic@example.test"]}','pending',clock_timestamp()+interval '1 hour')`;
        await client`UPDATE tool_calls SET approval_id=${row.approvalId} WHERE id=${row.toolCallId}`;
      }
      const upgraded = createDb(target.databaseUrl);
      try {
        const decisions = await Promise.all(
          pendingApprovals.map((row) =>
            resolveApproval(upgraded, {
              approvalId: row.approvalId,
              decision: 'approved',
              via: 'web',
              policy: {
                agentId: owner,
                toolName: 'gmail.send',
                templateKey: 'gmail.send.to_recipient',
                match: { recipient: 'synthetic@example.test' },
                effect: 'allow',
              },
            }),
          ),
        );
        expect(decisions.every((decision) => decision.ok)).toBe(true);
        const policies =
          await client`SELECT id,enabled FROM approval_policies WHERE agent_id=${owner} AND tool_name='gmail.send' AND template_key='gmail.send.to_recipient'`;
        expect(policies).toHaveLength(1);
        expect(policies[0]?.enabled).toBe(true);
        const remembered =
          await client`SELECT status,created_policy_id FROM approvals WHERE id IN ${client(pendingApprovals.map((row) => row.approvalId))}`;
        expect(remembered).toHaveLength(3);
        expect(
          remembered.every(
            (row) => row.status === 'approved' && row.created_policy_id === policies[0]?.id,
          ),
        ).toBe(true);
      } finally {
        await upgraded.$client.end({ timeout: 5 });
      }
      const importIndexes =
        await client`SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('import_sources_agent_source_idx', 'import_sources_agent_workspace_path_idx') ORDER BY c.relname`;
      expect(importIndexes).toHaveLength(2);
      expect(importIndexes.every((index) => index.indisvalid)).toBe(true);
      expect(importIndexes[0]?.definition).toContain('(agent_id, source)');
      expect(importIndexes[1]?.definition).toContain('(agent_id, workspace_path)');
      const receiptIndexes =
        await client`SELECT c.relname, i.indisvalid, i.indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('tool_call_receipts_agent_task_idx', 'tool_call_receipts_model_lookup_idx', 'tool_call_receipts_global_idempotency_idx', 'tool_call_receipt_keys_global_idempotency_idx', 'tool_call_receipt_keys_model_scope_idx', 'tool_call_receipt_keys_receipt_idx')`;
      expect(receiptIndexes).toHaveLength(6);
      expect(receiptIndexes.every((index) => index.indisvalid)).toBe(true);
      expect(receiptIndexes.filter((index) => index.indisunique)).toHaveLength(4);
      const receiptId = randomUUID();
      const absentTask = randomUUID();
      const identityHash = 'a'.repeat(64);
      // Compact evidence must survive task pruning without retaining private payloads.
      await client`INSERT INTO tool_call_receipts (id,agent_id,task_id,tool_call_id,tool_name,effect_outcome,recorded_at,idempotency_key_hash) VALUES (${receiptId},${owner},${absentTask},${receiptId},'synthetic.effect','failed',now(),${identityHash})`;
      await expect(
        client`INSERT INTO tool_call_receipts (id,agent_id,task_id,tool_call_id,tool_name,effect_outcome,recorded_at,idempotency_key_hash) VALUES (${randomUUID()},${owner},${randomUUID()},${randomUUID()},'synthetic.effect','completed',now(),${identityHash})`,
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client`INSERT INTO tool_call_receipts (id,agent_id,task_id,tool_call_id,tool_name,effect_outcome,recorded_at) VALUES (${randomUUID()},${owner},${absentTask},${randomUUID()},'synthetic.effect','invented_success',now())`,
      ).rejects.toMatchObject({ code: '23514' });
      await client`INSERT INTO tool_call_receipt_keys (id,agent_id,task_id,receipt_id,kind,digest) VALUES (${'b'.repeat(64)},${owner},${absentTask},${receiptId},'idempotency',${identityHash})`;
      await expect(
        client`INSERT INTO tool_call_receipt_keys (id,agent_id,task_id,receipt_id,kind,digest) VALUES (${'c'.repeat(64)},${owner},${randomUUID()},${randomUUID()},'idempotency',${identityHash})`,
      ).rejects.toMatchObject({ code: '23505' });
      const receiptColumns =
        await client`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('tool_call_receipts','tool_call_receipt_keys')`;
      expect(
        receiptColumns.filter((column) => ['args', 'result', 'error'].includes(column.column_name)),
      ).toEqual([]);
      // The identity migration must leave legacy vectors explicitly unknown,
      // retain PostgreSQL's fixed width, and expose the exact-space indexes.
      const embeddingTables = [
        'conversation_segments',
        'document_chunks',
        'messages',
        'skills',
        'writing_samples',
      ];
      const spaceColumns = await client`
        SELECT table_name,is_nullable,column_default FROM information_schema.columns
        WHERE table_schema='public' AND column_name='embedding_space_key'
          AND table_name IN ${client(embeddingTables)} ORDER BY table_name`;
      expect(spaceColumns).toHaveLength(5);
      expect(
        spaceColumns.every(
          (column) => column.is_nullable === 'YES' && column.column_default === null,
        ),
      ).toBe(true);
      const vectorColumns = await client`
        SELECT c.relname,format_type(a.atttypid,a.atttypmod) AS type
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ${client(embeddingTables)} AND a.attname='embedding'`;
      expect(vectorColumns).toHaveLength(5);
      expect(vectorColumns.every((column) => column.type === 'vector(1536)')).toBe(true);
      const spaceIndexes = await client`
        SELECT c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE c.relname IN ('conversation_segments_embedding_space_idx','document_chunks_embedding_space_idx',
          'messages_embedding_space_idx','skills_embedding_space_idx','writing_samples_embedding_space_idx')`;
      expect(spaceIndexes).toHaveLength(5);
      const expectedColumns: Record<string, string> = {
        conversation_segments_embedding_space_idx: '(agent_id, embedding_space_key)',
        document_chunks_embedding_space_idx: '(agent_id, embedding_space_key)',
        messages_embedding_space_idx: '(conversation_id, embedding_space_key)',
        skills_embedding_space_idx: '(agent_id, embedding_space_key)',
        writing_samples_embedding_space_idx: '(embedding_space_key)',
      };
      for (const index of spaceIndexes) {
        expect(index.indisvalid).toBe(true);
        expect(index.definition).toContain(expectedColumns[index.relname]);
      }
      expect(
        (
          await client`SELECT max(created_at)::text AS watermark FROM drizzle.__drizzle_migrations`
        )[0]?.watermark,
      ).toBe(String(journal.entries.at(-1).when));
    } finally {
      if (client) await client.end({ timeout: 5 });
      if (created) await dropOwnedUpgradeDatabase(admin, target);
      await admin.end({ timeout: 5 });
      await rm(prefixDir, { recursive: true, force: true });
    }
  },
  120000,
);

async function dropOwnedUpgradeDatabase(
  admin: ReturnType<typeof postgres>,
  target: ReturnType<typeof allocateTestTarget>,
) {
  const [owned] =
    await admin`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=${target.databaseName}`;
  if (owned?.marker !== `assistant-test-target:${target.token}`)
    throw new Error('Upgrade fixture cleanup ownership mismatch');
  await admin.unsafe(`DROP DATABASE "${target.databaseName}"`);
}
