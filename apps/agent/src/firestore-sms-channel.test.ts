import { randomUUID } from 'node:crypto';
import { loadVoiceContext } from '@assistant/core';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { deliverSmsFinal, handleInboundSms, type SmsChannelDeps } from '@assistant/modules';
import type { ExecutionPersistence } from '@assistant/persistence';
import { AmbiguousTwilioDeliveryError, ToolRegistry } from '@assistant/tools';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { embeddingSpaceKey } from '../../../packages/firestore/src/memory.js';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { notifyOwnerBySms } from '../../../packages/modules/src/sms/channel.js';

const OWNER_PHONE = '+14155550100';
const SPACE = { provider: 'synthetic', model: 'sms-fixture', dimensions: 1536, revision: '1' };

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0);
  vector[index] = 1;
  return vector;
}

/** One SMS-approvable tool and one that must be reviewed on the dashboard. */
function registry(): ToolRegistry {
  const base = {
    description: 'test',
    inputSchema: z.object({}),
    risk: 'approval' as const,
    acceptsUntrustedInput: false,
    execute: async () => ({}),
  };
  return new ToolRegistry()
    .register({ ...base, name: 'test.sms-ok', approvalSummary: () => 'a low-risk action' })
    .register(
      { ...base, name: 'test.sms-restricted', approvalSummary: () => 'send an email' },
      { outwardFacing: true },
    );
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore SMS channel',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: SmsChannelDeps;
    let sent: Array<{ to: string; body: string }>;

    beforeEach(async () => {
      store = emulatorStore();
      sent = [];
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      const smsChannel = persistence.smsChannel;
      if (!smsChannel) throw new Error('missing SMS channel repository');
      deps = {
        config: { OWNER_PHONE } as SmsChannelDeps['config'],
        registry: registry(),
        twilio: {
          configured: () => true,
          send: async (to: string, body: string) => {
            sent.push({ to, body });
            return { sid: `SM-${sent.length}` };
          },
        } as unknown as SmsChannelDeps['twilio'],
        persistence: { ...persistence, smsChannel },
        owner: async () => ({ id: agentId }),
      };
      await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    const inbound = (messageSid: string, body: string, from = OWNER_PHONE) =>
      handleInboundSms(deps, { messageSid, from, to: '+15550000000', body });

    it('turns an owner text into one sms_turn in one bound thread, idempotent on MessageSid', async () => {
      const [first, second] = await Promise.all([
        inbound('SM-a', 'Book a table for two'),
        inbound('SM-b', 'Somewhere quiet'),
      ]);
      const redelivered = await inbound('SM-a', 'Book a table for two');
      expect(first).toMatchObject({ kind: 'task', created: true });
      expect(second).toMatchObject({ kind: 'task', created: true });
      expect(redelivered).toEqual({
        kind: 'task',
        taskId: (first as { taskId: string }).taskId,
        created: false,
      });

      const conversations = await store
        .collection('conversations')
        .where('channel', '==', 'sms')
        .get();
      expect(conversations.docs.map((doc) => [doc.get('trust'), doc.get('title')])).toEqual([
        ['owner', `SMS ${OWNER_PHONE}`],
      ]);
      const conversationId = conversations.docs[0]?.get('id');
      const messages = await store
        .collection('messages')
        .where('conversationId', '==', conversationId)
        .get();
      expect(messages.docs.map((doc) => doc.get('text')).sort()).toEqual([
        'Book a table for two',
        'Somewhere quiet',
      ]);
      const task = await store.doc('tasks', (first as { taskId: string }).taskId).get();
      expect(task.get('type')).toBe('sms_turn');
      expect(task.get('conversationId')).toBe(conversationId);
    });

    it('ignores an unpaired number before touching storage', async () => {
      expect(await inbound('SM-x', 'hello', '+19995550000')).toEqual({
        kind: 'ignored',
        reason: 'sms sender is not paired owner',
      });
      expect((await store.collection('conversations').get()).empty).toBe(true);
    });

    it('resolves only SMS-approvable approvals by short code', async () => {
      const approval = async (toolName: string) => {
        const { task } = await persistence.tasks.createTask({
          agentId,
          type: 'adhoc',
          trust: 'owner',
          trigger: { source: 'owner', payload: { instruction: 'x' } },
        });
        return persistence.approvals.create({
          taskId: task.id,
          step: 0,
          toolName,
          args: {},
          decision: {},
          summary: `Run ${toolName}`,
        });
      };
      const ok = await approval('test.sms-ok');
      const restricted = await approval('test.sms-restricted');

      expect(await inbound('SM-1', `YES ${restricted.shortCode}`)).toEqual({
        kind: 'approval',
        resolved: false,
        shortCode: restricted.shortCode,
        decision: 'approved',
      });
      expect(sent.map((sms) => sms.body)).toEqual([
        expect.stringContaining(
          `Approval ${restricted.shortCode} can only be confirmed on the dashboard`,
        ),
      ]);
      expect((await store.doc('approvals', restricted.approvalId).get()).get('status')).toBe(
        'pending',
      );

      expect(await inbound('SM-2', `YES ${ok.shortCode}`)).toMatchObject({
        kind: 'approval',
        resolved: true,
      });
      const resolved = await store.doc('approvals', ok.approvalId).get();
      expect([resolved.get('status'), resolved.get('resolvedVia')]).toEqual(['approved', 'sms']);
    });

    it('replies to the bound owner number and meters every send against the channel limit', async () => {
      await inbound('SM-1', 'What is on today?');
      const [task] = (await store.collection('tasks').where('type', '==', 'sms_turn').get()).docs;
      const row = task?.data() as {
        id: string;
        type: string;
        conversationId: string;
        trust: string;
      };

      expect(
        await deliverSmsFinal(
          deps,
          row as never,
          'Two meetings and a dentist visit.',
          'sms-attempt-1',
        ),
      ).toMatchObject({ status: 'accepted' });
      expect(sent).toEqual([{ to: OWNER_PHONE, body: 'Two meetings and a dentist visit.' }]);
      const changedOwnerPhone = {
        ...deps,
        config: { ...deps.config, OWNER_PHONE: '+18885559999' },
      } as unknown as SmsChannelDeps;
      expect(
        await deliverSmsFinal(
          changedOwnerPhone,
          row as never,
          'do not send to the old owner number',
          'sms-attempt-2',
        ),
      ).toMatchObject({ status: 'rejected', reason: 'owner-phone-binding-changed' });
      expect(sent).toHaveLength(1);

      const ambiguousSms = {
        ...deps,
        twilio: {
          ...deps.twilio,
          send: async () => {
            throw new AmbiguousTwilioDeliveryError('provider response lost after acceptance');
          },
        },
      } as unknown as SmsChannelDeps;
      expect(
        await deliverSmsFinal(
          ambiguousSms,
          row as never,
          'provider may already have sent this',
          'sms-attempt-ambiguous',
        ),
      ).toMatchObject({ status: 'unknown', reason: 'provider-outcome-unknown' });
      expect(sent).toHaveLength(1);
      const events = await store.collection('costEvents').where('source', '==', 'twilio_sms').get();
      expect(events.size).toBe(2);

      // A foreign or non-SMS conversation never receives the reply.
      expect(
        await deliverSmsFinal(
          deps,
          { ...row, conversationId: randomUUID() } as never,
          'nope',
          'sms-attempt-3',
        ),
      ).toMatchObject({ status: 'rejected' });
      expect(sent).toHaveLength(1);

      await store.doc('rateLimits', 'channel:sms').set({
        scope: 'channel:sms',
        maxPerHour: 1,
        maxPerDay: null,
        updatedAt: new Date(),
      });
      await expect(notifyOwnerBySms(deps, { text: 'One more' })).resolves.toEqual({
        legs: [{ channel: 'sms', status: 'failed', reason: 'channel-rate-limit' }],
      });
      expect(sent).toHaveLength(1);
    });

    it('reads the voice profile and the nearest samples of the register in the configured space', async () => {
      const voice = persistence.voiceContext;
      if (!voice) throw new Error('missing voice repository');
      await store.doc('voiceProfile', '1').set({
        id: 1,
        description: 'Brief and warm',
        dos: ['use first names'],
        donts: ['no emoji'],
        signature: '— Ada',
        updatedAt: new Date(),
      });
      const sample = (text: string, register: string, index: number, space = SPACE) =>
        store.doc('writingSamples', randomUUID()).set({
          id: randomUUID(),
          agentId,
          register,
          text,
          context: 'upload',
          embedding: FieldValue.vector(axis(index)),
          embeddingSpace: embeddingSpaceKey(space),
          createdAt: new Date(),
        });
      await sample('Running late, sorry!', 'sms', 1);
      await sample('On my way.', 'sms', 2);
      await sample('Dear team, please find attached', 'email_professional', 1);
      await sample('Stale space', 'sms', 1, { ...SPACE, revision: '2' });

      const router = {
        embeddingSpace: async () => SPACE,
        embed: async () => [axis(1)],
      } as unknown as Parameters<typeof loadVoiceContext>[1];
      expect(await loadVoiceContext(voice, router, 'sms', 'late again')).toEqual({
        description: 'Brief and warm',
        dos: ['use first names'],
        donts: ['no emoji'],
        signature: '— Ada',
        samples: ['Running late, sorry!', 'On my way.'],
      });
      expect((await loadVoiceContext(voice, router, 'chat', 'x')).samples).toEqual([]);
    });
  },
);
