import { randomUUID } from 'node:crypto';
import {
  configuredOwnerPhoneRecipientFingerprint,
  loadConfig,
  reloadConfig,
  resetConfigForTest,
} from '@assistant/config';
import {
  approvalPolicyFingerprint,
  phoneCallOwnerNumberReviewSourceFingerprint,
  type ResolveApprovalInput,
} from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresApprovalPolicyRepository } from './approval-policy-repository.js';
import { createPostgresApprovalRepository } from './approval-repository.js';
import { createDb, type Db } from './client.js';
import {
  agents,
  approvalPolicies,
  approvals,
  conversations,
  messages,
  tasks,
  toolCalls,
} from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

describe('PostgreSQL reviewed owner-number grant transaction', () => {
  let db: Db;
  const agentId = randomUUID();
  const taskIds: string[] = [],
    approvalIds: string[] = [],
    callIds: string[] = [],
    conversationIds: string[] = [];
  const args = { brief: { to: '+14155550123', maxMinutes: 8, goal: 'Discuss my appointment.' } };
  beforeEach(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    db = createDb(url);
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    await db.insert(agents).values({
      id: agentId,
      name: `c-grant-${agentId}`,
      email: `${agentId}@c-grant.invalid`,
      workspacePrefix: `test/${agentId}`,
    });
  });
  afterEach(async () => {
    if (!db) return;
    if (callIds.length)
      await db.update(toolCalls).set({ approvalId: null }).where(inArray(toolCalls.id, callIds));
    if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
    if (callIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, callIds));
    if (conversationIds.length)
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (conversationIds.length)
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    await db.delete(approvalPolicies).where(eq(approvalPolicies.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
    taskIds.length = 0;
    approvalIds.length = 0;
    callIds.length = 0;
    conversationIds.length = 0;
    vi.unstubAllEnvs();
    resetConfigForTest();
  });
  async function prepare(text = 'Call +14155550123 now.'): Promise<ResolveApprovalInput> {
    const taskId = randomUUID();
    taskIds.push(taskId);
    const conversationId = randomUUID(),
      messageId = randomUUID(),
      clientOperationId = randomUUID();
    conversationIds.push(conversationId);
    await db
      .insert(conversations)
      .values({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
    const trigger = {
      source: 'chat',
      agentId,
      conversationId,
      trust: 'owner',
      payload: {
        text,
        triggerMessageId: messageId,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId,
          requestHash: 'a'.repeat(64),
          triggerMessageId: messageId,
          phase: 'queued',
        },
      },
    };
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
      trigger,
      externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
    });
    await db.insert(messages).values({
      id: messageId,
      conversationId,
      taskId,
      role: 'user',
      origin: 'owner',
      text,
      parts: [{ type: 'text', text }],
    });
    const repository = createPostgresApprovalRepository(db);
    const pending = await repository.create({
      taskId,
      step: 0,
      toolName: 'phone.call',
      args,
      decision: {},
      summary: 'Call my number',
    });
    approvalIds.push(pending.approvalId);
    callIds.push(pending.toolCallId);
    const review = await repository.getOwnerCallNumberGrantReview?.(agentId, pending.approvalId);
    if (!review) throw new Error('Expected pending owner call');
    const issued = review.repositoryNow;
    const match = {
      schemaVersion: 1 as const,
      grantId: randomUUID(),
      recipientE164: args.brief.to,
      maxMinutes: 8,
      expiresAt: new Date(issued.getTime() + 7 * 86_400_000).toISOString(),
    };
    return {
      approvalId: pending.approvalId,
      expectedAgentId: agentId,
      decision: 'approved',
      via: 'web',
      policy: {
        agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.to_owner_number.v1',
        effect: 'allow',
        match,
      },
      ownerCallNumberGrant: {
        expectedApprovalId: pending.approvalId,
        expectedAgentId: agentId,
        expectedTaskId: taskId,
        expectedToolCallId: pending.toolCallId,
        sourceArgsFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(args)!,
        reviewIssuedAt: issued.toISOString(),
        reviewExpiresAt: new Date(issued.getTime() + 600_000).toISOString(),
        validityDays: 7,
        directOwnerRequest: review.directOwnerRequest,
        match,
      },
    };
  }
  it('atomically approves and creates one receipt under concurrent submissions; additional grants coexist and paused C cannot be generically enabled', async () => {
    const input = await prepare();
    const repository = createPostgresApprovalRepository(db);
    const results = await Promise.all([repository.resolve(input), repository.resolve(input)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const policies = createPostgresApprovalPolicyRepository(db);
    const rows = await policies.list(agentId);
    expect(rows).toHaveLength(1);
    expect(results.find((result) => result.ok)).toMatchObject({
      ownerCallNumberGrant: {
        policyId: rows[0]!.id,
        grantId: input.ownerCallNumberGrant!.match.grantId,
        expiresAt: input.ownerCallNumberGrant!.match.expiresAt,
      },
    });
    const additional = await prepare();
    expect(
      (await repository.getOwnerCallNumberGrantReview?.(agentId, additional.approvalId!))
        ?.existingActiveGrants,
    ).toHaveLength(1);
    expect((await repository.resolve(additional)).ok).toBe(true);
    expect(await policies.list(agentId)).toHaveLength(2);
    expect(await policies.setEnabled(agentId, rows[0]!.id, false)).toBe(true);
    expect(await policies.setEnabled(agentId, rows[0]!.id, true)).toBe(false);
    expect((await policies.list(agentId)).find((row) => row.id === rows[0]!.id)?.enabled).toBe(
      false,
    );
  });
  it.each([
    'args',
    'payload',
    'trust',
    'review-expiry',
    'flag',
    'generic-policy',
    'scheduled',
    'legacy-admission',
    'hidden-owner-message',
    'wrong-lifecycle',
    'foreign-owner-message',
    'stale-owner-message',
    'changed-owner-message',
  ] as const)('rejects %s change without approving or creating a permission', async (change) => {
    const input = await prepare();
    if (change === 'args')
      await db
        .update(toolCalls)
        .set({ args: { brief: { ...args.brief, goal: 'Changed' } } })
        .where(eq(toolCalls.id, input.ownerCallNumberGrant!.expectedToolCallId));
    if (change === 'payload')
      await db
        .update(approvals)
        .set({ payload: { brief: { ...args.brief, to: '+14155550999' } } })
        .where(eq(approvals.id, input.approvalId!));
    if (change === 'trust')
      await db
        .update(tasks)
        .set({ trust: 'assistant' })
        .where(eq(tasks.id, input.ownerCallNumberGrant!.expectedTaskId));
    if (change === 'review-expiry') {
      const issued = Date.now() - 600_001;
      input.ownerCallNumberGrant!.reviewIssuedAt = new Date(issued).toISOString();
      input.ownerCallNumberGrant!.reviewExpiresAt = new Date(issued + 600_000).toISOString();
      input.ownerCallNumberGrant!.match.expiresAt = new Date(issued + 7 * 86_400_000).toISOString();
    }
    if (change === 'flag') vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'false');
    if (change === 'scheduled')
      await db
        .update(tasks)
        .set({ type: 'scheduled' })
        .where(eq(tasks.id, input.ownerCallNumberGrant!.expectedTaskId));
    if (change === 'legacy-admission')
      await db
        .update(tasks)
        .set({ trigger: { source: 'chat' } })
        .where(eq(tasks.id, input.ownerCallNumberGrant!.expectedTaskId));
    if (change === 'hidden-owner-message')
      await db
        .update(messages)
        .set({ hiddenAt: new Date() })
        .where(eq(messages.id, input.ownerCallNumberGrant!.directOwnerRequest.ownerMessageId));
    if (change === 'wrong-lifecycle')
      await db
        .update(tasks)
        .set({ status: 'running' })
        .where(eq(tasks.id, input.ownerCallNumberGrant!.expectedTaskId));
    if (change === 'foreign-owner-message') {
      const foreign = await prepare();
      await db
        .update(messages)
        .set({ taskId: foreign.ownerCallNumberGrant!.expectedTaskId })
        .where(eq(messages.id, input.ownerCallNumberGrant!.directOwnerRequest.ownerMessageId));
    }
    if (change === 'changed-owner-message')
      await db
        .update(messages)
        .set({ text: 'Changed admitted owner source' })
        .where(eq(messages.id, input.ownerCallNumberGrant!.directOwnerRequest.ownerMessageId));
    if (change === 'stale-owner-message')
      await db.insert(messages).values({
        id: randomUUID(),
        conversationId: input.ownerCallNumberGrant!.directOwnerRequest.conversationId,
        taskId: input.ownerCallNumberGrant!.expectedTaskId,
        role: 'user',
        origin: 'owner',
        text: 'A newer linked owner message',
        parts: [],
        createdAt: new Date(Date.now() + 1000),
      });
    if (change === 'generic-policy') delete input.ownerCallNumberGrant;
    expect((await createPostgresApprovalRepository(db).resolve(input)).ok).toBe(false);
    expect(
      await db.select().from(approvalPolicies).where(eq(approvalPolicies.agentId, agentId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, input.approvalId!), eq(approvals.status, 'pending'))),
    ).toHaveLength(1);
  });
  it.each([
    'live',
    'paused',
    'expired',
    'source-hidden',
    'source-changed',
    'scheduled',
    'flag',
  ] as const)('fences a selected C start when %s at the atomic boundary', async (change) => {
    const approved = await prepare();
    expect((await createPostgresApprovalRepository(db).resolve(approved)).ok).toBe(true);
    const taskId = randomUUID(),
      conversationId = randomUUID(),
      messageId = randomUUID(),
      clientOperationId = randomUUID();
    taskIds.push(taskId);
    conversationIds.push(conversationId);
    const text = 'Call +14155550123 now.';
    await db
      .insert(conversations)
      .values({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
    const trigger = {
      source: 'chat',
      agentId,
      conversationId,
      trust: 'owner',
      payload: {
        text,
        triggerMessageId: messageId,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId,
          requestHash: 'a'.repeat(64),
          triggerMessageId: messageId,
          phase: 'streaming',
        },
      },
    };
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
      trigger,
      externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
    });
    await db.insert(messages).values({
      id: messageId,
      taskId,
      conversationId,
      role: 'user',
      origin: 'owner',
      text,
      parts: [{ type: 'text', text }],
    });
    const execution = createPostgresToolExecutionRepository(db);
    const directOwnerRequest = await execution.ownerCallRequest!(agentId, taskId);
    expect(directOwnerRequest).not.toBeNull();
    const rows = await createPostgresApprovalPolicyRepository(db).list(agentId);
    const selected = rows[0]!;
    const match = approved.ownerCallNumberGrant!.match;
    if (change === 'expired') {
      match.expiresAt = new Date(Date.now() - 1).toISOString();
      await db.update(approvalPolicies).set({ match }).where(eq(approvalPolicies.id, selected.id));
      rows[0] = { ...selected, match };
    }
    const input = {
      agentId,
      taskId,
      step: 0,
      toolName: 'phone.call',
      args,
      idempotencyKey: null,
      decision: {},
      expectedPolicyFingerprint: approvalPolicyFingerprint(rows),
      expectedPhoneCallOwnerNumberGrant: {
        policyId: selected.id,
        match,
        directOwnerRequest: directOwnerRequest!,
        recipientAuthority: { kind: 'explicit_number' as const, recipientE164: args.brief.to },
      },
    };
    if (change === 'paused')
      await createPostgresApprovalPolicyRepository(db).setEnabled(agentId, selected.id, false);
    if (change === 'source-hidden')
      await db.update(messages).set({ hiddenAt: new Date() }).where(eq(messages.id, messageId));
    if (change === 'source-changed')
      await db
        .update(messages)
        .set({ text: 'Changed owner request' })
        .where(eq(messages.id, messageId));
    if (change === 'scheduled')
      await db.update(tasks).set({ type: 'scheduled' }).where(eq(tasks.id, taskId));
    if (change === 'flag') vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'false');
    const started = await execution.start(input);
    if (started) callIds.push(started.id);
    if (change === 'live') expect(started?.status).toBe('executing');
    else expect(started).toBeNull();
  });
  it.each([
    'start-live',
    'claim-live',
    'start-revoked',
    'start-expired',
    'start-replaced',
    'claim-revoked',
    'claim-expired',
    'claim-replaced',
    'ordinary-approval-independent',
  ] as const)(
    'rechecks actual owner autonomy at %s without manufacturing it for ordinary approval',
    async (scenario) => {
      const input = await prepare();
      const ordinary = {
        approvalId: input.approvalId!,
        expectedAgentId: agentId,
        decision: 'approved' as const,
        via: 'web' as const,
      };
      expect((await createPostgresApprovalRepository(db).resolve(ordinary)).ok).toBe(true);
      const taskId = input.ownerCallNumberGrant!.expectedTaskId;
      const now = Date.now();
      const grant = {
        grantedAt: new Date(now - 1_000).toISOString(),
        grantedVia: 'composer' as const,
        expiresAt: new Date(now + (scenario.endsWith('expired') ? 80 : 3_600_000)).toISOString(),
        revokedAt: null,
      };
      await db
        .update(tasks)
        .set({ status: 'running', autonomyGrant: grant })
        .where(eq(tasks.id, taskId));
      const expectedOwnerAutonomyGrant = { trust: 'owner' as const, grant: structuredClone(grant) };
      if (scenario.endsWith('expired')) await new Promise((resolve) => setTimeout(resolve, 120));
      else if (scenario.endsWith('replaced'))
        await db
          .update(tasks)
          .set({ autonomyGrant: { ...grant, grantedAt: new Date(now).toISOString() } })
          .where(eq(tasks.id, taskId));
      else if (!scenario.endsWith('live'))
        await db
          .update(tasks)
          .set({ autonomyGrant: { ...grant, revokedAt: new Date().toISOString() } })
          .where(eq(tasks.id, taskId));
      const execution = createPostgresToolExecutionRepository(db);
      if (scenario.startsWith('start')) {
        const started = await execution.start({
          agentId,
          taskId,
          step: 1,
          toolName: 'phone.call',
          args,
          idempotencyKey: null,
          decision: {},
          expectedPolicyFingerprint: approvalPolicyFingerprint([]),
          expectedOwnerAutonomyGrant,
        });
        if (scenario === 'start-live') {
          expect(started?.status).toBe('executing');
          if (started) callIds.push(started.id);
        } else expect(started).toBeNull();
      } else {
        const result = await execution.claim({
          agentId,
          taskId,
          toolCallId: input.ownerCallNumberGrant!.expectedToolCallId,
          args,
          decision: {},
          expectedApprovalId: input.approvalId,
          expectedResolutionPayload: null,
          expectedPolicyFingerprint: approvalPolicyFingerprint([]),
          expectedTaskTrust: 'owner',
          expectedTaskStatus: 'running',
          ...(scenario === 'ordinary-approval-independent' ? {} : { expectedOwnerAutonomyGrant }),
        });
        if (scenario === 'ordinary-approval-independent' || scenario === 'claim-live')
          expect(result && 'toolCall' in result && result.toolCall.status).toBe('executing');
        else expect(result).toMatchObject({ type: 'stale_authorization' });
      }
    },
  );

  it.each(['live', 'paused', 'expired', 'hidden-source', 'scheduled'] as const)(
    'fences the selected C policy and admitted source on an approved claim: %s',
    async (change) => {
      const input = await prepare();
      expect((await createPostgresApprovalRepository(db).resolve(input)).ok).toBe(true);
      const taskId = input.ownerCallNumberGrant!.expectedTaskId;
      await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId));
      const execution = createPostgresToolExecutionRepository(db),
        policyRepository = createPostgresApprovalPolicyRepository(db);
      const directOwnerRequest = await execution.ownerCallRequest!(agentId, taskId);
      expect(directOwnerRequest).not.toBeNull();
      const rows = await policyRepository.list(agentId),
        selected = rows[0]!;
      const match = { ...input.ownerCallNumberGrant!.match };
      if (change === 'expired') {
        match.expiresAt = new Date(Date.now() - 1).toISOString();
        await db
          .update(approvalPolicies)
          .set({ match })
          .where(eq(approvalPolicies.id, selected.id));
        rows[0] = { ...selected, match };
      }
      const claimInput = {
        agentId,
        taskId,
        toolCallId: input.ownerCallNumberGrant!.expectedToolCallId,
        args,
        decision: {},
        expectedApprovalId: input.approvalId,
        expectedResolutionPayload: null,
        expectedPolicyFingerprint: approvalPolicyFingerprint(rows),
        expectedTaskTrust: 'owner',
        expectedTaskStatus: 'running',
        expectedPhoneCallOwnerNumberGrant: {
          policyId: selected.id,
          match,
          directOwnerRequest: directOwnerRequest!,
          recipientAuthority: { kind: 'explicit_number' as const, recipientE164: args.brief.to },
        },
      };
      if (change === 'paused') await policyRepository.setEnabled(agentId, selected.id, false);
      if (change === 'hidden-source')
        await db
          .update(messages)
          .set({ hiddenAt: new Date() })
          .where(eq(messages.id, directOwnerRequest!.ownerMessageId));
      if (change === 'scheduled')
        await db.update(tasks).set({ type: 'scheduled' }).where(eq(tasks.id, taskId));
      const result = await execution.claim(claimInput);
      if (change === 'live')
        expect(result && 'toolCall' in result && result.toolCall.status).toBe('executing');
      else expect(result).toMatchObject({ type: 'stale_authorization' });
    },
  );

  describe.each(['start', 'claim'] as const)('atomic %s trusted routing', (method) => {
    it.each([
      'live',
      'cached-environment-change',
      'wrong-reload',
      'missing-reload',
      'invalid-reload',
      'fabricated-number',
      'explicit-other-route',
      'withdrawn',
    ] as const)(
      'derives the stored action recipient and rechecks loaded config: %s',
      async (scenario) => {
        const text =
          scenario === 'fabricated-number'
            ? 'Call Bob now.'
            : scenario === 'explicit-other-route'
              ? 'Call me at +14155550999 now.'
              : scenario === 'withdrawn'
                ? 'Call me now. Actually, do not call me.'
                : 'Call me now.';
        const input = await prepare(text);
        expect((await createPostgresApprovalRepository(db).resolve(input)).ok).toBe(true);
        const taskId = input.ownerCallNumberGrant!.expectedTaskId;
        await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId));
        const execution = createPostgresToolExecutionRepository(db);
        const directOwnerRequest = await execution.ownerCallRequest!(agentId, taskId);
        expect(directOwnerRequest).not.toBeNull();
        const policies = createPostgresApprovalPolicyRepository(db);
        const rows = await policies.list(agentId),
          selected = rows[0]!;
        reloadConfig({ OWNER_PHONE: args.brief.to, PHONE_CALL_TO_OWNER_GRANT_ENABLED: 'true' });
        const fingerprint = configuredOwnerPhoneRecipientFingerprint(args.brief.to)!;
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        const recipientAuthority =
          scenario === 'fabricated-number'
            ? { kind: 'explicit_number' as const, recipientE164: args.brief.to }
            : {
                kind: 'configured_owner_phone' as const,
                recipientE164: args.brief.to,
                fingerprint,
              };
        const expectedPhoneCallOwnerNumberGrant = {
          policyId: selected.id,
          match: input.ownerCallNumberGrant!.match,
          directOwnerRequest: directOwnerRequest!,
          recipientAuthority,
        };
        if (scenario === 'cached-environment-change') loadConfig({ OWNER_PHONE: '+14155550999' });
        if (scenario === 'wrong-reload') reloadConfig({ OWNER_PHONE: '+14155550999' });
        if (scenario === 'missing-reload') reloadConfig({ OWNER_PHONE: '' });
        if (scenario === 'invalid-reload') reloadConfig({ OWNER_PHONE: '+1 (415) 555-0123' });
        const live = scenario === 'live' || scenario === 'cached-environment-change';
        if (method === 'start') {
          const started = await execution.start({
            agentId,
            taskId,
            step: 1,
            toolName: 'phone.call',
            args,
            idempotencyKey: null,
            decision: {},
            expectedPolicyFingerprint: approvalPolicyFingerprint(rows),
            expectedPhoneCallOwnerNumberGrant,
          });
          if (started) callIds.push(started.id);
          if (live) expect(started?.status).toBe('executing');
          else expect(started).toBeNull();
        } else {
          const result = await execution.claim({
            agentId,
            taskId,
            toolCallId: input.ownerCallNumberGrant!.expectedToolCallId,
            args,
            decision: {},
            expectedApprovalId: input.approvalId,
            expectedResolutionPayload: null,
            expectedPolicyFingerprint: approvalPolicyFingerprint(rows),
            expectedTaskTrust: 'owner',
            expectedTaskStatus: 'running',
            expectedPhoneCallOwnerNumberGrant,
          });
          if (live)
            expect(result && 'toolCall' in result && result.toolCall.status).toBe('executing');
          else expect(result).toMatchObject({ type: 'stale_authorization' });
        }
      },
    );
  });
});
