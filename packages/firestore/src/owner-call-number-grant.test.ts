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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore reviewed owner-number grant transaction',
  () => {
    let store: InstallationStore;
    let clock: Date;
    const agentId = 'owner';
    const args = { brief: { to: '+14155550123', maxMinutes: 8, goal: 'Discuss my appointment.' } };
    beforeEach(async () => {
      clock = new Date('2026-10-23T12:00:00.000Z');
      store = emulatorStore(() => new Date(clock));
      vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
      await store.doc('agents', agentId).set({ id: agentId, timezone: 'America/Los_Angeles' });
    });
    afterEach(async () => {
      await disposeStore(store);
      vi.unstubAllEnvs();
      resetConfigForTest();
    });
    async function prepare(text = 'Call +14155550123 now.'): Promise<ResolveApprovalInput> {
      const taskId = randomUUID();
      const conversationId = randomUUID(),
        messageId = randomUUID(),
        clientOperationId = randomUUID();
      await store
        .doc('conversations', conversationId)
        .set({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
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
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'waiting_approval',
        queueGeneration: 0,
        trigger,
        externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
      });
      await store.doc('messages', messageId).set({
        id: messageId,
        taskId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text,
        hiddenAt: null,
        createdAt: clock,
      });
      const repository = new FirestoreApprovalRepository(store);
      const pending = await repository.create({
        taskId,
        step: 0,
        toolName: 'phone.call',
        args,
        decision: {},
        summary: 'Call my number',
      });
      const review = await repository.getOwnerCallNumberGrantReview(agentId, pending.approvalId);
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
    it('atomically grants once under concurrent final submits and retains additional/paused scopes separately', async () => {
      const repository = new FirestoreApprovalRepository(store),
        policies = new FirestoreApprovalPolicyRepository(store);
      const input = await prepare();
      const results = await Promise.all([repository.resolve(input), repository.resolve(input)]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
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
        (await repository.getOwnerCallNumberGrantReview(agentId, additional.approvalId!))
          ?.existingActiveGrants,
      ).toHaveLength(1);
      expect((await repository.resolve(additional)).ok).toBe(true);
      expect(await policies.list(agentId)).toHaveLength(2);
      expect(await policies.setEnabled(agentId, rows[0]!.id, false)).toBe(true);
      expect(await policies.setEnabled(agentId, rows[0]!.id, true)).toBe(false);
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
    ] as const)('rejects %s mutation without changing approval or policies', async (change) => {
      const input = await prepare();
      if (change === 'args')
        await store
          .doc('toolCalls', input.ownerCallNumberGrant!.expectedToolCallId)
          .update({ args: { brief: { ...args.brief, goal: 'Changed' } } });
      if (change === 'payload')
        await store
          .doc('approvals', input.approvalId!)
          .update({ payload: { brief: { ...args.brief, to: '+14155550999' } } });
      if (change === 'trust')
        await store
          .doc('tasks', input.ownerCallNumberGrant!.expectedTaskId)
          .update({ trust: 'assistant' });
      if (change === 'review-expiry') clock = new Date(clock.getTime() + 600_000);
      if (change === 'flag') vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'false');
      if (change === 'scheduled')
        await store
          .doc('tasks', input.ownerCallNumberGrant!.expectedTaskId)
          .update({ type: 'scheduled' });
      if (change === 'legacy-admission')
        await store
          .doc('tasks', input.ownerCallNumberGrant!.expectedTaskId)
          .update({ trigger: { source: 'chat' } });
      if (change === 'hidden-owner-message')
        await store
          .doc('messages', input.ownerCallNumberGrant!.directOwnerRequest.ownerMessageId)
          .update({ hiddenAt: clock });
      if (change === 'wrong-lifecycle')
        await store
          .doc('tasks', input.ownerCallNumberGrant!.expectedTaskId)
          .update({ status: 'running' });
      if (change === 'foreign-owner-message') {
        const foreign = await prepare();
        await store
          .doc('messages', input.ownerCallNumberGrant!.directOwnerRequest.ownerMessageId)
          .update({ taskId: foreign.ownerCallNumberGrant!.expectedTaskId });
      }
      if (change === 'changed-owner-message')
        await store
          .doc('messages', input.ownerCallNumberGrant!.directOwnerRequest.ownerMessageId)
          .update({ text: 'Changed admitted owner source' });
      if (change === 'stale-owner-message') {
        const id = randomUUID();
        await store.doc('messages', id).set({
          id,
          conversationId: input.ownerCallNumberGrant!.directOwnerRequest.conversationId,
          taskId: input.ownerCallNumberGrant!.expectedTaskId,
          role: 'user',
          origin: 'owner',
          text: 'A newer linked owner message',
          hiddenAt: null,
          createdAt: new Date(clock.getTime() + 1000),
        });
      }
      if (change === 'generic-policy') delete input.ownerCallNumberGrant;
      expect((await new FirestoreApprovalRepository(store).resolve(input)).ok).toBe(false);
      expect((await store.collection('approvalPolicies').get()).size).toBe(0);
      expect((await store.doc('approvals', input.approvalId!).get()).get('status')).toBe('pending');
    });
    it.each([
      'live',
      'paused',
      'expiry-boundary',
      'source-hidden',
      'source-changed',
      'scheduled',
      'flag',
    ] as const)('fences a selected C start when %s at the atomic boundary', async (change) => {
      const approved = await prepare();
      expect((await new FirestoreApprovalRepository(store).resolve(approved)).ok).toBe(true);
      const taskId = randomUUID(),
        conversationId = randomUUID(),
        messageId = randomUUID(),
        clientOperationId = randomUUID();
      const text = 'Call +14155550123 now.';
      await store
        .doc('conversations', conversationId)
        .set({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
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
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'running',
        trigger,
        externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
      });
      await store.doc('messages', messageId).set({
        id: messageId,
        taskId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text,
        hiddenAt: null,
        createdAt: clock,
      });
      const execution = new FirestoreToolExecutionRepository(store);
      const directOwnerRequest = await execution.ownerCallRequest(agentId, taskId);
      expect(directOwnerRequest).not.toBeNull();
      const policies = new FirestoreApprovalPolicyRepository(store);
      const rows = await policies.list(agentId);
      const selected = rows[0]!;
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
          match: approved.ownerCallNumberGrant!.match,
          directOwnerRequest: directOwnerRequest!,
          recipientAuthority: { kind: 'explicit_number' as const, recipientE164: args.brief.to },
        },
      };
      if (change === 'paused') await policies.setEnabled(agentId, selected.id, false);
      if (change === 'source-hidden')
        await store.doc('messages', messageId).update({ hiddenAt: clock });
      if (change === 'source-changed')
        await store.doc('messages', messageId).update({ text: 'Changed owner request' });
      if (change === 'scheduled') await store.doc('tasks', taskId).update({ type: 'scheduled' });
      if (change === 'flag') vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'false');
      if (change === 'expiry-boundary')
        clock = new Date(approved.ownerCallNumberGrant!.match.expiresAt);
      const started = await execution.start(input);
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
        expect(
          (
            await new FirestoreApprovalRepository(store).resolve({
              approvalId: input.approvalId!,
              expectedAgentId: agentId,
              decision: 'approved',
              via: 'web',
            })
          ).ok,
        ).toBe(true);
        const taskId = input.ownerCallNumberGrant!.expectedTaskId;
        const grant = {
          grantedAt: new Date(clock.getTime() - 1_000).toISOString(),
          grantedVia: 'composer' as const,
          expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
          revokedAt: null,
        };
        await store.doc('tasks', taskId).update({ status: 'running', autonomyGrant: grant });
        const expectedOwnerAutonomyGrant = {
          trust: 'owner' as const,
          grant: structuredClone(grant),
        };
        if (scenario.endsWith('expired')) clock = new Date(grant.expiresAt);
        else if (scenario.endsWith('replaced'))
          await store
            .doc('tasks', taskId)
            .update({ autonomyGrant: { ...grant, grantedAt: clock.toISOString() } });
        else if (!scenario.endsWith('live'))
          await store
            .doc('tasks', taskId)
            .update({ autonomyGrant: { ...grant, revokedAt: clock.toISOString() } });
        const execution = new FirestoreToolExecutionRepository(store);
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
        expect((await new FirestoreApprovalRepository(store).resolve(input)).ok).toBe(true);
        const taskId = input.ownerCallNumberGrant!.expectedTaskId;
        await store.doc('tasks', taskId).update({ status: 'running' });
        const execution = new FirestoreToolExecutionRepository(store),
          policies = new FirestoreApprovalPolicyRepository(store);
        const directOwnerRequest = await execution.ownerCallRequest(agentId, taskId);
        expect(directOwnerRequest).not.toBeNull();
        const rows = await policies.list(agentId),
          selected = rows[0]!;
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
            match: input.ownerCallNumberGrant!.match,
            directOwnerRequest: directOwnerRequest!,
            recipientAuthority: { kind: 'explicit_number' as const, recipientE164: args.brief.to },
          },
        };
        if (change === 'paused') await policies.setEnabled(agentId, selected.id, false);
        if (change === 'expired') clock = new Date(input.ownerCallNumberGrant!.match.expiresAt);
        if (change === 'hidden-source')
          await store
            .doc('messages', directOwnerRequest!.ownerMessageId)
            .update({ hiddenAt: clock });
        if (change === 'scheduled') await store.doc('tasks', taskId).update({ type: 'scheduled' });
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
          expect((await new FirestoreApprovalRepository(store).resolve(input)).ok).toBe(true);
          const taskId = input.ownerCallNumberGrant!.expectedTaskId;
          await store.doc('tasks', taskId).update({ status: 'running' });
          const execution = new FirestoreToolExecutionRepository(store);
          const directOwnerRequest = await execution.ownerCallRequest!(agentId, taskId);
          expect(directOwnerRequest).not.toBeNull();
          const policies = new FirestoreApprovalPolicyRepository(store);
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
  },
);
