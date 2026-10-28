import {
  approvalPolicyFingerprint,
  chatAdmissionExternalEventId,
  directOwnerCallRequestBinding,
  type ExpectedOwnerCallActionGrantBinding,
  parsePhoneCallOwnerActionIntent,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import {
  agents,
  approvalPolicies,
  approvals,
  conversations,
  maintenanceCursors,
  messages,
  ownerCallGrantUsage,
  tasks,
  toolCallReceiptKeys,
  toolCalls,
} from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const ownerId = '20000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000002';
const conversationId = '20000000-0000-4000-8000-000000000003';
const messageId = '20000000-0000-4000-8000-000000000004';
const policyId = '20000000-0000-4000-8000-000000000005';
const toolCallId = '20000000-0000-4000-8000-000000000006';
const messageText = 'Call +14155550123 about my appointment';
const args = { brief: { to: '+14155550123', maxMinutes: 8 } };
const match = {
  schemaVersion: 2 as const,
  grantId: '20000000-0000-4000-8000-000000000007',
  action: 'phone.call' as const,
  recipientE164: '+14155550123',
  maxMinutes: 8,
  maxCallsPerHour: 1,
  maxCallsPerDay: 1,
  maxCostUsdMicrosPerCall: 800_000,
  maxCostUsdMicrosPerDay: 800_000,
  expiresAt: '2026-11-01T12:00:00.000Z',
};

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing fixture value: ${label}`);
  return value;
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
  values(value: unknown): FakeQueryBuilder;
  onConflictDoNothing(): FakeQueryBuilder;
  returning(...args: unknown[]): Promise<unknown[]>;
}

function fixture(withApprovedCall: boolean) {
  const operationId = '20000000-0000-4000-8000-000000000008';
  const task = {
    id: taskId,
    agentId: ownerId,
    conversationId,
    type: 'chat_turn',
    trust: 'owner',
    status: 'running',
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
    autonomyGrant: null,
    updatedAt: now,
  };
  const conversation = { id: conversationId, agentId: ownerId };
  const message = {
    id: messageId,
    conversationId,
    taskId,
    role: 'user',
    origin: 'owner',
    text: messageText,
    hiddenAt: null,
  };
  const policy = {
    id: policyId,
    agentId: ownerId,
    toolName: 'phone.call',
    templateKey: 'phone.call.owner_action.v2',
    effect: 'allow',
    enabled: true,
    match,
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdVia: 'owner',
  };
  const approvedCall = withApprovedCall
    ? {
        id: toolCallId,
        taskId,
        step: 0,
        toolName: 'phone.call',
        args: {},
        risk: 'high',
        status: 'approved',
        idempotencyKey: null,
        decision: {},
        result: null,
        error: null,
        approvalId: null,
        startedAt: null,
        finishedAt: null,
      }
    : null;
  return { task, conversation, message, policy, approvedCall };
}

function fakeDb(seed: ReturnType<typeof fixture>) {
  let state = {
    ...seed,
    usage: null as Record<string, unknown> | null,
    calls: seed.approvedCall ? [seed.approvedCall] : [],
  };
  let tail: Promise<unknown> = Promise.resolve();
  const tableRows = (table: unknown) => {
    if (table === agents) return [{ id: ownerId }];
    if (table === tasks) return [state.task];
    if (table === conversations) return [state.conversation];
    if (table === messages) return [state.message];
    if (table === approvalPolicies) return [state.policy];
    if (table === approvals || table === maintenanceCursors || table === toolCallReceiptKeys)
      return [];
    if (table === ownerCallGrantUsage) return state.usage ? [state.usage] : [];
    if (table === toolCalls) return state.calls;
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
        let values: unknown[] = tableRows(table);
        if (
          projection &&
          Object.hasOwn(projection, 'toolCall') &&
          Object.hasOwn(projection, 'task')
        )
          values = state.calls.length
            ? [{ toolCall: state.calls[0], task: state.task, approval: null }]
            : [];
        else if (projection && Object.hasOwn(projection, 'approvalId'))
          values = state.calls.length ? [{ approvalId: state.calls[0]?.approvalId ?? null }] : [];
        else if (projection && Object.hasOwn(projection, 'id') && table === toolCalls)
          values = state.calls.map((call) => ({ id: call.id }));
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
    insert(table: unknown) {
      let values: unknown;
      let builder: FakeQueryBuilder | undefined;
      builder = new FakeAwaitable(async () => {
        await required(builder, 'insert query builder').returning();
        return [];
      }) as unknown as FakeQueryBuilder;
      builder.values = (value: unknown) => {
        values = value;
        return required(builder, 'insert query builder');
      };
      builder.onConflictDoNothing = () => required(builder, 'insert query builder');
      builder.returning = async () => {
        if (table === toolCalls) {
          const inserted = { ...values, createdAt: now };
          state.calls.push(inserted);
          return [inserted];
        }
        if (table === ownerCallGrantUsage && !state.usage) state.usage = values;
        return [];
      };
      return required(builder, 'insert query builder');
    },
    update(table: unknown) {
      let changes: Record<string, unknown> = {};
      let builder: FakeQueryBuilder | undefined;
      builder = new FakeAwaitable(async () => {
        await required(builder, 'update query builder').returning();
        return [];
      }) as unknown as FakeQueryBuilder;
      builder.set = (value: Record<string, unknown>) => {
        changes = value;
        return required(builder, 'update query builder');
      };
      builder.where = () => required(builder, 'update query builder');
      builder.returning = async () => {
        if (table === toolCalls && state.calls[0]) {
          const persisted = { ...changes };
          // The approved claim uses Drizzle's `now()` expression for startedAt.
          // Resolve that database value to this fake transaction's fixed clock
          // before retaining state for the next transaction snapshot.
          if (
            persisted.startedAt &&
            typeof persisted.startedAt === 'object' &&
            !(persisted.startedAt instanceof Date)
          )
            persisted.startedAt = now;
          state.calls[0] = { ...state.calls[0], ...persisted };
          return [{ id: state.calls[0].id }];
        }
        if (table === ownerCallGrantUsage && state.usage) {
          const persisted = { ...changes };
          if (Array.isArray(persisted.events))
            persisted.events = JSON.parse(JSON.stringify(persisted.events));
          state.usage = { ...state.usage, ...persisted };
        }
        return [];
      };
      return required(builder, 'update query builder');
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
        const result = await callback(db);
        return result;
      } catch (error) {
        state = before;
        throw error;
      } finally {
        release();
      }
    },
  };
  return { db: db as unknown as Db, state: () => state };
}

function bindingFor(seed: ReturnType<typeof fixture>): ExpectedOwnerCallActionGrantBinding {
  const directOwnerRequest = directOwnerCallRequestBinding(
    seed.task,
    seed.conversation,
    seed.message,
    'running',
  );
  const intent = parsePhoneCallOwnerActionIntent(messageText);
  if (!directOwnerRequest || !intent) throw new Error('invalid fake owner request fixture');
  return {
    policyId,
    match,
    directOwnerRequest,
    ownerActionIntent: {
      intent,
      ownerMessageFingerprint: directOwnerRequest.ownerMessageFingerprint,
    },
    recipientAuthority: { kind: 'explicit_number', recipientE164: match.recipientE164 },
    estimatedCostUsdMicros: 400_000,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('PostgreSQL owner-action grant execution transaction (fake transaction port)', () => {
  it('charges an approved claim once and leaves a replay unable to create another usage event', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const seed = fixture(true);
    const fake = fakeDb(seed);
    const repository = createPostgresToolExecutionRepository(fake.db);
    const result = await repository.claim({
      agentId: ownerId,
      taskId,
      toolCallId,
      args,
      decision: {},
      expectedApprovalId: null,
      expectedResolutionPayload: null,
      expectedPolicyFingerprint: approvalPolicyFingerprint([seed.policy]),
      expectedTaskTrust: 'owner',
      expectedTaskStatus: 'running',
      expectedPhoneCallOwnerActionGrant: bindingFor(seed),
    });
    expect(result).toMatchObject({ toolCall: { id: toolCallId, status: 'executing' } });
    expect(fake.state().usage?.events).toHaveLength(1);
    const events = required(fake.state().usage?.events, 'usage events') as Array<{
      costUsdMicros: number;
    }>;
    expect(required(events[0], 'charged usage event').costUsdMicros).toBe(400_000);
    const retry = await repository.claim({
      agentId: ownerId,
      taskId,
      toolCallId,
      args,
      decision: {},
      expectedApprovalId: null,
      expectedResolutionPayload: null,
      expectedPolicyFingerprint: approvalPolicyFingerprint([seed.policy]),
      expectedTaskTrust: 'owner',
      expectedTaskStatus: 'running',
      expectedPhoneCallOwnerActionGrant: bindingFor(seed),
    });
    expect(retry).toBeNull();
    expect(fake.state().usage?.events).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it('serializes autonomous starts so only the winner consumes the rolling budget', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const seed = fixture(false);
    const fake = fakeDb(seed);
    const repository = createPostgresToolExecutionRepository(fake.db);
    const input = {
      agentId: ownerId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: approvalPolicyFingerprint([seed.policy]),
      expectedPhoneCallOwnerActionGrant: bindingFor(seed),
    };
    const results = await Promise.all([repository.start(input), repository.start(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.state().calls).toHaveLength(1);
    expect(fake.state().usage?.events).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it('rolls back before a side effect when the stored policy no longer matches', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const seed = fixture(false);
    const fake = fakeDb(seed);
    const repository = createPostgresToolExecutionRepository(fake.db);
    const expected = bindingFor(seed);
    const expectedFingerprint = approvalPolicyFingerprint([seed.policy]);
    fake.state().policy.match = { ...match, maxMinutes: 7 };
    const result = await repository.start({
      agentId: ownerId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: expectedFingerprint,
      expectedPhoneCallOwnerActionGrant: expected,
    });
    expect(result).toBeNull();
    expect(fake.state().calls).toHaveLength(0);
    expect(fake.state().usage).toBeNull();
    vi.unstubAllEnvs();
  });

  it('refuses an autonomous start when the persisted owner request changes after binding', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const seed = fixture(false);
    const fake = fakeDb(seed);
    const repository = createPostgresToolExecutionRepository(fake.db);
    const expectedPhoneCallOwnerActionGrant = bindingFor(seed);
    fake.state().task.trigger.payload.text = 'Call someone else';
    const result = await repository.start({
      agentId: ownerId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: approvalPolicyFingerprint([seed.policy]),
      expectedPhoneCallOwnerActionGrant,
    });
    expect(result).toBeNull();
    expect(fake.state().calls).toHaveLength(0);
    expect(fake.state().usage).toBeNull();
    vi.unstubAllEnvs();
  });
});
