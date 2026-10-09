import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeApplicationConfirmationTask } from '../../modules/src/google/application-confirmations.js';
import { registerApplicationTools } from '../../tools/src/applications.js';
import { ToolDispatcher } from '../../tools/src/dispatcher.js';
import { GoogleApiError } from '../../tools/src/google/client.js';
import { ToolRegistry } from '../../tools/src/registry.js';
import { createPostgresApplicationConfirmationRepository } from './application-confirmation-repository.js';
import { createDb, type Db } from './client.js';
import { createPostgresExecutionPersistence } from './execution-repository.js';
import { postgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { agents, applicationConfirmations, tasks, toolCalls } from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('application effect worker interrupted replay', () => {
  let db: Db;
  let agentId: string;
  const taskIds: string[] = [];
  const applicationIds: string[] = [];

  beforeAll(async () => {
    db = createDb(testUrl());
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the isolated test database');
    agentId = owner.id;
  });

  afterAll(async () => {
    for (const id of applicationIds)
      await db.delete(applicationConfirmations).where(eq(applicationConfirmations.id, id));
    for (const id of taskIds) {
      await db.delete(toolCalls).where(eq(toolCalls.taskId, id));
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    await db.$client.end();
  });

  it('retains the receipt across setActionOutcome and does not repeat a Doc write after lease reclaim', async () => {
    const producerPrivacyGeneration = await postgresPrivacyObservationFence(db, agentId);
    const applicationId = randomUUID();
    const confirmationMessageId = `gmail:worker-replay-${randomUUID()}`;
    const externalEventId = `application-confirmation:${confirmationMessageId}`;
    const toolName = 'applications.append_confirmation_doc';
    const idempotencyKey = `application-confirmation-doc-${applicationId}`;
    const documentUpdate = {
      documentId: 'document_123456789',
      content: 'Application received.',
    };
    const trigger = {
      source: 'internal',
      externalEventId,
      payload: {
        kind: 'application_confirmation',
        applicationId,
        confirmationMessageId,
        producerPrivacyGeneration,
      },
    };

    const taskRepository = createPostgresTaskRepository(db);
    const created = await taskRepository.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger,
      externalEventId,
      conversationId: null,
    });
    const exactTaskId = created.task.id;
    taskIds.push(exactTaskId);
    await db.insert(applicationConfirmations).values({
      id: applicationId,
      agentId,
      sourceTaskId: exactTaskId,
      conversationId: null,
      company: 'Example Corp',
      role: 'Engineer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: 'a'.repeat(64),
      confirmationTokenHint: '1234',
      trackerUpdate: null,
      documentUpdate,
      actionState: { document: { status: 'pending' } },
      status: 'confirmation_received',
      expiresAt: new Date(Date.now() + 60_000),
      confirmationMessageId,
      producerPrivacyGeneration,
    });
    applicationIds.push(applicationId);

    const actualApplications = createPostgresApplicationConfirmationRepository(db);
    let interruptAfterOutcomeCheckpoint = true;
    const applications = new Proxy(actualApplications, {
      get(target, property, receiver) {
        if (property === 'updateActionState') {
          return async (...args: Parameters<typeof target.updateActionState>) => {
            const saved = await target.updateActionState(...args);
            const nextState = args[1].actionState as {
              document?: { status?: unknown; effectReceipt?: unknown };
            };
            if (interruptAfterOutcomeCheckpoint && nextState.document?.status === 'unknown') {
              interruptAfterOutcomeCheckpoint = false;
              throw new Error('simulated process interruption after action outcome checkpoint');
            }
            return saved;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const persistence = createPostgresExecutionPersistence(db);
    const realTasks = persistence.tasks;
    const claimedLeaseTokens: string[] = [];
    const taskPort = new Proxy(realTasks, {
      get(target, property, receiver) {
        if (property === 'claim') {
          return async (...args: Parameters<typeof target.claim>) => {
            const lease = await target.claim(...args);
            if (lease?.leaseToken) claimedLeaseTokens.push(lease.leaseToken);
            return lease;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    let mutationCalls = 0;
    const provider = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { content: [{ endIndex: 1 }] } };
      mutationCalls += 1;
      const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, exactTaskId));
      expect(currentTask?.leaseToken).toBe(claimedLeaseTokens[0]);
      throw new GoogleApiError(408, 'Request timeout', _url);
    });

    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: { api: provider } as never,
      applications: actualApplications,
      tasks: taskRepository,
    });

    const actualExecutionRepository = createPostgresToolExecutionRepository(db);
    let failOutcomeAfterProvider = true;
    const executionRepository = new Proxy(actualExecutionRepository, {
      get(target, property, receiver) {
        if (property === 'outcome') {
          return async (...args: Parameters<typeof target.outcome>) => {
            const [input] = args;
            if (
              failOutcomeAfterProvider &&
              input.status === 'succeeded' &&
              input.toolCallId &&
              mutationCalls === 1
            ) {
              const [call] = await db
                .select({ toolName: toolCalls.toolName })
                .from(toolCalls)
                .where(eq(toolCalls.id, input.toolCallId));
              if (call?.toolName === toolName) {
                failOutcomeAfterProvider = false;
                return false;
              }
            }
            return target.outcome(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const dispatcher = new ToolDispatcher(
      db,
      registry,
      executionRepository,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    );
    const workerDeps = {
      persistence: { ...persistence, tasks: taskPort, applications },
      dispatcher,
      db,
      notifyOwner: vi.fn(async () => {}),
    };

    await expect(
      executeApplicationConfirmationTask(workerDeps as never, exactTaskId),
    ).rejects.toThrow('simulated process interruption after action outcome checkpoint');
    expect(mutationCalls).toBe(1);
    const afterInterruption = await actualApplications.get(applicationId);
    if (!afterInterruption) throw new Error('application record disappeared after interruption');
    expect(afterInterruption?.actionState).toMatchObject({
      document: {
        status: 'unknown',
        effectReceipt: {
          taskId: exactTaskId,
          toolName,
          idempotencyKey,
        },
      },
    });
    const receipt = (
      afterInterruption.actionState as {
        document?: { effectReceipt?: { claimToken?: string; toolCallId?: string } };
      }
    ).document?.effectReceipt;
    expect(receipt?.claimToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(receipt?.toolCallId).toBeTruthy();

    await db
      .update(tasks)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, exactTaskId));
    const replay = await executeApplicationConfirmationTask(workerDeps as never, exactTaskId);
    expect(replay).toEqual({ outcome: 'needs_attention', applicationId });
    expect(claimedLeaseTokens).toHaveLength(2);
    expect(claimedLeaseTokens[1]).not.toBe(claimedLeaseTokens[0]);
    expect(mutationCalls).toBe(1);
    expect(provider.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST']);
    const afterReplay = await actualApplications.get(applicationId);
    expect(afterReplay?.status).toBe('update_unknown');
    expect(afterReplay?.actionState).toMatchObject({
      document: {
        status: 'unknown',
        effectReceipt: {
          claimToken: receipt?.claimToken,
          taskId: exactTaskId,
          toolCallId: receipt?.toolCallId,
          toolName,
          idempotencyKey,
        },
      },
    });
  });
});
