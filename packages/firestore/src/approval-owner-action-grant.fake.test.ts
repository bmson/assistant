import {
  chatAdmissionExternalEventId,
  directOwnerCallRequestBinding,
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberReviewSourceFingerprint,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const ownerId = '30000000-0000-4000-8000-000000000001';
const taskId = '30000000-0000-4000-8000-000000000002';
const conversationId = '30000000-0000-4000-8000-000000000003';
const messageId = '30000000-0000-4000-8000-000000000004';
const approvalId = '30000000-0000-4000-8000-000000000005';
const toolCallId = '30000000-0000-4000-8000-000000000006';
const grantId = '30000000-0000-4000-8000-000000000007';
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
type Row = Record<string, unknown>;

class Ref {
  readonly id: string;
  readonly path: string;
  constructor(
    readonly collection: string,
    logicalId: string,
  ) {
    this.id = documentKey(logicalId);
    this.path = `${collection}/${this.id}`;
  }
  snapshot(source: Map<string, Row>) {
    const value = source.get(this.path);
    return {
      id: this.id,
      ref: this,
      exists: Boolean(value),
      data: () => value,
      get: (field: string) => value?.[field],
    };
  }
  async get() {
    return this.snapshot(rows);
  }
  async set(value: Row) {
    rows.set(this.path, encodeRecord(value));
  }
  async update(value: Row) {
    rows.set(this.path, { ...(rows.get(this.path) ?? {}), ...encodeRecord(value) });
  }
}

class Query {
  private filters: Array<[string, unknown]> = [];
  private maxRows = Number.POSITIVE_INFINITY;
  constructor(readonly name: string) {}
  where(field: string, op: string, value: unknown) {
    if (op === '==') this.filters.push([field, value]);
    return this;
  }
  orderBy() {
    return this;
  }
  limit(value: number) {
    this.maxRows = value;
    return this;
  }
  snapshot(source: Map<string, Row>) {
    const docs = [...source.entries()]
      .filter(([path]) => path.startsWith(`${this.name}/`))
      .map(([path, data]) => {
        const id = path.split('/').at(-1)!;
        return {
          id,
          ref: { collection: this.name, id, path: `${this.name}/${id}` },
          exists: true,
          data: () => data,
          get: (field: string) => data[field],
        };
      })
      .filter((doc) => this.filters.every(([field, value]) => doc.get(field) === value))
      .slice(0, this.maxRows);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  async get() {
    return this.snapshot(rows);
  }
}

let rows = new Map<string, Row>();
let failOperationCommit = false;
let injectedOperationCommitFailures = 0;
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
            const priorValue = decodeRecord<Row>(working.get(ref.path));
            if (
              failOperationCommit &&
              ref.collection === 'ownerCallGrantOperations' &&
              priorValue.phase === 'admitted' &&
              value.phase === 'committed'
            ) {
              injectedOperationCommitFailures += 1;
              throw new Error('injected operation receipt commit failure');
            }
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

function seed() {
  rows = new Map();
  injectedOperationCommitFailures = 0;
  failOperationCommit = false;
  const operationId = '30000000-0000-4000-8000-000000000008';
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
  for (const [collection, value] of [
    ['agents', { id: ownerId, phoneE164: '+14155550999' }],
    ['conversations', conversation],
    ['messages', message],
    ['tasks', task],
    ['toolCalls', tool],
    ['approvals', approval],
  ] as const)
    rows.set(`${collection}/${documentKey(value.id)}`, encodeRecord(value));
  return { store: fakeStore(), task, conversation, message, tool, approval };
}

async function prepare() {
  vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
  const fixture = seed();
  const repository = new FirestoreApprovalRepository(fixture.store);
  const sourceArgsFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(args)!;
  const grantScopeFingerprint = phoneCallOwnerActionGrantScopeFingerprint(match)!;
  const registered = await repository.ownerCallOperations!.register({
    ownerId,
    approvalId,
    grantId,
    taskId,
    toolCallId,
    expectedSlotGeneration: 0,
    requestFingerprint: sourceArgsFingerprint,
    grantScopeFingerprint,
    reviewExpiresAt: new Date(now.getTime() + 10 * 60_000),
    grantExpiresAt: new Date(match.expiresAt),
    replaceUnadmittedRegistration: false,
  });
  if (!registered.ok) throw new Error(`registration failed: ${registered.reason}`);
  const operation = {
    ownerId,
    approvalId,
    grantId,
    taskId,
    toolCallId,
    slotGeneration: registered.operation.slotGeneration,
    requestFingerprint: sourceArgsFingerprint,
    grantScopeFingerprint,
  };
  const admitted = await repository.ownerCallOperations!.admit(operation);
  if (!admitted.ok) throw new Error(`admission failed: ${admitted.reason}`);
  const directOwnerRequest = directOwnerCallRequestBinding(
    fixture.task,
    fixture.conversation,
    fixture.message,
    'waiting_approval',
  );
  if (!directOwnerRequest) throw new Error('owner request fixture did not bind');
  const binding = {
    expectedApprovalId: approvalId,
    expectedAgentId: ownerId,
    expectedTaskId: taskId,
    expectedToolCallId: toolCallId,
    sourceArgsFingerprint,
    reviewIssuedAt: now.toISOString(),
    reviewExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    validityDays: 1 as const,
    directOwnerRequest,
    match,
    operation,
  };
  const policy = {
    agentId: ownerId,
    toolName: 'phone.call',
    templateKey: 'phone.call.owner_action.v2',
    match,
    effect: 'allow' as const,
  };
  const input = {
    approvalId,
    expectedAgentId: ownerId,
    decision: 'approved' as const,
    via: 'web' as const,
    policy,
    ownerCallActionGrant: binding,
  };
  return { ...fixture, repository, operation, input };
}

afterEach(() => {
  vi.unstubAllEnvs();
  failOperationCommit = false;
});

describe('Firestore approval adapter v2 operation finalization (fake transaction port)', () => {
  it('commits approval, policy, wake and operation receipt atomically; replay creates no second wake', async () => {
    const f = await prepare();
    const result = await f.repository.resolve(f.input);
    expect(result).toMatchObject({
      ok: true,
      approvalId,
      toolCallId,
      taskId,
      wake: { taskId, generation: 1 },
      ownerCallNumberGrant: { grantId },
    });
    expect(decodeRecord<Row>(rows.get(`approvals/${documentKey(approvalId)}`)).status).toBe(
      'approved',
    );
    expect(decodeRecord<Row>(rows.get(`tasks/${documentKey(taskId)}`)).queueGeneration).toBe(1);
    expect([...rows.keys()].filter((key) => key.startsWith('approvalPolicies/'))).toHaveLength(1);
    expect([...rows.keys()].filter((key) => key.startsWith('outbox/'))).toHaveLength(1);
    const status = await f.repository.ownerCallOperations!.discover(ownerId, approvalId);
    expect(status).toMatchObject({
      kind: 'current',
      operation: {
        phase: 'committed',
        createdPolicyId: (result as { ownerCallNumberGrant: { policyId: string } })
          .ownerCallNumberGrant.policyId,
        wakeGeneration: 1,
      },
    });
    expect((await f.repository.resolve(f.input)).ok).toBe(false);
    expect([...rows.keys()].filter((key) => key.startsWith('outbox/'))).toHaveLength(1);
  });

  it('rolls back approval, policy and wake if the operation receipt write fails', async () => {
    const f = await prepare();
    failOperationCommit = true;
    await expect(f.repository.resolve(f.input)).rejects.toThrow(
      'Owner call operation could not be committed',
    );
    expect(injectedOperationCommitFailures).toBe(1);
    expect(decodeRecord<Row>(rows.get(`approvals/${documentKey(approvalId)}`)).status).toBe(
      'pending',
    );
    expect(decodeRecord<Row>(rows.get(`tasks/${documentKey(taskId)}`)).status).toBe(
      'waiting_approval',
    );
    expect([...rows.keys()].filter((key) => key.startsWith('approvalPolicies/'))).toHaveLength(0);
    expect([...rows.keys()].filter((key) => key.startsWith('outbox/'))).toHaveLength(0);
    expect(await f.repository.ownerCallOperations!.discover(ownerId, approvalId)).toMatchObject({
      kind: 'current',
      operation: { phase: 'admitted' },
    });
  });

  it('lets explicit close win before finalization and rejects the stale admitted binding', async () => {
    const f = await prepare();
    expect(await f.repository.ownerCallOperations!.close(f.operation)).toMatchObject({
      ok: true,
      operation: { phase: 'closed_no_effect' },
    });
    expect((await f.repository.resolve(f.input)).ok).toBe(false);
    expect(decodeRecord<Row>(rows.get(`approvals/${documentKey(approvalId)}`)).status).toBe(
      'pending',
    );
    expect([...rows.keys()].filter((key) => key.startsWith('outbox/'))).toHaveLength(0);
  });
});
