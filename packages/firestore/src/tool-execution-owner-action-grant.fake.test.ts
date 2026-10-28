import {
  approvalPolicyFingerprint,
  chatAdmissionExternalEventId,
  directOwnerCallRequestBinding,
  type ExpectedOwnerCallActionGrantBinding,
  parsePhoneCallOwnerActionIntent,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const ownerId = '10000000-0000-4000-8000-000000000001';
const taskId = '10000000-0000-4000-8000-000000000002';
const conversationId = '10000000-0000-4000-8000-000000000003';
const messageId = '10000000-0000-4000-8000-000000000004';
const policyId = '10000000-0000-4000-8000-000000000005';
const toolCallId = '10000000-0000-4000-8000-000000000006';
const messageText = 'Call +14155550123 now.';
const args = { brief: { to: '+14155550123', maxMinutes: 8 } };
const match = {
  schemaVersion: 2 as const,
  grantId: '10000000-0000-4000-8000-000000000007',
  action: 'phone.call' as const,
  recipientE164: '+14155550123',
  maxMinutes: 8,
  maxCallsPerHour: 1,
  maxCallsPerDay: 1,
  maxCostUsdMicrosPerCall: 800_000,
  maxCostUsdMicrosPerDay: 800_000,
  expiresAt: '2026-11-01T12:00:00.000Z',
};

type Row = Record<string, unknown>;
type Snapshot = {
  id: string;
  exists: boolean;
  data(): unknown;
  get(field: string): unknown;
};

class Ref {
  readonly path: string;
  readonly id: string;
  constructor(
    readonly collection: string,
    readonly logicalId: string,
  ) {
    this.id = documentKey(logicalId);
    this.path = `${collection}/${this.id}`;
  }
  async get(): Promise<Snapshot> {
    return this.snapshot(rows);
  }
  snapshot(source: Map<string, Row>): Snapshot {
    const value = source.get(this.path);
    return {
      id: this.id,
      exists: Boolean(value),
      data: () => value,
      get: (field) => value?.[field],
    };
  }
  async set(value: Row): Promise<void> {
    rows.set(this.path, encodeRecord(value));
  }
  async update(value: Row): Promise<void> {
    rows.set(this.path, { ...(rows.get(this.path) ?? {}), ...encodeRecord(value) });
  }
}

class Query {
  private filters: Array<[string, string, unknown]> = [];
  private maxRows = Number.POSITIVE_INFINITY;
  constructor(readonly name: string) {}
  where(field: string, op: string, value: unknown): this {
    this.filters.push([field, op, value]);
    return this;
  }
  orderBy(): this {
    return this;
  }
  limit(value: number): this {
    this.maxRows = value;
    return this;
  }
  snapshot(source: Map<string, Row>) {
    const docs = [...source.entries()]
      .filter(([path]) => path.startsWith(`${this.name}/`))
      .map(([path, data]) => ({
        exists: true,
        id: path.split('/').at(-1)!,
        data: () => data,
        get: (field: string) => data[field],
      }))
      .filter((doc) =>
        this.filters.every(([field, op, value]) => op === '==' && doc.get(field) === value),
      )
      .slice(0, this.maxRows);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  async get() {
    return this.snapshot(rows);
  }
}

let rows = new Map<string, Row>();
function fakeStore(): InstallationStore {
  let tail: Promise<unknown> = Promise.resolve();
  const store = {
    now: () => new Date(now),
    doc: (collection: string, id: string) => new Ref(collection, id),
    collection: (name: string) => new Query(name),
    db: {
      runTransaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        let release!: () => void;
        const prior = tail;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        const working = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
        const tx = {
          get: async (target: Ref | Query) =>
            target instanceof Query ? target.snapshot(working) : target.snapshot(working),
          getAll: async (...refs: Ref[]) => refs.map((ref) => ref.snapshot(working)),
          set: (ref: Ref, value: Row) => {
            working.set(ref.path, encodeRecord(value));
          },
          create: (ref: Ref, value: Row) => {
            if (working.has(ref.path)) throw new Error('fake create conflict');
            working.set(ref.path, encodeRecord(value));
          },
          update: (ref: Ref, value: Row) => {
            if (!working.has(ref.path)) throw new Error('fake update missing row');
            working.set(ref.path, { ...working.get(ref.path), ...encodeRecord(value) });
          },
        };
        try {
          const result = await callback(tx);
          rows = working;
          return result;
        } finally {
          release();
        }
      },
    },
  };
  return store as unknown as InstallationStore;
}

function seedFixture(withApprovedCall: boolean) {
  rows = new Map();
  const store = fakeStore();
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
    status: 'running',
    externalEventId: chatAdmissionExternalEventId({
      agentId: ownerId,
      conversationId,
      clientOperationId: '10000000-0000-4000-8000-000000000008',
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
          clientOperationId: '10000000-0000-4000-8000-000000000008',
          requestHash: 'a'.repeat(64),
          triggerMessageId: messageId,
          phase: 'streaming',
        },
      },
    },
  };
  const policy = {
    id: policyId,
    agentId: ownerId,
    toolName: 'phone.call',
    templateKey: 'phone.call.owner_action.v2',
    effect: 'allow',
    enabled: true,
    match,
    createdAt: now,
    updatedAt: now,
    version: 1,
    createdVia: 'owner',
  };
  rows.set(`agents/${documentKey(ownerId)}`, { id: ownerId });
  rows.set(`conversations/${documentKey(conversationId)}`, conversation);
  rows.set(`messages/${documentKey(messageId)}`, message);
  rows.set(`tasks/${documentKey(taskId)}`, task);
  rows.set(`approvalPolicies/${documentKey(policyId)}`, policy);
  if (withApprovedCall)
    rows.set(`toolCalls/${documentKey(toolCallId)}`, {
      id: toolCallId,
      taskId,
      toolName: 'phone.call',
      status: 'approved',
      approvalId: null,
      args: {},
      decision: {},
    });
  return { store, task, policy, message, conversation };
}

afterEach(() => vi.unstubAllEnvs());

async function bindingFor(repository: FirestoreToolExecutionRepository) {
  const directOwnerRequest = await repository.ownerCallRequest(ownerId, taskId);
  const ownerActionIntent = parsePhoneCallOwnerActionIntent(messageText);
  if (!directOwnerRequest || !ownerActionIntent)
    throw new Error('invalid fake owner request fixture');
  return {
    policyId,
    match,
    directOwnerRequest,
    ownerActionIntent: {
      intent: ownerActionIntent,
      ownerMessageFingerprint: directOwnerRequest.ownerMessageFingerprint,
    },
    recipientAuthority: { kind: 'explicit_number' as const, recipientE164: match.recipientE164 },
    estimatedCostUsdMicros: 400_000,
  } satisfies ExpectedOwnerCallActionGrantBinding;
}

describe('Firestore owner-action grant execution transaction (fake transaction port)', () => {
  it('serializes autonomous starts against the rolling call budget and never starts the loser', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const fixture = seedFixture(false);
    const repository = new FirestoreToolExecutionRepository(fixture.store);
    const binding = await bindingFor(repository);
    const input = {
      agentId: ownerId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: approvalPolicyFingerprint([fixture.policy]),
      expectedPhoneCallOwnerActionGrant: binding,
    };

    const results = await Promise.all([repository.start(input), repository.start(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const calls = [...rows.entries()].filter(([path]) => path.startsWith('toolCalls/'));
    expect(calls).toHaveLength(1);
    const usages = [...rows.entries()].filter(([path]) => path.startsWith('ownerCallGrantUsage/'));
    expect(usages).toHaveLength(1);
    const usage = decodeRecord<{ events: Array<{ costUsdMicros: number }> }>(usages[0]?.[1]);
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]?.costUsdMicros).toBe(400_000);
  });

  it('charges an approved claim once and rejects a replay after the call leaves approved state', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const fixture = seedFixture(true);
    const repository = new FirestoreToolExecutionRepository(fixture.store);
    const binding = await bindingFor(repository);
    const input = {
      agentId: ownerId,
      taskId,
      toolCallId,
      args,
      decision: {},
      expectedApprovalId: null,
      expectedResolutionPayload: null,
      expectedPolicyFingerprint: approvalPolicyFingerprint([fixture.policy]),
      expectedTaskTrust: 'owner',
      expectedTaskStatus: 'running',
      expectedPhoneCallOwnerActionGrant: binding,
    };

    const first = await repository.claim(input);
    const retry = await repository.claim(input);
    expect(first).toMatchObject({ toolCall: { id: toolCallId, status: 'executing' } });
    expect(retry).toBeNull();
    const stored = [...rows.entries()].find(([path]) =>
      path.startsWith('ownerCallGrantUsage/'),
    )?.[1];
    const usage = decodeRecord<{ events: Array<{ toolCallId: string }> }>(stored);
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]?.toolCallId).toBe(toolCallId);
  });

  it('fails closed when the selected v2 policy changes and leaves no start or usage event', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const fixture = seedFixture(false);
    const repository = new FirestoreToolExecutionRepository(fixture.store);
    const binding = await bindingFor(repository);
    const changed = { ...fixture.policy, enabled: false };
    rows.set(`approvalPolicies/${documentKey(policyId)}`, changed);
    const result = await repository.start({
      agentId: ownerId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: approvalPolicyFingerprint([fixture.policy]),
      expectedPhoneCallOwnerActionGrant: binding,
    });
    expect(result).toBeNull();
    expect([...rows.keys()].some((path) => path.startsWith('toolCalls/'))).toBe(false);
    expect([...rows.keys()].some((path) => path.startsWith('ownerCallGrantUsage/'))).toBe(false);
  });

  it('fails before start when the persisted owner request no longer matches the bound intent', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const fixture = seedFixture(false);
    const repository = new FirestoreToolExecutionRepository(fixture.store);
    const binding = await bindingFor(repository);
    rows.set(`tasks/${documentKey(taskId)}`, {
      ...fixture.task,
      trigger: {
        ...fixture.task.trigger,
        payload: { ...fixture.task.trigger.payload, text: 'Call someone else' },
      },
    });
    const result = await repository.start({
      agentId: ownerId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: approvalPolicyFingerprint([fixture.policy]),
      expectedPhoneCallOwnerActionGrant: binding,
    });
    expect(result).toBeNull();
    expect([...rows.keys()].some((path) => path.startsWith('toolCalls/'))).toBe(false);
    expect([...rows.keys()].some((path) => path.startsWith('ownerCallGrantUsage/'))).toBe(false);
  });
});
