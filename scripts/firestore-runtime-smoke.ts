import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  FirestoreModelRoutingRepository,
  FirestoreToolExecutionRepository,
  type InstallationStore,
} from '@assistant/firestore';
import { approvalPolicyFingerprint } from '@assistant/persistence';

/** Synthetic smoke for the portable dispatcher and model-routing seams. */
export async function firestoreRuntimeSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const taskId = randomUUID();
  const conversationId = randomUUID();
  const callId = randomUUID();
  const approvalId = randomUUID();
  const now = new Date('2026-09-12T12:00:00Z');
  await store.doc('agents', agentId).set({ id: agentId });
  await store.doc('conversations', conversationId).set({
    id: conversationId,
    agentId,
    channel: 'chat',
    trust: 'owner',
    metadata: { goalId: 'goal-1' },
    modelOverride: 'synthetic-model',
  });
  await store.doc('messages', `${conversationId}-old`).set({
    id: `${conversationId}-old`,
    conversationId,
    role: 'user',
    origin: 'owner',
    text: 'old',
    createdAt: new Date(now.getTime() - 3_600_000),
  });
  await store.doc('messages', `${conversationId}-new`).set({
    id: `${conversationId}-new`,
    conversationId,
    role: 'user',
    origin: 'owner',
    text: 'new',
    createdAt: new Date(now.getTime() - 60_000),
  });
  await store.doc('tasks', taskId).set({
    id: taskId,
    agentId,
    type: 'chat_turn',
    status: 'waiting_approval',
    trust: 'owner',
    budgetUsdLimit: '1',
    spentUsd: '0',
    conversationId,
  });
  await store.doc('toolCalls', callId).set({
    id: callId,
    taskId,
    toolName: 'synthetic.action',
    status: 'approved',
    approvalId,
    args: {},
    decision: {},
    createdAt: now,
  });
  await store
    .doc('approvals', approvalId)
    .set({ id: approvalId, taskId, toolCallId: callId, status: 'approved', resolutionPayload: {} });
  await store
    .doc('rateLimits', 'tool:synthetic.action')
    .set({ scope: 'tool:synthetic.action', maxPerHour: 1, maxPerDay: 4 });
  const execution = new FirestoreToolExecutionRepository(store);
  assert.deepEqual(await execution.ownerMessageHistory(agentId, conversationId, now), [
    'old',
    'new',
  ]);
  assert.equal(
    await execution.underRateLimit('tool:synthetic.action', 'synthetic.action', now),
    true,
  );
  const claimed = await execution.claim({
    agentId,
    taskId,
    toolCallId: callId,
    args: { ok: true },
    decision: {},
    expectedApprovalId: approvalId,
    expectedResolutionPayload: {},
    expectedPolicyFingerprint: approvalPolicyFingerprint([]),
    expectedTaskTrust: 'owner',
  });
  assert.ok(claimed);
  assert.equal(
    await execution.outcome({
      agentId,
      taskId,
      toolCallId: callId,
      status: 'succeeded',
      result: { ok: true },
    }),
    true,
  );
  assert.equal(
    await execution.underRateLimit('tool:synthetic.action', 'synthetic.action', now),
    false,
  );
  assert.equal(await execution.load('foreign', taskId, callId), null);
  const models = new FirestoreModelRoutingRepository(store, agentId);
  await store.doc('modelRoles', 'chat').set({
    role: 'chat',
    primaryModel: 'synthetic-model',
    fallbackModel: 'synthetic-model',
    params: {},
    updatedAt: now,
  });
  await store.doc('models', 'synthetic-model').set({
    id: 'synthetic-model',
    provider: 'synthetic',
    name: 'Synthetic model',
    enabled: true,
    contextWindow: 4096,
    promptCostPerMTok: '1',
    completionCostPerMTok: '1',
    capabilities: {},
    updatedAt: now,
  });
  assert.deepEqual(await models.taskBudget(taskId), { limit: '1.0000', spent: '0.000000' });
  assert.equal(await models.conversationOverride(taskId), 'synthetic-model');
  assert.equal((await models.role('chat'))?.primaryModel, 'synthetic-model');
  assert.equal((await models.model('synthetic-model'))?.id, 'synthetic-model');
  const modelCallId = await models.recordCall({
    taskId,
    role: 'chat',
    model: 'synthetic-model',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: '0.000002',
    runtimeRevision: null,
    runtimeReleaseSha: null,
  });
  await models.recordAudit({
    taskId,
    modelCallId,
    role: 'chat',
    model: 'synthetic-model',
    method: 'generate',
    capture: 'redacted',
    systemPrompt: null,
    input: null,
    output: null,
    truncated: false,
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.equal((await store.doc('modelCalls', modelCallId).get()).get('costUsd'), '0.000002');
  await assert.rejects(
    new FirestoreModelRoutingRepository(store, 'foreign').taskBudget(taskId),
    /owner scope/,
  );
  return { agentId, taskId, callId, modelCallId };
}
