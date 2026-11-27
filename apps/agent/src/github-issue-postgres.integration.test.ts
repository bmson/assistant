import { generateKeyPairSync } from 'node:crypto';
import {
  assertPostgresInstallationOwner,
  createDb,
  createPostgresApprovalPolicyRepository,
  createPostgresApprovalRepository,
  createPostgresCostRepository,
  createPostgresTaskRepository,
  createPostgresToolExecutionRepository,
  type Db,
} from '@assistant/db';
import {
  approvals,
  costEvents,
  costReservations,
  tasks,
  toolCallReceiptKeys,
  toolCalls,
} from '@assistant/db/schema';
import { type ToolContext, ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { createGitHubAppIssueCreator } from '@assistant/tools/github-app-issue-creator';
import { registerGitHubAppIssueTools } from '@assistant/tools/github-app-tools';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../../../scripts/test-target.js';

let db: Db;
let ownerId: string;
const ownedTaskIds: string[] = [];
let ownedDatabase = false;

beforeAll(async () => {
  const target = assertAllocatedTestTargetMarker({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  db = createDb(target.databaseUrl);
  await assertAllocatedTestDatabaseOwnership(db, target);
  ownedDatabase = true;
  ownerId = await assertPostgresInstallationOwner(db);
});

afterAll(async () => {
  try {
    if (ownedDatabase && ownedTaskIds.length) {
      await db.delete(costEvents).where(inArray(costEvents.taskId, ownedTaskIds));
      await db.delete(costReservations).where(inArray(costReservations.taskId, ownedTaskIds));
      await db.delete(toolCallReceiptKeys).where(inArray(toolCallReceiptKeys.taskId, ownedTaskIds));
      await db
        .update(toolCalls)
        .set({ approvalId: null })
        .where(inArray(toolCalls.taskId, ownedTaskIds));
      await db.delete(approvals).where(inArray(approvals.taskId, ownedTaskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, ownedTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, ownedTaskIds));
    }
  } finally {
    await db?.$client.end();
  }
});

it('persists an uncertain GitHub issue write, replays it without writing, and asks fresh consent for a fresh request', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const repositoryId = 123;
  const repositoryFullName = 'synthetic-owner/selected-repo';
  const selection = {
    appClientId: 'Iv1.synthetic',
    installationId: 42,
    selectedRepositoryIds: [repositoryId],
  };
  const args = {
    repositoryId,
    repositoryFullName,
    title: 'Synthetic approved issue',
    body: 'Approved synthetic details only.',
  };
  const now = Date.parse('2026-11-19T10:00:00Z');
  // Every provider phase is injected. No GitHub network or external credentials are used.
  const provider = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          token: 'ghs_SYNTHETIC.NOT.LIVE',
          expires_at: '2026-11-19T11:00:00Z',
          repository_selection: 'selected',
          repositories: [{ id: repositoryId }],
          permissions: { metadata: 'read', issues: 'write' },
        },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        total_count: 1,
        repositories: [{ id: repositoryId, full_name: repositoryFullName, archived: false }],
      }),
    )
    .mockRejectedValueOnce(new Error('Synthetic connection lost after issue submission'));
  const creator = createGitHubAppIssueCreator(
    { ...selection, privateKey },
    { fetch: provider, now: () => now },
  );
  const registry = registerGitHubAppIssueTools(new ToolRegistry(), {
    enabled: () => true,
    resolveOwner: () => assertPostgresInstallationOwner(db),
    selection: () => selection,
    loadCreator: async () => ({ selection, creator }),
  });
  const taskRepository = createPostgresTaskRepository(db);
  const approvalRepository = createPostgresApprovalRepository(db);
  const freshDispatcher = () =>
    new ToolDispatcher(
      db,
      registry,
      createPostgresToolExecutionRepository(db),
      createPostgresCostRepository(db),
      createPostgresApprovalRepository(db),
      createPostgresApprovalPolicyRepository(db),
    );
  const dispatcher = freshDispatcher();
  const [task] = await db
    .insert(tasks)
    .values({
      agentId: ownerId,
      type: 'adhoc',
      status: 'pending',
      trust: 'owner',
      title: 'GitHub issue uncertain-write integration fixture',
    })
    .returning();
  if (!task) throw new Error('Fixture task was not created');
  ownedTaskIds.push(task.id);
  const lease = await taskRepository.claim(task.id, task.queueGeneration);
  if (!lease) throw new Error('Fixture task could not be claimed');
  const context = (taskLeaseToken: string | null): ToolContext => ({
    taskId: task.id,
    agentId: ownerId,
    trust: 'owner',
    tainted: false,
    taskLeaseToken,
    ownerIntent: {
      sourceActor: 'owner',
      requestKind: 'new_request',
      ownerAuthoredText: 'Create this exact synthetic GitHub issue.',
      externalText: '',
      authorizedScopes: ['external_send'],
      separation: 'none',
    },
    db,
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  });
  const provenance = { plannerVersion: 1, promptVersion: 1, model: 'test/offline' };
  const parked = await dispatcher.dispatch({
    task: lease,
    step: 1,
    toolName: 'github.create_issue',
    args,
    ctx: context(lease.leaseToken),
    provenance,
  });
  expect(parked.kind).toBe('awaiting_approval');
  if (parked.kind !== 'awaiting_approval')
    throw new Error('Exact issue creation approval was not requested');
  expect(provider).not.toHaveBeenCalled();
  expect(
    await taskRepository.parkForApproval(lease, {}, [
      { approvalId: parked.approvalId, toolCallId: parked.toolCallId },
    ]),
  ).toBe(true);
  const resolution = await approvalRepository.resolve({
    approvalId: parked.approvalId,
    decision: 'approved',
    via: 'web',
    deferNotification: true,
  });
  expect(resolution.ok).toBe(true);
  const queued = await taskRepository.getTask(task.id);
  if (!queued) throw new Error('Approved task disappeared');
  const resumedLease = await taskRepository.claim(task.id, queued.queueGeneration);
  if (!resumedLease) throw new Error('Approved task could not be claimed');
  const ctx = context(resumedLease.leaseToken);
  const first = await dispatcher.executeApproved(parked.toolCallId, ctx, 'github.create_issue');
  expect(first).toMatchObject({
    kind: 'executed',
    result: { deliveryStatus: 'unknown', retrySuppressed: true },
  });
  const [persisted] = await db.select().from(toolCalls).where(eq(toolCalls.id, parked.toolCallId));
  expect(persisted).toMatchObject({
    status: 'succeeded',
    approvalId: parked.approvalId,
    result: { deliveryStatus: 'unknown', retrySuppressed: true },
  });

  // New repository/dispatcher instances must observe the durable result, not a process cache.
  const replay = await freshDispatcher().executeApproved(
    parked.toolCallId,
    ctx,
    'github.create_issue',
  );
  expect(replay).toEqual(first);
  const issueWrites = () =>
    provider.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).endsWith('/issues'),
    );
  expect(issueWrites()).toHaveLength(1);
  expect(provider).toHaveBeenCalledTimes(3);

  const repeated = await freshDispatcher().dispatch({
    task: resumedLease,
    step: 2,
    toolName: 'github.create_issue',
    args,
    ctx,
    provenance,
  });
  expect(repeated.kind).toBe('awaiting_approval');
  if (repeated.kind !== 'awaiting_approval')
    throw new Error('A fresh issue request bypassed fresh owner consent');
  expect(repeated.approvalId).not.toBe(parked.approvalId);
  expect(repeated.toolCallId).not.toBe(parked.toolCallId);
  const [pending] = await db.select().from(approvals).where(eq(approvals.id, repeated.approvalId));
  expect(pending).toMatchObject({ status: 'pending', toolCallId: repeated.toolCallId });
  expect(issueWrites()).toHaveLength(1);
  expect(provider).toHaveBeenCalledTimes(3);
});
