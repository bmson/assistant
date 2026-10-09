import { createHash } from 'node:crypto';
import type {
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSessionEvents,
  ResolvedVoiceModel,
} from '@assistant/core/realtime-voice';
import {
  ACTIVE_CALL_STATUSES,
  acceptCallTranscriptBatch,
  type CallCheckin,
  type CallSession,
  type CallSessionRepository,
  type CallTranscriptLine,
  type CallVoiceRouteSnapshot,
  notificationLeg,
} from '@assistant/persistence';
import type { VoiceDialer } from '@assistant/tools/calls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  reserveCost: vi.fn(),
  releaseReservation: vi.fn(async (_costs: unknown, _id: string) => {}),
  reconcileReservation: vi.fn(async (_costs: unknown, _id: string, _input: unknown) => {}),
  recordCostEvent: vi.fn(async (_costs: unknown, _input: unknown) => {}),
  recordCallResult: vi.fn(async (_jobs: unknown, _input: unknown) => ({
    ok: true,
    taskId: 't',
    queueGeneration: 1,
  })),
  getRate: vi.fn(async () => ({ unitPriceUsd: 0.014, unit: 'minute' })),
}));
vi.mock('@assistant/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core')>()),
  ...core,
}));

const { handleMediaStream } = await import('./bridge.js');
const { deliverCallFinish } = await import('./finish.js');
type MediaSocket = import('./bridge.js').MediaSocket;
const { startCall, mediaStreamUrl } = await import('./dial.js');
const { handleCallStatus } = await import('./status.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function requiredRevision(
  value: CallCheckin | undefined | null,
): CallCheckin & { revision: number } {
  if (!value || typeof value.revision !== 'number')
    throw new Error('Test check-in revision missing');
  return value as CallCheckin & { revision: number };
}

function memoryCalls(): CallSessionRepository & { rows: Map<string, CallSession> } {
  const rows = new Map<string, CallSession>();
  const patch = (id: string, change: Partial<CallSession>) => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...change, updatedAt: new Date() });
  };
  const active = (row: CallSession) =>
    (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status);
  return {
    kind: 'call-session-repository',
    rows,
    async create(input) {
      const row: CallSession = {
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
        twilioCallSid: null,
        answeredBy: null,
        startedAt: null,
        endedAt: null,
        durationSeconds: null,
        transcript: [],
        transcriptState: { nextSequence: 1, pending: [], acknowledged: [] },
        notes: [],
        checkins: [],
        hangupRequested: false,
        outcome: null,
        summary: null,
        costUsd: null,
        error: null,
        finishDelivery: null,
        lineRate: input.lineRate ?? null,
        capacityReleasedAt: null,
      };
      rows.set(row.id, row);
      return row;
    },
    async admit(input, options) {
      const existing = rows.get(input.id);
      if (existing) return { kind: 'existing', call: existing };
      if ([...rows.values()].some((row) => row.agentId === input.agentId && active(row)))
        return { kind: 'active_limit' };
      const since = new Date(options.now.getTime() - 24 * 60 * 60_000);
      if (
        [...rows.values()].filter(
          (row) =>
            row.agentId === input.agentId && row.createdAt >= since && !row.capacityReleasedAt,
        ).length >= options.dailyLimit
      )
        return { kind: 'daily_limit' };
      const call = await this.create(input);
      call.createdAt = options.now;
      return { kind: 'admitted', call };
    },
    async releaseAdmission(id, now) {
      const row = rows.get(id);
      if (row?.status !== 'failed' || row.twilioCallSid || !row.endedAt || row.capacityReleasedAt)
        return false;
      patch(id, { capacityReleasedAt: now });
      return true;
    },
    get: async (id) => rows.get(id) ?? null,
    getByCallSid: async (sid) =>
      [...rows.values()].find((row) => row.twilioCallSid === sid) ?? null,
    list: async () => [...rows.values()],
    countSince: async (_agent, since) =>
      [...rows.values()].filter((r) => r.createdAt >= since).length,
    activeCount: async () => [...rows.values()].filter(active).length,
    update: async (id, change) => patch(id, change),
    async claimStream(id, tokenHash, now) {
      const row = rows.get(id);
      if (!row?.streamTokenHash || row.streamTokenHash !== tokenHash || !active(row)) return null;
      patch(id, { streamTokenHash: null, status: 'in_progress', startedAt: now });
      return rows.get(id) ?? null;
    },
    async finish(id, change) {
      const row = rows.get(id);
      if (!row || !active(row)) return null;
      patch(id, change);
      return rows.get(id) ?? null;
    },
    async listPendingFinishDelivery(agentId, _limit, now = new Date()) {
      return [...rows.values()].filter((row) => {
        const delivery = row.finishDelivery as {
          costs: { done: boolean };
          resultDelivered: boolean;
          nextAttemptAt: Date;
        } | null;
        return (
          row.agentId === agentId &&
          delivery !== null &&
          (!delivery.costs.done || !delivery.resultDelivered) &&
          delivery.nextAttemptAt <= now
        );
      });
    },
    async deferFinishDelivery(id) {
      const row = rows.get(id);
      const delivery = row?.finishDelivery as {
        attempts: number;
        nextAttemptAt: Date;
        costs: { done: boolean };
        resultDelivered: boolean;
      } | null;
      if (!row || !delivery || (delivery.costs.done && delivery.resultDelivered)) return false;
      const attempts = delivery.attempts + 1;
      const delayMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));
      patch(id, {
        finishDelivery: { ...delivery, attempts, nextAttemptAt: new Date(Date.now() + delayMs) },
      });
      return true;
    },
    async markFinishDelivery(id, leg) {
      const row = rows.get(id);
      const delivery = row?.finishDelivery as {
        costs: { done: boolean };
        resultDelivered: boolean;
      } | null;
      if (!row || !delivery) return false;
      patch(id, {
        finishDelivery:
          leg === 'costs'
            ? { ...delivery, costs: { ...delivery.costs, done: true } }
            : { ...delivery, resultDelivered: true },
      });
      return true;
    },
    async updateFinishCostLedger(id, ledger, resultCostUsd) {
      const row = rows.get(id);
      const delivery = row?.finishDelivery as {
        costs: { done: boolean; ledger?: unknown };
        result: Record<string, unknown>;
      } | null;
      if (!row || !delivery || delivery.costs.done) return false;
      patch(id, {
        costUsd: resultCostUsd === null ? null : resultCostUsd.toFixed(6),
        finishDelivery: {
          ...delivery,
          costs: { ...delivery.costs, ledger },
          result: { ...delivery.result, costUsd: resultCostUsd, costBreakdown: ledger },
        },
      });
      return true;
    },
    appendTranscript: async (id, lines) =>
      patch(id, {
        transcript: [...((rows.get(id)?.transcript as CallTranscriptLine[]) ?? []), ...lines],
      }),
    async appendTranscriptBatch(id, batch) {
      const row = rows.get(id);
      if (!row) return { accepted: false, reason: 'invalid', nextSequence: 1 };
      const result = acceptCallTranscriptBatch(
        (row.transcript as CallTranscriptLine[]) ?? [],
        row.transcriptState,
        batch,
      );
      if (result.result.accepted && !result.result.duplicate)
        patch(id, { transcript: result.transcript, transcriptState: result.state });
      return result.result;
    },
    appendNote: async (id, note) =>
      patch(id, { notes: [...((rows.get(id)?.notes as string[]) ?? []), note] }),
    async addCheckin(id, checkin) {
      const row = rows.get(id);
      if (!row || !active(row)) return null;
      const checkins = (rows.get(id)?.checkins as CallCheckin[]) ?? [];
      const revision =
        checkins.reduce((max, current) => Math.max(max, current.revision ?? 0), 0) + 1;
      const created = { ...checkin, revision, deliveryStatus: 'pending' as const };
      patch(id, {
        checkins: [
          ...checkins.map((c) =>
            c.answer === null && ['pending', 'delivered'].includes(c.deliveryStatus ?? 'pending')
              ? { ...c, deliveryStatus: 'superseded' as const }
              : c,
          ),
          created,
        ],
      });
      return created;
    },
    async markCheckinDelivery(id, checkinId, revision, delivered) {
      const checkins = (rows.get(id)?.checkins as CallCheckin[]) ?? [];
      const target = checkins.find((c) => c.id === checkinId && c.revision === revision);
      if (target?.deliveryStatus !== 'pending') return false;
      const ok = delivered && Date.parse(target.expiresAt ?? '') > Date.now();
      patch(id, {
        checkins: checkins.map((c) =>
          c.id === checkinId ? { ...c, deliveryStatus: ok ? 'delivered' : 'failed' } : c,
        ),
      });
      return ok;
    },
    async answerCheckin(_agent, id, checkinId, revision, answer, via) {
      const checkins = (rows.get(id)?.checkins as CallCheckin[]) ?? [];
      const target = checkins.find((c) => c.id === checkinId);
      const latest = [...checkins]
        .reverse()
        .find((c) => c.answer === null && c.deliveryStatus === 'delivered');
      if (
        !target ||
        target.revision !== revision ||
        target.deliveryStatus !== 'delivered' ||
        target.answer !== null ||
        latest?.id !== target.id ||
        Date.parse(target.expiresAt ?? '') <= Date.now()
      )
        return false;
      patch(id, {
        checkins: checkins.map((c) =>
          c.id === checkinId
            ? {
                ...c,
                answer,
                via,
                answeredAt: new Date().toISOString(),
                deliveryStatus: 'answered',
              }
            : c,
        ),
      });
      return true;
    },
    async requestHangup(_agent, id) {
      const row = rows.get(id);
      if (!row || !active(row)) return false;
      patch(id, { hangupRequested: true });
      return true;
    },
  };
}

function fakeDialer(): VoiceDialer & {
  placeCall: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
} {
  return {
    configured: () => true,
    placeCall: vi.fn(async () => ({ sid: `CA${'a'.repeat(32)}` })),
    hangup: vi.fn(async () => {}),
    getCall: vi.fn(async () => ({
      status: 'completed',
      durationSeconds: 95,
      priceUsd: null,
      answeredBy: null,
    })),
  };
}

const brief = {
  to: '+14155550123',
  contactName: 'Nopa',
  goal: 'Book a table for two at 7:30pm tonight.',
  context: 'Name: Baldvin Smarason.',
  mayAgreeTo: 'Any time between 7 and 8:30pm.',
  mustNot: 'Pay a deposit.',
  language: 'English',
  maxMinutes: 10,
  onVoicemail: 'hang_up' as const,
};

const rates = {
  audioInputPerMTok: 32,
  audioOutputPerMTok: 64,
  textInputPerMTok: 4,
  textOutputPerMTok: 24,
};

const voiceRoute: CallVoiceRouteSnapshot = {
  version: 1,
  modelId: 'openai:gpt-realtime-2.1',
  connectionId: 'openai',
  connectionKind: 'openai',
  connectionUpdatedAt: null,
  provider: 'openai',
  providerModel: 'gpt-realtime-2.1',
  endpoint: { kind: 'openai-realtime', url: 'wss://api.openai.com/v1/realtime' },
  voice: null,
  rates,
};

beforeEach(() => {
  vi.clearAllMocks();
  core.reserveCost.mockResolvedValue({ ok: true, reservationId: 'res-1' });
});

function dialDeps(calls: CallSessionRepository, dialer: VoiceDialer) {
  return {
    config: {
      PUBLIC_URL: 'https://agent.example.run.app',
      OWNER_NAME: 'Baldvin',
      CALL_DAILY_LIMIT: 3,
      CALL_MAX_MINUTES: 8,
    },
    calls,
    costs: {} as never,
    dialer,
    ownerId: async () => 'agent-1',
    voiceModel: async () => ({
      id: 'openai:gpt-realtime-2.1',
      route: voiceRoute,
      resolved: {
        provider: {} as never,
        model: 'gpt-realtime-2.1',
        rates,
      } satisfies ResolvedVoiceModel,
    }),
  };
}

function toolInput(callId = '11111111-1111-4111-8111-111111111111') {
  return {
    callId,
    brief,
    callbackToken: 'wake-token',
    ctx: {
      taskId: '22222222-2222-4222-8222-222222222222',
      now: () => new Date(),
      execution: {
        dbToolCallId: '33333333-3333-4333-8333-333333333333',
        modelToolCallId: 'm',
        toolName: 'phone.call',
      },
    } as never,
  };
}

describe('placing a call', () => {
  it('holds the worst-case cost, records the session, and dials with the fixed disclosure', async () => {
    const calls = memoryCalls();
    const dialer = fakeDialer();
    const result = await startCall(dialDeps(calls, dialer), toolInput());
    expect(result).toEqual({ callSid: `CA${'a'.repeat(32)}` });

    // 8 minutes (the installation cap beats the brief's 10) of line + model.
    const reservation = core.reserveCost.mock.calls[0]?.[1] as { estimatedUsd: number } | undefined;
    expect(reservation?.estimatedUsd).toBeCloseTo(8 * (0.014 + (6000 * 32 + 1500 * 64) / 1e6));

    const session = calls.rows.get('11111111-1111-4111-8111-111111111111');
    expect(session).toMatchObject({
      status: 'dialing',
      maxMinutes: 8,
      callbackToken: 'wake-token',
      reservationId: 'res-1',
      voiceRoute,
      twilioCallSid: `CA${'a'.repeat(32)}`,
    });
    const placed = dialer.placeCall.mock.calls[0]?.[0] as {
      twiml: string;
      timeLimitSeconds: number;
    };
    expect(placed.twiml).toContain('an AI assistant calling on behalf of Baldvin');
    expect(placed.twiml).toContain('url="wss://agent.example.run.app/voice/stream"');
    const token = /name="token" value="([0-9a-f]+)"/.exec(placed.twiml)?.[1] ?? '';
    expect(sha(token)).toBe(session?.streamTokenHash);
    expect(placed.timeLimitSeconds).toBe(8 * 60 + 20);
  });

  it('refuses a second concurrent call and enforces the daily cap', async () => {
    const calls = memoryCalls();
    const dialer = fakeDialer();
    await startCall(dialDeps(calls, dialer), toolInput());
    await expect(
      startCall(dialDeps(calls, dialer), toolInput('44444444-4444-4444-8444-444444444444')),
    ).rejects.toThrow('still in progress');
    for (const row of calls.rows.values()) row.status = 'completed';
    await startCall(dialDeps(calls, dialer), toolInput('55555555-5555-4555-8555-555555555555'));
    for (const row of calls.rows.values()) row.status = 'completed';
    await startCall(dialDeps(calls, dialer), toolInput('66666666-6666-4666-8666-666666666666'));
    for (const row of calls.rows.values()) row.status = 'completed';
    await expect(
      startCall(dialDeps(calls, dialer), toolInput('77777777-7777-4777-8777-777777777777')),
    ).rejects.toThrow('daily limit');
  });

  it('releases the hold and marks the call failed when Twilio refuses it', async () => {
    const calls = memoryCalls();
    const dialer = fakeDialer();
    dialer.placeCall.mockRejectedValueOnce(new Error('twilio call failed: 21215 geo permission'));
    await expect(startCall(dialDeps(calls, dialer), toolInput())).rejects.toThrow('21215');
    expect(core.releaseReservation).toHaveBeenCalledWith({}, 'res-1');
    expect(calls.rows.get('11111111-1111-4111-8111-111111111111')?.status).toBe('failed');
  });

  it('builds the media stream URL from the public URL', () => {
    expect(mediaStreamUrl('https://a.run.app')).toBe('wss://a.run.app/voice/stream');
    expect(mediaStreamUrl('http://localhost:8787')).toBe('ws://localhost:8787/voice/stream');
  });
});

describe('call status webhook', () => {
  it('finishes an unanswered call and wakes the task, once', async () => {
    const calls = memoryCalls();
    await startCall(dialDeps(calls, fakeDialer()), toolInput());
    const deps = {
      calls,
      costs: {} as never,
      jobs: {} as never,
      notifyOwner: vi.fn(async () => {}),
    };
    const sid = `CA${'a'.repeat(32)}`;
    await handleCallStatus(deps, { CallSid: sid, CallStatus: 'ringing' });
    expect(calls.rows.get('11111111-1111-4111-8111-111111111111')?.status).toBe('ringing');
    await handleCallStatus(deps, { CallSid: sid, CallStatus: 'no-answer', CallDuration: '0' });
    await handleCallStatus(deps, { CallSid: sid, CallStatus: 'no-answer', CallDuration: '0' });
    expect(core.recordCallResult).toHaveBeenCalledTimes(1);
    expect(core.recordCallResult).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        token: 'wake-token',
        result: expect.objectContaining({ outcome: 'no_answer', summary: 'Nopa did not answer.' }),
      }),
    );
  });

  it('records the answering-machine verdict and ignores unknown calls', async () => {
    const calls = memoryCalls();
    await startCall(dialDeps(calls, fakeDialer()), toolInput());
    const deps = {
      calls,
      costs: {} as never,
      jobs: {} as never,
      notifyOwner: vi.fn(async () => {}),
    };
    await handleCallStatus(deps, { CallSid: `CA${'a'.repeat(32)}`, AnsweredBy: 'human' });
    expect(calls.rows.get('11111111-1111-4111-8111-111111111111')?.answeredBy).toBe('human');
    expect(
      (await handleCallStatus(deps, { CallSid: `CA${'b'.repeat(32)}`, CallStatus: 'completed' }))
        .status,
    ).toBe(200);
  });
});

type Listener = (...args: unknown[]) => void;

function fakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    closed: false,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? [])
        listener(payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)));
    },
  };
}

function fakeSession() {
  return {
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(),
    respond: vi.fn(),
    interrupt: vi.fn(),
    usage: () => ({
      inputAudioTokens: 1_000,
      inputTextTokens: 2_000,
      cachedInputTokens: 0,
      cachedAudioInputTokens: 0,
      cachedTextInputTokens: 0,
      cachedUnclassifiedInputTokens: 0,
      outputAudioTokens: 500,
      outputTextTokens: 100,
      reasoningOutputTokens: 0,
      reasoningUsageReported: false,
      transcriptionInputAudioTokens: 0,
      transcriptionOutputTextTokens: 0,
      transcriptionUsageReported: false,
      transcriptionInputAudioMilliseconds: 0,
    }),
    close: vi.fn(async () => {}),
  } satisfies RealtimeSession;
}

/** A voice model that opens a fresh session on every connect (reconnects). */
function fakeVoice(connectGate?: Promise<void>) {
  const sessions = [fakeSession()];
  const events: RealtimeSessionEvents[] = [];
  const configs: RealtimeSessionConfig[] = [];
  const resolved: ResolvedVoiceModel = {
    model: 'gpt-realtime-2.1',
    rates,
    provider: {
      kind: 'openai',
      connect: async (c, e) => {
        configs.push(c);
        events.push(e);
        if (connectGate) await connectGate;
        if (configs.length > sessions.length) sessions.push(fakeSession());
        return sessions[configs.length - 1] as RealtimeSession;
      },
    },
  };
  return {
    resolved,
    session: sessions[0] as ReturnType<typeof fakeSession>,
    sessions,
    configs,
    events: () => events.at(-1) as RealtimeSessionEvents,
    config: () => configs.at(-1),
  };
}

async function connectedBridge(
  options: { connectGate?: Promise<void>; openingWaitMs?: number; pollMs?: number } = {},
) {
  const calls = memoryCalls();
  const dialer = fakeDialer();
  const placed = await startCall(dialDeps(calls, dialer), toolInput());
  const twiml = (dialer.placeCall.mock.calls[0]?.[0] as { twiml: string } | undefined)?.twiml ?? '';
  const token = /name="token" value="([0-9a-f]+)"/.exec(twiml)?.[1] ?? '';
  const voice = fakeVoice(options.connectGate);
  const socket = fakeSocket();
  const notifyOwner = vi.fn(async (_input: { text: string; taskId?: string }) =>
    notificationLeg('dashboard', 'delivered'),
  );
  handleMediaStream(socket as unknown as MediaSocket, {
    calls,
    costs: {} as never,
    jobs: {} as never,
    dialer,
    resolveVoice: async () => voice.resolved,
    notifyOwner,
    callUrl: (id) => `https://bot.example/calls/${id}`,
    ownerName: 'Baldvin',
    assistantName: 'Aria',
    timezone: 'America/Los_Angeles',
    pollMs: options.pollMs ?? 20,
    checkinWaitMs: 2_000,
    openingWaitMs: options.openingWaitMs ?? 5_000,
  });
  return { calls, dialer, voice, socket, notifyOwner, token, placed };
}

const CALL_ID = '11111111-1111-4111-8111-111111111111';

describe('live call bridge', () => {
  it('replays a terminal call outbox after a metering outage without dialing again', async () => {
    const { calls, dialer, voice, socket, token } = await connectedBridge();
    vi.mocked(dialer.getCall).mockResolvedValue({
      status: 'completed',
      durationSeconds: 95,
      priceUsd: 0.028,
      answeredBy: 'human',
    });
    core.getRate.mockClear();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    let finishMeteringAttempt = () => {};
    const meteringAttempted = new Promise<void>((resolve) => {
      finishMeteringAttempt = resolve;
    });
    core.reconcileReservation.mockImplementationOnce(async () => {
      finishMeteringAttempt();
      throw new Error('metering temporarily unavailable');
    });
    voice.events().toolCall({
      id: 'end-once',
      name: 'end_call',
      args: { outcome: 'achieved', summary: 'Call completed.' },
    });
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
    socket.emit('message', { event: 'stop' });

    await vi.waitFor(() => expect(calls.rows.get(CALL_ID)?.status).toBe('completed'));
    await meteringAttempted;
    expect(core.recordCallResult).not.toHaveBeenCalled();
    const pending = calls.rows.get(CALL_ID);
    expect(pending?.finishDelivery).toMatchObject({
      resultDelivered: false,
      result: { summary: 'Call completed.', costUsd: null },
      costs: { done: false, ledger: { components: { carrier: { usd: 0.028 } } } },
    });

    await deliverCallFinish(
      { calls, costs: {} as never, jobs: {} as never },
      pending as CallSession,
    );
    await deliverCallFinish(
      { calls, costs: {} as never, jobs: {} as never },
      calls.rows.get(CALL_ID) as CallSession,
    );
    expect(core.reconcileReservation).toHaveBeenCalledTimes(2);
    expect(core.getRate).not.toHaveBeenCalled();
    expect(core.recordCostEvent).not.toHaveBeenCalled();
    expect(core.reconcileReservation.mock.calls[1]?.[2]).toMatchObject({
      evidence: { voiceCallLedger: { components: { carrier: { usd: 0.028 } } } },
    });
    expect(core.recordCallResult).toHaveBeenCalledTimes(1);
    expect(dialer.placeCall).toHaveBeenCalledTimes(1);
    expect(calls.rows.get(CALL_ID)?.finishDelivery).toMatchObject({
      costs: { done: true },
      resultDelivered: true,
    });
  });

  it('refuses a stream whose token does not redeem', async () => {
    const { socket } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token: 'forged' } },
    });
    await vi.waitFor(() => expect(socket.closed).toBe(true));
  });

  it('passes an opening screening prompt through after the voice model connects', async () => {
    let connect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const { voice, socket, token } = await connectedBridge({ connectGate });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([1, 2]).toString('base64') },
    });
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([3, 4]).toString('base64') },
    });
    expect(voice.session.sendAudio).not.toHaveBeenCalled();
    connect();
    await vi.waitFor(() => expect(voice.session.sendAudio).toHaveBeenCalledTimes(2));
    expect(voice.session.sendAudio).toHaveBeenNthCalledWith(1, Uint8Array.of(1, 2));
    expect(voice.session.sendAudio).toHaveBeenNthCalledWith(2, Uint8Array.of(3, 4));
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('bounds caller audio while the voice model connects', async () => {
    let connect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const { voice, socket, token } = await connectedBridge({ connectGate });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.alloc(100_000, 1).toString('base64') },
    });
    connect();
    await vi.waitFor(() => expect(voice.session.sendAudio).toHaveBeenCalledTimes(1));
    expect(voice.session.sendAudio.mock.calls[0]?.[0]).toHaveLength(80_000);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('finishes a call that disconnects before its session is claimed', async () => {
    const { calls, voice, socket, token } = await connectedBridge();
    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const originalClaim = calls.claimStream.bind(calls);
    vi.spyOn(calls, 'claimStream').mockImplementation(async (id, hash, at) => {
      await claimGate;
      return originalClaim(id, hash, at);
    });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    socket.emit('close');
    releaseClaim();
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    expect(calls.rows.get(CALL_ID)?.status).toBe('completed');
    expect(voice.config()).toBeUndefined();
  });

  it('closes a voice model that connects after the phone disconnects', async () => {
    let connect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const { voice, socket, token } = await connectedBridge({ connectGate });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([1, 2]).toString('base64') },
    });
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    connect();
    await vi.waitFor(() => expect(voice.session.close).toHaveBeenCalledTimes(1));
    expect(voice.session.sendAudio).not.toHaveBeenCalled();
    expect(voice.session.respond).not.toHaveBeenCalled();
  });

  it('introduces the call when the line stays quiet', async () => {
    const { voice, socket, token } = await connectedBridge({ openingWaitMs: 50 });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    await vi.waitFor(() =>
      expect(voice.session.respond).toHaveBeenCalledWith(
        expect.stringContaining('introduce yourself'),
      ),
    );
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('keeps failed transcript batches buffered and retries the same sequence safely', async () => {
    const { calls, voice, socket, token } = await connectedBridge({ pollMs: 10 });
    const append = calls.appendTranscriptBatch.bind(calls);
    const write = vi
      .spyOn(calls, 'appendTranscriptBatch')
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockImplementation(append);
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    voice.events().transcript('caller', 'Please keep the full transcript.');
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[0]?.[1]).toEqual(write.mock.calls[1]?.[1]);
    expect(calls.rows.get(CALL_ID)?.transcript).toMatchObject([
      { text: 'Please keep the full transcript.', sequence: 1 },
    ]);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    expect(calls.rows.get(CALL_ID)?.transcript).toHaveLength(1);
  });

  it('writes an explicit gap receipt at shutdown when the transcript payload cannot be saved', async () => {
    const { calls, voice, socket, token } = await connectedBridge({ pollMs: 1_000 });
    const append = calls.appendTranscriptBatch.bind(calls);
    let attempts = 0;
    vi.spyOn(calls, 'appendTranscriptBatch').mockImplementation(async (id, batch) => {
      attempts += 1;
      if (attempts <= 3) throw new Error('transient transcript outage');
      return append(id, batch);
    });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    voice.events().transcript('caller', 'Payload that cannot be saved.');
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    expect(calls.rows.get(CALL_ID)?.transcript).toMatchObject([
      { role: 'system', text: expect.stringContaining('Transcript gap: 1 line(s)') },
    ]);
    expect(calls.rows.get(CALL_ID)?.transcript).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Payload that cannot be saved.' })]),
    );
  });

  it('does not interrupt a caller with the quiet-line introduction', async () => {
    const { voice, socket, token } = await connectedBridge({ openingWaitMs: 50 });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    voice.events().transcript('caller', 'Hello?');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(voice.session.respond).not.toHaveBeenCalled();
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('runs a call: brief-only instructions, screened audio, barge-in, check-in and wake', async () => {
    const { calls, dialer, voice, socket, notifyOwner, token } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    expect(calls.rows.get(CALL_ID)?.status).toBe('in_progress');
    const instructions = voice.config()?.instructions ?? '';
    expect(instructions).toContain('GOAL: Book a table for two at 7:30pm tonight.');
    expect(instructions).toContain('NEVER: Pay a deposit.');
    expect(instructions).toContain('Never claim or imply that you are human');
    expect(voice.config()?.tools.map((tool) => tool.name)).toEqual([
      'ask_owner',
      'press_keys',
      'note',
      'end_call',
    ]);

    // Caller audio reaches the model before answering-machine detection finishes.
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([1, 2]).toString('base64') },
    });
    expect(voice.session.sendAudio).toHaveBeenCalledWith(Uint8Array.of(1, 2));
    const get = vi.spyOn(calls, 'get');
    get.mockClear();
    await calls.update(CALL_ID, { answeredBy: 'machine_end_beep' });
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(CALL_ID));
    expect(dialer.hangup).not.toHaveBeenCalled();

    // One 20 ms frame waits for a playback mark before the next is sent.
    voice.events().audio(new Uint8Array(320));
    expect(socket.sent.filter((m) => m.event === 'media')).toHaveLength(1);
    expect(socket.sent.filter((m) => m.event === 'mark')).toHaveLength(1);
    voice.events().speechStarted();
    expect(socket.sent.at(-1)).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(voice.session.interrupt).toHaveBeenCalled();

    voice.events().transcript('caller', 'We have 7:45, is that OK?');
    voice.events().toolCall({ id: 'c1', name: 'note', args: { fact: 'Offered 7:45pm' } });
    voice.events().toolCall({ id: 'c2', name: 'ask_owner', args: { question: 'Is 7:45 OK?' } });
    await vi.waitFor(() => expect(notifyOwner).toHaveBeenCalled());
    expect(notifyOwner.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining(`https://bot.example/calls/${CALL_ID}`),
    });
    const checkin = requiredRevision(
      ((calls.rows.get(CALL_ID)?.checkins ?? []) as CallCheckin[])[0],
    );
    expect(checkin.deliveryStatus).toBe('delivered');
    expect(
      await calls.answerCheckin('agent-1', CALL_ID, checkin.id, checkin.revision, 'Yes', 'web'),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(voice.session.sendToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c2' }),
        { answer: 'Yes' },
        'respond',
      ),
    );

    voice.events().toolCall({
      id: 'c3',
      name: 'end_call',
      args: { outcome: 'achieved', summary: 'Booked for 7:45pm under Smarason.' },
    });
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalledWith(`CA${'a'.repeat(32)}`), {
      timeout: 3_000,
    });

    socket.emit('message', { event: 'stop' });
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    const woke = core.recordCallResult.mock.calls[0]?.[1] as unknown as {
      result: {
        outcome: string;
        summary: string;
        notes: string[];
        durationSeconds: number;
        transcript: unknown[];
      };
    };
    expect(woke.result).toMatchObject({
      outcome: 'achieved',
      summary: 'Booked for 7:45pm under Smarason.',
      notes: ['Offered 7:45pm'],
      durationSeconds: 95,
    });
    expect(woke.result.transcript).toContainEqual({
      role: 'them',
      text: 'We have 7:45, is that OK?',
    });
    expect(core.recordCostEvent).not.toHaveBeenCalled();
    const finished = calls.rows.get(CALL_ID)?.finishDelivery as {
      costs: {
        ledger: {
          components: {
            modelAudioInput: { quantity?: number };
            modelTextInput: { quantity?: number };
          };
        };
      };
    };
    expect(finished.costs.ledger.components.modelAudioInput.quantity).toBe(1_000);
    expect(finished.costs.ledger.components.modelTextInput.quantity).toBe(2_000);
    expect(calls.rows.get(CALL_ID)?.status).toBe('completed');
    expect(voice.session.close).toHaveBeenCalled();
  });

  it('lets the model distinguish voicemail from screening before hanging up', async () => {
    const { calls, dialer, voice, socket, token } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    const get = vi.spyOn(calls, 'get');
    get.mockClear();
    await calls.update(CALL_ID, { answeredBy: 'machine_end_beep' });
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(CALL_ID));
    expect(dialer.hangup).not.toHaveBeenCalled();
    voice.events().toolCall({
      id: 'voicemail',
      name: 'end_call',
      args: { outcome: 'voicemail', summary: 'Reached voicemail; no message was left.' },
    });
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled(), { timeout: 3_000 });
    expect(core.recordCallResult.mock.calls[0]?.[1]).toMatchObject({
      result: { outcome: 'voicemail' },
    });
  });

  it('ends the call when the owner hangs up from the app', async () => {
    const { calls, dialer, voice, socket, token } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    expect(await calls.requestHangup('agent-1', CALL_ID)).toBe(true);
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
  });

  async function startedBridge() {
    const bridge = await connectedBridge();
    bridge.socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token: bridge.token } },
    });
    await vi.waitFor(() => expect(bridge.voice.config()).toBeDefined());
    return bridge;
  }

  it('reports speech still playing when the caller cuts in after its transcript', async () => {
    const { voice, socket } = await startedBridge();
    // Two seconds of speech; its transcript lands long before it finishes
    // playing. The caller interrupting now has not heard most of it.
    voice.events().audio(new Uint8Array(16_000));
    voice.events().transcript('assistant', 'We would like a table for two at half past seven.');
    voice.events().speechStarted();
    expect(socket.sent.at(-1)).toEqual({ event: 'clear', streamSid: 'MZ1' });
    const unplayed = voice.session.interrupt.mock.calls[0]?.[0] as number;
    expect(unplayed).toBeGreaterThan(1_500);
    expect(unplayed).toBe(2_000);

    const clearedMark = socket.sent.findLast((message) => message.event === 'mark')?.mark as
      | { name?: string }
      | undefined;
    expect(clearedMark?.name).toBeDefined();
    socket.emit('message', {
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: clearedMark?.name },
    });

    // Nothing playing: a new caller turn interrupts nothing.
    voice.session.interrupt.mockClear();
    const sentBefore = socket.sent.length;
    voice.events().speechStarted();
    expect(voice.session.interrupt).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(sentBefore);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('treats a playback mark as transport completion, not comprehension', async () => {
    const { voice, socket } = await startedBridge();
    voice.events().audio(new Uint8Array(160));
    const mark = socket.sent.findLast((message) => message.event === 'mark')?.mark as
      | { name?: string }
      | undefined;
    expect(mark?.name).toBeDefined();
    socket.emit('message', { event: 'mark', streamSid: 'MZ1', mark: { name: mark?.name } });
    voice.events().speechStarted();
    expect(voice.session.interrupt).not.toHaveBeenCalled();
    expect(socket.sent.some((message) => message.event === 'clear')).toBe(false);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('clears only the frame still outstanding after earlier playback marks', async () => {
    const { voice, socket } = await startedBridge();
    voice.events().audio(new Uint8Array(320));
    const firstMark = socket.sent.findLast((message) => message.event === 'mark')?.mark as
      | { name?: string }
      | undefined;
    socket.emit('message', {
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: firstMark?.name },
    });
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(2);
    const secondMark = socket.sent.findLast((message) => message.event === 'mark')?.mark as
      | { name?: string }
      | undefined;
    voice.events().speechStarted();
    expect(voice.session.interrupt).toHaveBeenCalledWith(20);
    socket.emit('message', {
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: secondMark?.name },
    });
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(2);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('bounds generated audio waiting for Twilio and ends on overflow', async () => {
    const { dialer, voice, socket } = await startedBridge();
    voice.events().audio(new Uint8Array(80_008));
    expect(voice.session.interrupt).toHaveBeenCalledWith(10_001);
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(0);
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
    voice.events().audio(new Uint8Array(160));
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(0);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('asks the model to speak after a tool only when the caller needs a reply', async () => {
    const { voice, socket } = await startedBridge();
    voice.events().toolCall({ id: 'n1', name: 'note', args: { fact: 'Open until 10pm' } });
    voice.events().toolCall({ id: 'k1', name: 'press_keys', args: { digits: '2' } });
    voice.events().toolCall({ id: 'k2', name: 'press_keys', args: { digits: 'nope' } });
    await vi.waitFor(() => expect(voice.session.sendToolResult).toHaveBeenCalledTimes(3));
    const followUps = Object.fromEntries(
      voice.session.sendToolResult.mock.calls.map(([call, , followUp]) => [call.id, followUp]),
    );
    expect(followUps).toEqual({ n1: 'if_silent', k1: 'none', k2: 'respond' });
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('lets the goodbye finish playing before hanging up', async () => {
    const { dialer, voice, socket } = await startedBridge();
    voice.events().audio(new Uint8Array(12_000)); // 1.5 s of goodbye
    voice.events().transcript('assistant', 'Thanks so much, goodbye!');
    voice.events().toolCall({
      id: 'bye',
      name: 'end_call',
      args: { outcome: 'achieved', summary: 'Booked.' },
    });
    await vi.waitFor(() =>
      expect(voice.session.sendToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bye' }),
        { ok: true },
        'none',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(dialer.hangup).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled(), { timeout: 3_000 });
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled(), { timeout: 8_000 });
  });

  it('reconnects a dropped voice model with the conversation so far', async () => {
    const { calls, dialer, voice, socket } = await startedBridge();
    const oldEvents = voice.events();
    oldEvents.audio(new Uint8Array(160));
    const oldMark = socket.sent.findLast((message) => message.event === 'mark')?.mark as
      | { name?: string }
      | undefined;
    oldEvents.transcript('assistant', 'Hi, I would like to book a table for two tonight.');
    oldEvents.transcript('caller', 'We have 7:45, is that OK?');
    oldEvents.closed();
    await vi.waitFor(() => expect(voice.configs).toHaveLength(2));
    oldEvents.audio(new Uint8Array(160)); // stale output from the replaced generation is ignored
    voice.events().audio(new Uint8Array(320));
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(1);
    socket.emit('message', { event: 'mark', streamSid: 'MZ1', mark: { name: oldMark?.name } });
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(2);
    const currentMark = socket.sent.findLast((message) => message.event === 'mark')?.mark as
      | { name?: string }
      | undefined;
    socket.emit('message', { event: 'mark', streamSid: 'MZ1', mark: { name: oldMark?.name } });
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(2);
    socket.emit('message', {
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: currentMark?.name },
    });
    expect(socket.sent.filter((message) => message.event === 'media')).toHaveLength(3);
    const resumed = voice.configs[1]?.instructions ?? '';
    expect(resumed).toContain('GOAL: Book a table for two at 7:30pm tonight.');
    expect(resumed).toContain('THE CALL IS ALREADY IN PROGRESS');
    expect(resumed).toContain('Them: We have 7:45, is that OK?');
    expect(resumed).toContain('You: Hi, I would like to book a table for two tonight.');
    await vi.waitFor(() => expect(voice.sessions).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([7, 7]).toString('base64') },
    });
    expect(voice.sessions[1]?.sendAudio).toHaveBeenCalledWith(Uint8Array.of(7, 7));
    expect(dialer.hangup).not.toHaveBeenCalled();

    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    // Both sessions' provider usage is retained in the component ledger.
    const finished = calls.rows.get(CALL_ID)?.finishDelivery as {
      costs: { ledger: { components: { modelAudioInput: { quantity?: number } } } };
    };
    expect(finished.costs.ledger.components.modelAudioInput.quantity).toBe(2_000);
  });

  it('ends the call when the voice model keeps dropping', async () => {
    const { dialer, voice, socket } = await startedBridge();
    for (let drop = 1; drop <= 3; drop++) {
      voice.events().closed();
      if (drop < 3) await vi.waitFor(() => expect(voice.sessions).toHaveLength(drop + 1));
    }
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled(), { timeout: 8_000 });
    expect(core.recordCallResult.mock.calls[0]?.[1]).toMatchObject({
      result: { outcome: 'failed', summary: expect.stringContaining('dropped 3 times') },
    });
  });
});
