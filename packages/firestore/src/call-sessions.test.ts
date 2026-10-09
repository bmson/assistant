import { randomUUID } from 'node:crypto';
import type { CallCheckin } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreCallSessionRepository } from './call-sessions.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

function requiredRevision(
  value: CallCheckin | undefined | null,
): CallCheckin & { revision: number } {
  if (!value || typeof value.revision !== 'number')
    throw new Error('Test check-in revision missing');
  return value as CallCheckin & { revision: number };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore call sessions', () => {
  let store: InstallationStore;
  let calls: FirestoreCallSessionRepository;
  const agentId = randomUUID();

  beforeEach(() => {
    store = emulatorStore();
    calls = new FirestoreCallSessionRepository(store, agentId);
  });

  afterEach(async () => disposeStore(store));

  const create = (id = randomUUID()) =>
    calls.create({
      id,
      agentId,
      taskId: randomUUID(),
      toolCallId: randomUUID(),
      status: 'dialing',
      to: '+14155550123',
      contactName: 'Nopa',
      brief: { goal: 'Book a table' },
      voiceModel: 'openai:gpt-realtime-2.1',
      voiceRoute: null,
      maxMinutes: 10,
      streamTokenHash: 'hash-1',
      callbackToken: 'wake',
      reservationId: 'res',
    });

  it('redeems the stream token once and marks the call connected', async () => {
    const call = await create();
    expect(await calls.claimStream(call.id, 'wrong', new Date())).toBeNull();
    const claimed = await calls.claimStream(call.id, 'hash-1', new Date());
    expect(claimed).toMatchObject({ status: 'in_progress', streamTokenHash: null });
    expect(claimed?.startedAt).toBeInstanceOf(Date);
    expect(await calls.claimStream(call.id, 'hash-1', new Date())).toBeNull();
    expect(await calls.activeCount(agentId)).toBe(1);
  });

  it('finishes a call exactly once and stops counting it as active', async () => {
    const call = await create();
    expect(await calls.finish(call.id, { status: 'completed', outcome: 'achieved' })).toMatchObject(
      {
        status: 'completed',
      },
    );
    expect(await calls.finish(call.id, { status: 'failed' })).toBeNull();
    expect((await calls.get(call.id))?.status).toBe('completed');
    expect(await calls.activeCount(agentId)).toBe(0);
    expect(await calls.countSince(agentId, new Date(Date.now() - 60_000))).toBe(1);
    expect(await calls.requestHangup(agentId, call.id)).toBe(false);
  });

  it('persists late cost components after the result callback was acknowledged', async () => {
    const call = await create();
    const pending = { status: 'pending' as const, basis: 'waiting for provider', usd: null };
    const ledger = {
      version: 1 as const,
      currency: 'USD' as const,
      createdAt: new Date().toISOString(),
      complete: false,
      knownSubtotalUsd: 0,
      components: {
        carrier: pending,
        mediaStream: pending,
        amd: pending,
        modelAudioInput: pending,
        modelAudioOutput: pending,
        modelTextInput: pending,
        modelTextOutput: pending,
        modelCachedInput: pending,
        modelReasoning: pending,
        modelTranscription: pending,
        backend: pending,
        runtime: pending,
      },
    };
    await calls.finish(call.id, {
      status: 'completed',
      outcome: 'not_achieved',
      summary: 'Call ended.',
      durationSeconds: 30,
      endedAt: new Date(),
      costUsd: null,
      finishDelivery: {
        version: 1,
        attempts: 0,
        nextAttemptAt: new Date(),
        result: {
          callId: call.id,
          to: call.to,
          status: 'completed',
          outcome: 'not_achieved',
          summary: 'Call ended.',
          notes: [],
          durationSeconds: 30,
          transcript: [],
          costUsd: null,
          costBreakdown: ledger,
        },
        costs: {
          done: false,
          ledger,
          twilio: {
            reservationId: 'res',
            idempotencyKey: `call:${call.id}:twilio`,
            usd: 0,
            minutes: 1,
            unit: 'minute',
            unitPriceUsd: 0.014,
          },
          model: {
            idempotencyKey: `call:${call.id}:model`,
            usd: 0,
            provider: 'openai',
            model: 'gpt-realtime-2.1',
          },
        },
        resultDelivered: false,
      },
    });
    expect(await calls.markFinishDelivery(call.id, 'result')).toBe(true);
    const settled = {
      ...ledger,
      knownSubtotalUsd: 0.014,
      components: {
        ...ledger.components,
        carrier: { status: 'provider_reported' as const, basis: 'Twilio receipt', usd: 0.014 },
      },
    };
    expect(await calls.updateFinishCostLedger(call.id, settled, null)).toBe(true);
    expect(await calls.get(call.id)).toMatchObject({
      finishDelivery: {
        resultDelivered: true,
        costs: { done: false, ledger: { components: { carrier: { usd: 0.014 } } } },
      },
      costUsd: null,
    });
  });

  it('keeps transcript, notes and one answer per check-in, scoped to the owner', async () => {
    const call = await create();
    await calls.update(call.id, { twilioCallSid: `CA${'c'.repeat(32)}` });
    expect((await calls.getByCallSid(`CA${'c'.repeat(32)}`))?.id).toBe(call.id);
    await calls.appendTranscript(call.id, [{ role: 'caller', text: 'Hello?', at: 't1' }]);
    await calls.appendTranscript(call.id, [{ role: 'assistant', text: 'Hi!', at: 't2' }]);
    await calls.appendNote(call.id, 'Opens at 5pm');
    await calls.addCheckin(call.id, {
      id: 'q1',
      question: '7:45?',
      askedAt: 't3',
      answer: null,
      answeredAt: null,
      via: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const checkin = requiredRevision(
      ((await calls.get(call.id))?.checkins as CallCheckin[] | undefined)?.[0],
    );
    expect(
      await calls.answerCheckin(randomUUID(), call.id, 'q1', checkin.revision, 'no', 'web'),
    ).toBe(false);
    expect(await calls.markCheckinDelivery(call.id, 'q1', checkin.revision, true)).toBe(true);
    expect(
      await calls.answerCheckin(agentId, call.id, 'q1', checkin.revision, 'Yes', 'mobile'),
    ).toBe(true);
    expect(await calls.answerCheckin(agentId, call.id, 'q1', checkin.revision, 'No', 'web')).toBe(
      false,
    );
    const row = await calls.get(call.id);
    expect(row?.transcript).toEqual([
      { role: 'caller', text: 'Hello?', at: 't1' },
      { role: 'assistant', text: 'Hi!', at: 't2' },
    ]);
    expect(row?.notes).toEqual(['Opens at 5pm']);
    expect(row?.checkins).toEqual([expect.objectContaining({ answer: 'Yes', via: 'mobile' })]);
    expect(await calls.requestHangup(agentId, call.id)).toBe(true);
    expect((await calls.list(agentId, 10)).map((c) => c.id)).toEqual([call.id]);
    expect(await new FirestoreCallSessionRepository(store, randomUUID()).get(call.id)).toBeNull();
  });

  it('persists sequence order and treats a retry after process restart as an acknowledgement', async () => {
    const call = await create();
    const later = {
      id: 'later',
      sequence: 2,
      lines: [{ role: 'caller' as const, text: 'later', at: '2' }],
    };
    expect(await calls.appendTranscriptBatch(call.id, later)).toMatchObject({
      accepted: true,
      nextSequence: 1,
    });
    const restarted = new FirestoreCallSessionRepository(store, agentId);
    const first = {
      id: 'first',
      sequence: 1,
      lines: [{ role: 'caller' as const, text: 'first', at: '1' }],
    };
    expect(await restarted.appendTranscriptBatch(call.id, first)).toMatchObject({
      accepted: true,
      nextSequence: 3,
    });
    expect(await restarted.appendTranscriptBatch(call.id, first)).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect((await restarted.get(call.id))?.transcript).toMatchObject([
      { text: 'first', sequence: 1 },
      { text: 'later', sequence: 2 },
    ]);
  });

  it('supersedes prior offers and rejects late or expired answers', async () => {
    const call = await create();
    const offer = (id: string, expiresAt: string) =>
      calls.addCheckin(call.id, {
        id,
        question: id,
        askedAt: new Date().toISOString(),
        answer: null,
        answeredAt: null,
        via: null,
        expiresAt,
      });
    const old = requiredRevision(await offer('old', new Date(Date.now() + 60_000).toISOString()));
    expect(await calls.markCheckinDelivery(call.id, old.id, old.revision, true)).toBe(true);
    const current = requiredRevision(
      await offer('current', new Date(Date.now() - 1_000).toISOString()),
    );
    expect(await calls.markCheckinDelivery(call.id, current.id, current.revision, true)).toBe(
      false,
    );
    expect(await calls.answerCheckin(agentId, call.id, old.id, old.revision, 'late', 'web')).toBe(
      false,
    );
    expect(
      await calls.answerCheckin(agentId, call.id, current.id, current.revision, 'late', 'web'),
    ).toBe(false);
  });
});
