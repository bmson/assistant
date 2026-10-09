import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  deleteApprovalPolicyForAgent,
  listApprovalPolicies,
  setApprovalPolicyEnabledForAgent,
} from '@assistant/core/workflow/approval-policies';
import {
  createApproval,
  expireStaleApprovals,
  listApprovalInbox,
  markApprovalsNotified,
  renotifyStalledApprovals,
  resumeResolvedApprovalTasks,
} from '@assistant/core/workflow/approvals';
import {
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreMessageRepository,
  FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';

/** Exercise the portable sweeps through a real task claim/park/recovery lifecycle. */
export async function firestoreApprovalSmoke(store: InstallationStore) {
  const repository = new FirestoreApprovalRepository(store);
  const tasks = new FirestoreTaskRepository(store);
  const now = new Date();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await store.doc('agents', agentId).set({ id: agentId, name: 'Approval smoke', timezone: 'UTC' });
  await store.doc('conversations', conversationId).set({
    id: conversationId,
    agentId,
    createdAt: now,
    updatedAt: now,
    title: 'Approval smoke',
    archivedAt: null,
    channel: 'chat',
    trust: 'owner',
    modelOverride: null,
    isPrimary: false,
    metadata: {},
    lastReadAt: null,
  });
  async function fixture() {
    const { task } = await tasks.createTask({
      agentId,
      conversationId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: {} },
    });
    const lease = await tasks.claim(task.id, task.queueGeneration);
    assert.ok(lease);
    const { approvalId, toolCallId } = await createApproval(repository, {
      taskId: task.id,
      step: 0,
      toolName: 'synthetic.action',
      args: {},
      decision: { source: 'synthetic' },
      summary: 'Synthetic approval',
    });
    await store
      .doc('approvals', approvalId)
      .update({ requestedAt: new Date(now.getTime() - 600_000) });
    return { task, lease, approvalId, toolCallId };
  }

  const expired = await fixture();
  await store
    .doc('approvals', expired.approvalId)
    .update({ expiresAt: new Date(now.getTime() - 1_000) });
  assert.equal(
    await tasks.parkForApproval(expired.lease, { phase: 'execute' }, [
      { approvalId: expired.approvalId, toolCallId: expired.toolCallId },
    ]),
    true,
  );
  const races = await Promise.all([
    expireStaleApprovals(repository, 200, now),
    expireStaleApprovals(repository, 200, now),
  ]);
  assert.equal(races.flat().filter((id) => id === expired.task.id).length, 1);
  assert.equal((await store.doc('approvals', expired.approvalId).get()).get('status'), 'expired');
  assert.equal((await store.doc('toolCalls', expired.toolCallId).get()).get('status'), 'denied');
  assert.equal((await store.doc('tasks', expired.task.id).get()).get('queueGeneration'), 1);
  assert.equal(await tasks.claim(expired.task.id, 0), null);
  assert.ok(await tasks.claim(expired.task.id, 1));

  // Decision arrives while the executor is still running, before it parks.
  const stranded = await fixture();
  assert.equal(
    (
      await repository.resolve({
        approvalId: stranded.approvalId,
        decision: 'approved',
        via: 'web',
      })
    ).ok,
    true,
  );
  assert.equal(
    await tasks.parkForApproval(stranded.lease, { phase: 'execute' }, [
      { approvalId: stranded.approvalId, toolCallId: stranded.toolCallId },
    ]),
    true,
  );
  const recovery = await Promise.all([
    resumeResolvedApprovalTasks(repository, 200, now),
    resumeResolvedApprovalTasks(repository, 200, now),
  ]);
  assert.equal(recovery.flat().filter((id) => id === stranded.task.id).length, 1);
  assert.equal((await store.doc('tasks', stranded.task.id).get()).get('queueGeneration'), 1);
  assert.ok(await tasks.claim(stranded.task.id, 1));
  const intents = await store.collection('outbox').get();
  for (const taskId of [expired.task.id, stranded.task.id])
    assert.equal(
      intents.docs.filter((doc) => doc.get('taskId') === taskId && doc.get('generation') === 1)
        .length,
      1,
    );
  const notice = await fixture();
  const extra = await createApproval(repository, {
    taskId: notice.task.id,
    step: 1,
    toolName: 'synthetic.second',
    args: {},
    decision: { source: 'synthetic' },
    summary: 'Second synthetic approval',
  });
  await store
    .doc('approvals', extra.approvalId)
    .update({ requestedAt: new Date(now.getTime() - 600_000) });
  assert.equal(
    await tasks.parkForApproval(notice.lease, { phase: 'execute' }, [
      { approvalId: notice.approvalId, toolCallId: notice.toolCallId },
      { approvalId: extra.approvalId, toolCallId: extra.toolCallId },
    ]),
    true,
  );
  await markApprovalsNotified(repository, [notice.approvalId], ['owner']);
  const pinged: string[] = [];
  const noticeStore = { approvals: repository, messages: new FirestoreMessageRepository(store) };
  assert.equal(
    await renotifyStalledApprovals(noticeStore, async (_task, notices) => {
      pinged.push(...notices.map((row) => row.shortCode));
    }),
    2,
  );
  assert.deepEqual(pinged, [extra.shortCode]);
  for (const approvalId of [notice.approvalId, extra.approvalId]) {
    assert.deepEqual((await store.doc('approvals', approvalId).get()).get('notifiedChannels'), [
      'owner',
      'conversation',
    ]);
  }
  assert.equal(
    await renotifyStalledApprovals(noticeStore, async () => {
      throw new Error('Already delivered');
    }),
    0,
  );
  const cards = await store.collection('messages').where('taskId', '==', notice.task.id).get();
  assert.equal(cards.size, 1);
  assert.equal(cards.docs[0]?.get('parts').length, 2);
  const policyRepository = new FirestoreApprovalPolicyRepository(store);
  const remembered = await fixture();
  const policy = {
    agentId,
    toolName: 'synthetic.action',
    templateKey: 'synthetic.only',
    match: { recipient: 'synthetic@example.invalid' },
    effect: 'allow' as const,
  };
  assert.equal(
    (
      await repository.resolve({
        approvalId: remembered.approvalId,
        decision: 'approved',
        via: 'web',
        policy,
      })
    ).ok,
    true,
  );
  const policyId = (await store.doc('approvals', remembered.approvalId).get()).get(
    'createdPolicyId',
  );
  assert.equal(typeof policyId, 'string');
  assert.equal((await listApprovalPolicies(policyRepository, agentId)).length, 1);
  assert.equal(
    (
      await listApprovalPolicies(policyRepository, agentId, {
        toolName: 'synthetic.action',
        enabledOnly: true,
      })
    ).length,
    1,
  );
  assert.deepEqual(await listApprovalPolicies(policyRepository, randomUUID()), []);
  assert.equal(
    await setApprovalPolicyEnabledForAgent(policyRepository, randomUUID(), policyId, false),
    false,
  );
  assert.equal(await deleteApprovalPolicyForAgent(policyRepository, randomUUID(), policyId), false);
  assert.equal(
    await setApprovalPolicyEnabledForAgent(policyRepository, agentId, policyId, false),
    true,
  );
  assert.deepEqual(
    await listApprovalPolicies(policyRepository, agentId, { enabledOnly: true }),
    [],
  );
  assert.equal(await deleteApprovalPolicyForAgent(policyRepository, agentId, policyId), true);
  assert.equal(
    (await store.doc('approvals', remembered.approvalId).get()).get('createdPolicyId'),
    policyId,
  );
  const recreated = await fixture();
  assert.equal(
    (
      await repository.resolve({
        approvalId: recreated.approvalId,
        decision: 'approved',
        via: 'web',
        policy,
      })
    ).ok,
    true,
  );
  const recreatedPolicies = await listApprovalPolicies(policyRepository, agentId);
  assert.equal(recreatedPolicies.length, 1);
  assert.notEqual(recreatedPolicies[0]?.id, policyId);

  // Read the same approval screen through the portable core entry point. An
  // expired-but-not-yet-swept row belongs in history and never grants a decision.
  const unanswered = await fixture();
  const unswept = await fixture();
  const inboxNow = new Date();
  await store.doc('approvals', unswept.approvalId).update({
    expiresAt: new Date(inboxNow.getTime() - 1_000),
  });
  const edited = await fixture();
  assert.equal(
    (
      await repository.resolve({
        approvalId: edited.approvalId,
        decision: 'approved',
        via: 'web',
        editedPayload: { synthetic: 'edited' },
      })
    ).ok,
    true,
  );
  const inbox = await listApprovalInbox(repository, agentId, { now: inboxNow, recentLimit: 20 });
  assert.ok(inbox.pending.some((item) => item.approval.id === unanswered.approvalId));
  assert.ok(!inbox.pending.some((item) => item.approval.id === unswept.approvalId));
  assert.ok(inbox.resolved.some((item) => item.approval.id === unswept.approvalId));
  assert.equal(
    inbox.resolved.find((item) => item.approval.id === edited.approvalId)?.approval.edited,
    true,
  );
  for (const item of inbox.resolved) {
    assert.equal('payload' in item.approval, false);
    assert.equal('resolutionPayload' in item.approval, false);
  }
  assert.deepEqual(await listApprovalInbox(repository, randomUUID()), {
    pending: [],
    resolved: [],
  });
  const historical = await listApprovalInbox(repository, agentId, {
    now: new Date(inboxNow.getTime() - 2_000),
  });
  assert.ok(historical.pending.some((item) => item.approval.id === unswept.approvalId));
  assert.ok(!historical.resolved.some((item) => item.approval.id === unswept.approvalId));
  assert.equal(
    (await listApprovalInbox(repository, agentId, { recentLimit: 1 })).resolved.length,
    1,
  );
  return {
    approvalInbox: 'passed',
    policyManagement: 'passed',
    approvalCreation: 'passed',
    notificationRepair: 'passed',
    approvalExpiry: 'passed',
    preParkRecovery: 'passed',
    generationFences: 'passed',
    durableWakeIntents: 'passed',
    externalProviders: 'not_exercised',
  };
}
