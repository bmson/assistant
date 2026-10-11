import { randomUUID } from 'node:crypto';
import { type CallCheckin, MAX_CALL_VOICE_TOOL_RECEIPTS } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresCallSessionRepository } from './call-session-repository.js';
import { createDb, type Db } from './client.js';
import { agents, callSessions, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
function requiredRevision(
  value: CallCheckin | undefined | null,
): CallCheckin & { revision: number } {
  if (!value || typeof value.revision !== 'number')
    throw new Error('Test check-in revision missing');
  return value as CallCheckin & { revision: number };
}
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL call-session repository', () => {
  let db: Db;
  let agentId: string;
  let taskId: string;
  let toolCallId: string;

  beforeEach(async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    taskId = randomUUID();
    toolCallId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      name: 'call-route-test',
      email: `${agentId}@call-route.invalid`,
      workspacePrefix: `call-route/${agentId}`,
    });
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
    });
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      risk: 'approval',
      status: 'executing',
      args: {},
    });
  });

  afterEach(async () => {
    await db.delete(callSessions).where(eq(callSessions.taskId, taskId));
    await db.delete(toolCalls).where(eq(toolCalls.id, toolCallId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  it('round-trips the immutable route and maps malformed legacy JSON to absent', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const route = {
      version: 1 as const,
      modelId: 'vertex:gemini-live',
      connectionId: 'vertex',
      connectionKind: 'vertex' as const,
      connectionUpdatedAt: null,
      provider: 'vertex' as const,
      providerModel: 'gemini-live',
      endpoint: { kind: 'vertex-live' as const, project: 'project-a', location: 'us-central1' },
      voice: 'Aoede',
      rates: {
        audioInputPerMTok: 1,
        audioOutputPerMTok: 2,
        textInputPerMTok: 3,
        textOutputPerMTok: 4,
      },
    };
    const input = {
      id: randomUUID(),
      agentId,
      taskId,
      toolCallId,
      status: 'dialing',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: route.modelId,
      voiceRoute: route,
      maxMinutes: 5,
      streamTokenHash: 'hash',
      callbackToken: 'wake',
      reservationId: 'reservation',
    };
    const created = await calls.create(input);
    expect((await calls.get(input.id))?.voiceRoute).toEqual(route);
    expect((await calls.list(agentId, 10))[0]?.voiceRoute).toEqual(route);

    await db
      .update(callSessions)
      .set({ voiceRoute: { version: 1, modelId: 'wrong' } })
      .where(eq(callSessions.id, created.id));
    expect((await calls.get(input.id))?.voiceRoute).toBeNull();
  });

  it('atomically records and replays bounded opaque voice note/check-in receipts', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const call = await calls.create({
      id: randomUUID(),
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: 'Nopa',
      brief: { goal: 'Book dinner' },
      voiceModel: 'openai:gpt-realtime-2.1',
      voiceRoute: null,
      maxMinutes: 10,
      streamTokenHash: null,
      callbackToken: 'wake',
      reservationId: null,
    });
    const note = {
      callId: call.id,
      agentId,
      taskId,
      parentToolCallId: toolCallId,
      provider: 'openai' as const,
      providerCallId: 'provider-note-1',
      effect: { kind: 'note' as const, fact: '  Dinner is at 7:30.  ' },
    };
    const concurrent = await Promise.all([
      calls.applyVoiceToolEffect(note),
      calls.applyVoiceToolEffect(note),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['applied', 'replay']);
    const restarted = createPostgresCallSessionRepository(db);
    expect(await restarted.applyVoiceToolEffect(note)).toMatchObject({ status: 'replay' });
    expect((await restarted.get(call.id))?.notes).toEqual(['Dinner is at 7:30.']);
    const receipts = (await restarted.get(call.id))?.voiceToolReceipts ?? [];
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain('Dinner is at 7:30');
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        effect: { kind: 'note', fact: 'Different fact' },
      }),
    ).toEqual({ status: 'conflict' });
    const longNote = {
      ...note,
      providerCallId: 'long-note',
      effect: { kind: 'note' as const, fact: `${'x'.repeat(500)}A` },
    };
    expect(await restarted.applyVoiceToolEffect(longNote)).toMatchObject({ status: 'applied' });
    expect(
      await restarted.applyVoiceToolEffect({
        ...longNote,
        effect: { kind: 'note', fact: `${'x'.repeat(500)}B` },
      }),
    ).toEqual({ status: 'conflict' });
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        effect: {
          kind: 'ask_owner',
          checkin: {
            id: randomUUID(),
            question: 'Same provider id, different action',
            askedAt: new Date().toISOString(),
            answer: null,
            answeredAt: null,
            via: null,
          },
        },
      }),
    ).toEqual({ status: 'conflict' });
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        provider: 'vertex',
        effect: { kind: 'note', fact: 'Dinner is at 7:30.' },
      }),
    ).toMatchObject({ status: 'applied' });
    expect((await restarted.get(call.id))?.notes).toEqual([
      'Dinner is at 7:30.',
      'x'.repeat(500),
      'Dinner is at 7:30.',
    ]);

    const checkinDraft: CallCheckin = {
      id: randomUUID(),
      question: 'Can we accept 7:30?',
      askedAt: new Date().toISOString(),
      answer: null,
      answeredAt: null,
      via: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryStatus: 'pending',
    };
    const checkinInput = {
      ...note,
      providerCallId: 'provider-ask-1',
      effect: { kind: 'ask_owner' as const, checkin: checkinDraft },
    };
    const [firstCheckin, replayCheckin] = await Promise.all([
      restarted.applyVoiceToolEffect(checkinInput),
      restarted.applyVoiceToolEffect(checkinInput),
    ]);
    expect([firstCheckin.status, replayCheckin.status].sort()).toEqual(['applied', 'replay']);
    if (
      firstCheckin.status !== 'applied' ||
      replayCheckin.status !== 'replay' ||
      !firstCheckin.checkin ||
      !replayCheckin.checkin
    )
      throw new Error('voice check-in receipt did not converge');
    expect(replayCheckin.checkin.id).toBe(firstCheckin.checkin.id);
    expect((await restarted.get(call.id))?.checkins).toHaveLength(1);
    expect(
      await restarted.markCheckinDelivery(
        call.id,
        firstCheckin.checkin.id,
        firstCheckin.checkin.revision ?? 0,
        true,
      ),
    ).toBe(true);
    expect(
      await restarted.markCheckinDelivery(
        call.id,
        firstCheckin.checkin.id,
        firstCheckin.checkin.revision ?? 0,
        true,
      ),
    ).toBe(true);
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        agentId: randomUUID(),
        providerCallId: 'foreign',
      }),
    ).toEqual({ status: 'unavailable' });
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        taskId: randomUUID(),
        providerCallId: 'wrong-task',
      }),
    ).toEqual({ status: 'unavailable' });
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        parentToolCallId: randomUUID(),
        providerCallId: 'wrong-parent-tool',
      }),
    ).toEqual({ status: 'unavailable' });
    await restarted.finish(call.id, { status: 'completed' });
    const before = await restarted.get(call.id);
    expect(await restarted.applyVoiceToolEffect(note)).toEqual({ status: 'unavailable' });
    expect(await restarted.applyVoiceToolEffect(checkinInput)).toEqual({ status: 'unavailable' });
    expect(
      await restarted.applyVoiceToolEffect({ ...note, providerCallId: 'after-terminal' }),
    ).toEqual({ status: 'unavailable' });
    expect(await restarted.get(call.id)).toEqual(before);

    const erasedCall = await calls.create({
      id: randomUUID(),
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: 'openai:gpt-realtime-2.1',
      voiceRoute: null,
      maxMinutes: 10,
      streamTokenHash: null,
      callbackToken: 'wake',
      reservationId: null,
    });
    await db.delete(callSessions).where(eq(callSessions.id, erasedCall.id));
    expect(
      await restarted.applyVoiceToolEffect({
        ...note,
        callId: erasedCall.id,
        providerCallId: 'after-erasure',
      }),
    ).toEqual({ status: 'unavailable' });
    expect(await restarted.get(erasedCall.id)).toBeNull();
  });

  it('fails closed at the durable voice receipt cap without evicting replay identities', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const call = await calls.create({
      id: randomUUID(),
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: 'openai:gpt-realtime-2.1',
      voiceRoute: null,
      maxMinutes: 10,
      streamTokenHash: null,
      callbackToken: 'wake',
      reservationId: null,
    });
    const receipts = Array.from({ length: MAX_CALL_VOICE_TOOL_RECEIPTS }, (_, index) => ({
      id: index.toString(16).padStart(64, '0'),
      provider: 'openai',
      kind: 'note',
      argsDigest: 'a'.repeat(64),
      effectId: null,
      committedAt: new Date().toISOString(),
    }));
    await db
      .update(callSessions)
      .set({ voiceToolReceipts: receipts })
      .where(eq(callSessions.id, call.id));
    const result = await calls.applyVoiceToolEffect({
      callId: call.id,
      agentId,
      taskId,
      parentToolCallId: toolCallId,
      provider: 'openai',
      providerCallId: 'cap-hit',
      effect: { kind: 'note', fact: 'Must fail closed.' },
    });
    expect(result).toEqual({ status: 'limit' });
    expect((await calls.get(call.id))?.notes).toEqual([]);
    expect((await calls.get(call.id))?.voiceToolReceipts).toHaveLength(
      MAX_CALL_VOICE_TOOL_RECEIPTS,
    );
  });

  it('commits the winning terminal snapshot and acknowledges outbox legs independently', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const callId = randomUUID();
    const call = await calls.create({
      id: callId,
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: 'openai:realtime',
      voiceRoute: null,
      maxMinutes: 5,
      streamTokenHash: null,
      callbackToken: 'callback-token',
      reservationId: null,
    });
    const unknownCost = { status: 'unknown' as const, basis: 'receipt pending', usd: null };
    const ledger = {
      version: 1 as const,
      currency: 'USD' as const,
      createdAt: new Date().toISOString(),
      complete: false,
      knownSubtotalUsd: 0,
      components: {
        carrier: unknownCost,
        mediaStream: unknownCost,
        amd: unknownCost,
        modelAudioInput: unknownCost,
        modelAudioOutput: unknownCost,
        modelTextInput: unknownCost,
        modelTextOutput: unknownCost,
        modelCachedInput: unknownCost,
        modelReasoning: unknownCost,
        modelTranscription: unknownCost,
        backend: unknownCost,
        runtime: unknownCost,
      },
    };
    const finishDelivery = {
      version: 1 as const,
      attempts: 0,
      nextAttemptAt: new Date(),
      result: {
        callId,
        to: call.to,
        status: 'completed',
        outcome: 'achieved',
        summary: 'Reservation confirmed.',
        notes: [],
        durationSeconds: 60,
        transcript: [],
        costUsd: null,
        costBreakdown: ledger,
      },
      costs: {
        done: false,
        ledger,
        twilio: {
          reservationId: null,
          idempotencyKey: `call:${callId}:twilio`,
          usd: 0.014,
          minutes: 1,
          unit: 'minute',
          unitPriceUsd: 0.014,
        },
        model: {
          idempotencyKey: `call:${callId}:model`,
          usd: 0,
          provider: 'openai',
          model: 'realtime',
        },
      },
      resultDelivered: false,
    };

    const finished = await calls.finish(callId, {
      status: 'completed',
      outcome: 'achieved',
      summary: 'Reservation confirmed.',
      durationSeconds: 60,
      endedAt: new Date(),
      costUsd: null,
      finishDelivery,
    });
    expect(finished?.finishDelivery).toEqual({
      ...finishDelivery,
      nextAttemptAt: finishDelivery.nextAttemptAt.toISOString(),
    });
    expect((await calls.listPendingFinishDelivery(agentId, 10)).map((row) => row.id)).toContain(
      callId,
    );
    expect(await calls.deferFinishDelivery(callId)).toBe(true);
    const deferred = await calls.get(callId);
    expect(deferred?.finishDelivery).toMatchObject({ attempts: 1 });
    expect(
      (await calls.listPendingFinishDelivery(agentId, 10, new Date())).map((row) => row.id),
    ).not.toContain(callId);
    expect(
      (await calls.listPendingFinishDelivery(agentId, 10, new Date(Date.now() + 5_000))).map(
        (row) => row.id,
      ),
    ).toContain(callId);
    expect(await calls.markFinishDelivery(callId, 'result')).toBe(true);
    const latePriceLedger = {
      ...ledger,
      knownSubtotalUsd: 0.014,
      components: {
        ...ledger.components,
        carrier: {
          status: 'provider_reported' as const,
          basis: 'Twilio price settled after callback',
          usd: 0.014,
        },
      },
    };
    expect(await calls.updateFinishCostLedger(callId, latePriceLedger, null)).toBe(true);
    const afterLatePrice = await calls.get(callId);
    expect(afterLatePrice?.finishDelivery).toMatchObject({
      resultDelivered: true,
      result: { costUsd: null, costBreakdown: { components: { carrier: { usd: 0.014 } } } },
      costs: { done: false, ledger: { components: { carrier: { usd: 0.014 } } } },
    });
    expect(await calls.markFinishDelivery(callId, 'costs')).toBe(true);
    const afterCosts = await calls.get(callId);
    expect(afterCosts?.finishDelivery).toMatchObject({
      costs: { done: true },
      resultDelivered: true,
    });
    expect((await calls.listPendingFinishDelivery(agentId, 10)).map((row) => row.id)).not.toContain(
      callId,
    );
    expect(await calls.finish(callId, { status: 'completed' })).toBeNull();
  });

  it('durably orders out-of-order transcript batches and deduplicates a retry', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const callId = randomUUID();
    const call = await calls.create({
      id: callId,
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: 'openai:realtime',
      voiceRoute: null,
      maxMinutes: 5,
      streamTokenHash: null,
      callbackToken: 'callback-token',
      reservationId: null,
    });
    const late = {
      id: 'batch-late',
      sequence: 2,
      lines: [{ role: 'caller' as const, text: 'second', at: '2' }],
    };
    expect(await calls.appendTranscriptBatch(call.id, late)).toEqual({
      accepted: true,
      duplicate: false,
      nextSequence: 1,
    });
    const first = {
      id: 'batch-first',
      sequence: 1,
      lines: [{ role: 'caller' as const, text: 'first', at: '1' }],
    };
    expect(await calls.appendTranscriptBatch(call.id, first)).toEqual({
      accepted: true,
      duplicate: false,
      nextSequence: 3,
    });
    expect(await calls.appendTranscriptBatch(call.id, first)).toEqual({
      accepted: true,
      duplicate: true,
      nextSequence: 3,
    });
    expect(await calls.appendTranscriptBatch(call.id, { ...first, id: 'conflict' })).toMatchObject({
      accepted: false,
      reason: 'conflict',
    });
    expect((await calls.get(call.id))?.transcript).toMatchObject([
      { text: 'first', sequence: 1 },
      { text: 'second', sequence: 2 },
    ]);
  });

  it('rejects a prior offer revision after a newer check-in replaces it', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const call = await calls.create({
      id: randomUUID(),
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: 'openai:realtime',
      voiceRoute: null,
      maxMinutes: 5,
      streamTokenHash: null,
      callbackToken: 'callback-token',
      reservationId: null,
    });
    const ask = (id: string) =>
      calls.addCheckin(call.id, {
        id,
        question: id,
        askedAt: new Date().toISOString(),
        answer: null,
        answeredAt: null,
        via: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const first = requiredRevision(await ask('first'));
    expect(await calls.markCheckinDelivery(call.id, first.id, first.revision, true)).toBe(true);
    const second = requiredRevision(await ask('second'));
    expect(second.revision).toBe(first.revision + 1);
    expect(
      await calls.answerCheckin(agentId, call.id, first.id, first.revision, 'stale', 'web'),
    ).toBe(false);
    expect(await calls.markCheckinDelivery(call.id, second.id, second.revision, true)).toBe(true);
    expect(
      await calls.answerCheckin(agentId, call.id, second.id, second.revision, 'current', 'web'),
    ).toBe(true);
  });

  it('requires a delivered current check-in revision and refuses superseded or expired answers', async () => {
    const calls = createPostgresCallSessionRepository(db);
    const call = await calls.create({
      id: randomUUID(),
      agentId,
      taskId,
      toolCallId,
      status: 'in_progress',
      to: '+14155550123',
      contactName: null,
      brief: {},
      voiceModel: 'openai:realtime',
      voiceRoute: null,
      maxMinutes: 5,
      streamTokenHash: null,
      callbackToken: 'callback-token',
      reservationId: null,
    });
    const ask = (id: string, expiresAt: string) =>
      calls.addCheckin(call.id, {
        id,
        question: id,
        askedAt: new Date().toISOString(),
        answer: null,
        answeredAt: null,
        via: null,
        expiresAt,
      });
    const old = requiredRevision(await ask('old', new Date(Date.now() + 60_000).toISOString()));
    expect(await calls.markCheckinDelivery(call.id, old.id, old.revision, true)).toBe(true);
    const current = requiredRevision(
      await ask('current', new Date(Date.now() - 1_000).toISOString()),
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
