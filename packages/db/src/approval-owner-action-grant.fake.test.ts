import {
  chatAdmissionExternalEventId,
  directOwnerCallRequestBinding,
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberReviewSourceFingerprint,
} from '@assistant/persistence';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgresApprovalRepository } from './approval-repository.js';
import type { Db } from './client.js';
import {
  agents,
  approvalPolicies,
  approvals,
  conversations,
  maintenanceCursors,
  messages,
  ownerCallGrantOperationSlots,
  ownerCallGrantOperations,
  tasks,
  toolCalls,
} from './schema.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const ownerId = '40000000-0000-4000-8000-000000000001';
const taskId = '40000000-0000-4000-8000-000000000002';
const conversationId = '40000000-0000-4000-8000-000000000003';
const messageId = '40000000-0000-4000-8000-000000000004';
const approvalId = '40000000-0000-4000-8000-000000000005';
const toolCallId = '40000000-0000-4000-8000-000000000006';
const grantId = '40000000-0000-4000-8000-000000000007';
const messageText = 'Call +14155550123 about my appointment';
const args = { brief: { to: '+14155550123', maxMinutes: 8 } };
const match = {
  schemaVersion: 2 as const,
  grantId,
  action: 'phone.call' as const,
  recipientE164: '+14155550123',
  maxMinutes: 8,
  maxCallsPerHour: 1,
  maxCallsPerDay: 1,
  maxCostUsdMicrosPerCall: 800_000,
  maxCostUsdMicrosPerDay: 800_000,
  expiresAt: '2026-10-29T12:00:00.000Z',
};

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing fixture value: ${label}`);
  return value;
}

function materializeClockTimestamp(value: unknown, label: string): Date {
  if (value instanceof Date) return value;
  const query = new PgDialect().sqlToQuery(value as Parameters<PgDialect['sqlToQuery']>[0]);
  if (query.sql !== 'clock_timestamp()' || query.params.length !== 0)
    throw new Error(`unexpected SQL expression for ${label}`);
  return now;
}

class FakeAwaitable<T> implements PromiseLike<T> {
  constructor(private readonly execute: () => T | Promise<T>) {}

  // biome-ignore lint/suspicious/noThenProperty: Drizzle test queries deliberately implement PromiseLike and execute only on await.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(this.execute)
      .then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

interface FakeQueryBuilder extends PromiseLike<unknown[]> {
  from(value: unknown): FakeQueryBuilder;
  where(...args: unknown[]): FakeQueryBuilder;
  innerJoin(...args: unknown[]): FakeQueryBuilder;
  leftJoin(...args: unknown[]): FakeQueryBuilder;
  orderBy(...args: unknown[]): FakeQueryBuilder;
  limit(...args: unknown[]): FakeQueryBuilder;
  for(...args: unknown[]): FakeQueryBuilder;
  set(value: Record<string, unknown>): FakeQueryBuilder;
  values(value: Record<string, unknown>): FakeQueryBuilder;
  onConflictDoUpdate(...args: unknown[]): FakeQueryBuilder;
  onConflictDoNothing(): FakeQueryBuilder;
  returning(projection?: Record<string, unknown>): Promise<unknown[]>;
}

function fakeDb(seed: Record<string, unknown>) {
  let state = structuredClone(seed) as Record<string, any>;
  let failOperationCommit = false;
  let tail: Promise<unknown> = Promise.resolve();
  const rows = (table: unknown): any[] => {
    if (table === agents) return [state.owner];
    if (table === tasks) return [state.task];
    if (table === conversations) return [state.conversation];
    if (table === messages) return [state.message];
    if (table === approvals) return [state.approval];
    if (table === toolCalls) return [state.tool];
    if (table === ownerCallGrantOperationSlots) return [state.slot];
    if (table === ownerCallGrantOperations) return [state.operation];
    if (table === approvalPolicies) return state.policy ? [state.policy] : [];
    if (table === maintenanceCursors) return [];
    return [];
  };
  const db: Record<string, any> = {
    async execute() {
      return [{ now }];
    },
    select(projection?: Record<string, unknown>) {
      let table: unknown;
      let builder: FakeQueryBuilder | undefined;
      builder = new FakeAwaitable(() => {
        let values = rows(table);
        if (
          projection &&
          Object.hasOwn(projection, 'toolCall') &&
          Object.hasOwn(projection, 'task')
        )
          values = [{ approval: state.approval, task: state.task, tool: state.tool }];
        else if (projection && Object.hasOwn(projection, 'id') && table === approvals)
          values = [
            {
              id: state.approval.id,
              taskId: state.approval.taskId,
              toolCallId: state.approval.toolCallId,
            },
          ];
        // A column projection returns only requested fields. In particular,
        // omitted task.trigger must not be supplied by the fake whole row.
        if (projection && table === tasks)
          values = values.map((row) =>
            Object.fromEntries(Object.keys(projection).map((key) => [key, row[key]])),
          );
        return values;
      }) as unknown as FakeQueryBuilder;
      builder.from = (value: unknown) => {
        table = value;
        return required(builder, 'select query builder');
      };
      builder.where = () => required(builder, 'select query builder');
      builder.innerJoin = () => required(builder, 'select query builder');
      builder.leftJoin = () => required(builder, 'select query builder');
      builder.orderBy = () => required(builder, 'select query builder');
      builder.limit = () => required(builder, 'select query builder');
      builder.for = () => required(builder, 'select query builder');
      return required(builder, 'select query builder');
    },
    update(table: unknown) {
      let changes: Record<string, any> = {};
      let builder: FakeQueryBuilder | undefined;
      builder = new FakeAwaitable(async () => {
        await required(builder, 'update query builder').returning();
        return [];
      }) as unknown as FakeQueryBuilder;
      builder.set = (value: Record<string, any>) => {
        changes = value;
        return required(builder, 'update query builder');
      };
      builder.where = () => required(builder, 'update query builder');
      builder.returning = async (projection?: Record<string, unknown>) => {
        if (table === approvals)
          state.approval = {
            ...state.approval,
            ...changes,
            resolvedAt:
              changes.resolvedAt === undefined
                ? state.approval.resolvedAt
                : materializeClockTimestamp(changes.resolvedAt, 'approval.resolvedAt'),
          };
        if (table === toolCalls) state.tool = { ...state.tool, ...changes };
        if (table === tasks)
          state.task = {
            ...state.task,
            ...changes,
            queueGeneration: state.task.queueGeneration + 1,
            // Drizzle receives clock_timestamp() for this column. Keep the fake
            // row materialized like PostgreSQL so the next tx can snapshot it.
            updatedAt:
              changes.updatedAt === undefined
                ? state.task.updatedAt
                : materializeClockTimestamp(changes.updatedAt, 'task.updatedAt'),
          };
        if (table === ownerCallGrantOperations) {
          if (failOperationCommit && changes.phase === 'committed')
            throw new Error('injected operation receipt commit failure');
          state.operation = { ...state.operation, ...changes };
        }
        if (
          table === approvals &&
          projection &&
          Object.hasOwn(projection, 'id') &&
          changes.createdPolicyId
        )
          return [{ id: state.approval.id }];
        if (table === tasks && projection)
          return [{ id: state.task.id, queueGeneration: state.task.queueGeneration }];
        return [
          state[
            table === approvals
              ? 'approval'
              : table === toolCalls
                ? 'tool'
                : table === tasks
                  ? 'task'
                  : 'operation'
          ],
        ];
      };
      return required(builder, 'update query builder');
    },
    insert(table: unknown) {
      let value: Record<string, any> = {};
      let builder: FakeQueryBuilder | undefined;
      builder = new FakeAwaitable(async () => {
        await required(builder, 'insert query builder').returning();
        return [];
      }) as unknown as FakeQueryBuilder;
      builder.values = (input: Record<string, any>) => {
        value = input;
        return required(builder, 'insert query builder');
      };
      builder.onConflictDoUpdate = () => required(builder, 'insert query builder');
      builder.onConflictDoNothing = () => required(builder, 'insert query builder');
      builder.returning = async () => {
        if (table === approvalPolicies)
          state.policy = {
            ...value,
            id: '40000000-0000-4000-8000-000000000009',
            createdAt: now,
            updatedAt: now,
            version: 1,
          };
        return table === approvalPolicies ? [state.policy] : [];
      };
      return required(builder, 'insert query builder');
    },
    async transaction<T>(callback: (tx: unknown) => Promise<T>) {
      let release!: () => void;
      const prior = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      const before = state;
      state = structuredClone(before);
      try {
        return await callback(db);
      } catch (error) {
        state = before;
        throw error;
      } finally {
        release();
      }
    },
  };
  return {
    db: db as unknown as Db,
    state: () => state,
    failCommit: () => {
      failOperationCommit = true;
    },
  };
}

function fixture() {
  const operationId = '40000000-0000-4000-8000-000000000008';
  const conversation = { id: conversationId, agentId: ownerId };
  const message = {
    id: messageId,
    conversationId,
    taskId,
    role: 'user',
    origin: 'owner',
    text: messageText,
    hiddenAt: null,
    createdAt: now,
  };
  const task = {
    id: taskId,
    agentId: ownerId,
    conversationId,
    type: 'chat_turn',
    trust: 'owner',
    status: 'waiting_approval',
    queueGeneration: 0,
    externalEventId: chatAdmissionExternalEventId({
      agentId: ownerId,
      conversationId,
      clientOperationId: operationId,
    }),
    trigger: {
      source: 'chat',
      agentId: ownerId,
      conversationId,
      trust: 'owner',
      payload: {
        text: messageText,
        triggerMessageId: messageId,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId: operationId,
          requestHash: 'a'.repeat(64),
          triggerMessageId: messageId,
          phase: 'queued',
        },
      },
    },
  };
  const approval = {
    id: approvalId,
    taskId,
    toolCallId,
    shortCode: 'A7',
    status: 'pending',
    payload: args,
    expiresAt: new Date(now.getTime() + 60_000),
    requestedAt: now,
  };
  const tool = {
    id: toolCallId,
    taskId,
    step: 0,
    toolName: 'phone.call',
    args,
    risk: 'high',
    status: 'awaiting_approval',
    approvalId,
    decision: {},
    result: null,
    error: null,
  };
  const scopeFingerprint = required(
    phoneCallOwnerActionGrantScopeFingerprint(match),
    'grant scope fingerprint',
  );
  const requestFingerprint = required(
    phoneCallOwnerNumberReviewSourceFingerprint(args),
    'request fingerprint',
  );
  const operation = {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    operationVersion: 1,
    ownerId,
    approvalId,
    grantId,
    taskId,
    toolCallId,
    slotGeneration: 1,
    requestFingerprint,
    grantScopeFingerprint: scopeFingerprint,
    phase: 'admitted',
    registeredAt: now,
    reviewExpiresAt: new Date(now.getTime() + 10 * 60_000),
    grantExpiresAt: new Date(match.expiresAt),
    admittedAt: now,
    committedAt: null,
    closedAt: null,
    rejectedAt: null,
    createdPolicyId: null,
    wakeGeneration: null,
    updatedAt: now,
  };
  const slot = {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    ownerId,
    approvalId,
    generation: 1,
    currentGrantId: grantId,
    updatedAt: operation.updatedAt,
  };
  const owner = { id: ownerId, phoneE164: '+14155550999' };
  const directOwnerRequest = directOwnerCallRequestBinding(
    task,
    conversation,
    message,
    'waiting_approval',
  );
  if (!directOwnerRequest) throw new Error('owner request fixture did not bind');
  const db = fakeDb({
    owner,
    task,
    conversation,
    message,
    approval,
    tool,
    operation,
    slot,
    policy: null,
  });
  const binding = {
    expectedApprovalId: approvalId,
    expectedAgentId: ownerId,
    expectedTaskId: taskId,
    expectedToolCallId: toolCallId,
    sourceArgsFingerprint: requestFingerprint,
    reviewIssuedAt: now.toISOString(),
    reviewExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    validityDays: 1 as const,
    directOwnerRequest,
    match,
    operation: {
      ownerId,
      approvalId,
      grantId,
      taskId,
      toolCallId,
      slotGeneration: 1,
      requestFingerprint,
      grantScopeFingerprint: scopeFingerprint,
    },
  };
  const input = {
    approvalId,
    expectedAgentId: ownerId,
    decision: 'approved' as const,
    via: 'web' as const,
    policy: {
      agentId: ownerId,
      toolName: 'phone.call',
      templateKey: 'phone.call.owner_action.v2',
      match,
      effect: 'allow' as const,
    },
    ownerCallActionGrant: binding,
  };
  return { db, input };
}

afterEach(() => vi.unstubAllEnvs());
describe('PostgreSQL approval adapter v2 operation finalization (fake transaction port)', () => {
  it('commits the admitted receipt with approval, reusable policy and one queue wake', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const f = fixture();
    const result = await createPostgresApprovalRepository(f.db.db).resolve(f.input);
    expect(result).toMatchObject({
      ok: true,
      taskId,
      toolCallId,
      approvalId,
      wake: { taskId, generation: 1 },
      ownerCallNumberGrant: { grantId },
    });
    expect(f.db.state().approval.status).toBe('approved');
    expect(f.db.state().operation).toMatchObject({
      phase: 'committed',
      createdPolicyId: result.ok ? result.ownerCallNumberGrant?.policyId : undefined,
      wakeGeneration: 1,
    });
    expect(f.db.state().task.queueGeneration).toBe(1);
    expect(f.db.state().policy).not.toBeNull();
    expect((await createPostgresApprovalRepository(f.db.db).resolve(f.input)).ok).toBe(false);
    expect(f.db.state().task.queueGeneration).toBe(1);
  });

  it('rolls every resolution write back when the operation receipt cannot commit', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const f = fixture();
    f.db.failCommit();
    await expect(createPostgresApprovalRepository(f.db.db).resolve(f.input)).rejects.toThrow();
    expect(f.db.state().approval.status).toBe('pending');
    expect(f.db.state().tool.status).toBe('awaiting_approval');
    expect(f.db.state().task.queueGeneration).toBe(0);
    expect(f.db.state().policy).toBeNull();
    expect(f.db.state().operation.phase).toBe('admitted');
  });
});
