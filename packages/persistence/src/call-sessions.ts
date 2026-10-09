import type { Records } from './records.js';

export interface CallVoiceRouteSnapshot {
  version: 1;
  modelId: string;
  connectionId: string;
  connectionKind: 'openai' | 'vertex';
  /** The provider row revision, not credential material. */
  connectionUpdatedAt: string | null;
  provider: 'openai' | 'vertex';
  providerModel: string;
  endpoint:
    | { kind: 'openai-realtime'; url: 'wss://api.openai.com/v1/realtime' }
    | { kind: 'vertex-live'; project: string; location: string };
  voice: string | null;
  rates: {
    audioInputPerMTok: number;
    audioOutputPerMTok: number;
    textInputPerMTok: number;
    textOutputPerMTok: number;
    cachedAudioInputPerMTok?: number;
    cachedTextInputPerMTok?: number;
    transcriptionUsdPerMinute?: number;
    transcriptionModel?: string;
    rateCheckedAt?: string;
  };
}

export interface CallLineRate {
  unit: string;
  unitPriceUsd: number;
}

export type CallCostComponentStatus =
  | 'provider_reported'
  | 'estimated'
  | 'pending'
  | 'unknown'
  | 'not_applicable'
  | 'included_elsewhere';

export interface CallCostComponent {
  status: CallCostComponentStatus;
  basis: string;
  usd: number | null;
  quantity?: number | null;
  unit?: string;
  unitPriceUsd?: number | null;
  provider?: string;
  model?: string;
  rateCheckedAt?: string;
}

/** Component-level view; a subtotal is never presented as a complete invoice. */
export interface CallCostLedger {
  version: 1;
  currency: 'USD';
  createdAt: string;
  complete: boolean;
  knownSubtotalUsd: number;
  components: {
    carrier: CallCostComponent;
    mediaStream: CallCostComponent;
    amd: CallCostComponent;
    modelAudioInput: CallCostComponent;
    modelAudioOutput: CallCostComponent;
    modelTextInput: CallCostComponent;
    modelTextOutput: CallCostComponent;
    modelCachedInput: CallCostComponent;
    modelReasoning: CallCostComponent;
    modelTranscription: CallCostComponent;
    backend: CallCostComponent;
    runtime: CallCostComponent;
  };
}

const COST_COMPONENT_NAMES = [
  'carrier',
  'mediaStream',
  'amd',
  'modelAudioInput',
  'modelAudioOutput',
  'modelTextInput',
  'modelTextOutput',
  'modelCachedInput',
  'modelReasoning',
  'modelTranscription',
  'backend',
  'runtime',
] as const satisfies readonly (keyof CallCostLedger['components'])[];

function isCallCostComponent(value: unknown): value is CallCostComponent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CallCostComponent>;
  return (
    [
      'provider_reported',
      'estimated',
      'pending',
      'unknown',
      'not_applicable',
      'included_elsewhere',
    ].includes(row.status ?? '') &&
    typeof row.basis === 'string' &&
    (row.usd === null ||
      (typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd >= 0)) &&
    (row.quantity === undefined ||
      row.quantity === null ||
      (typeof row.quantity === 'number' && Number.isFinite(row.quantity) && row.quantity >= 0)) &&
    (row.unitPriceUsd === undefined ||
      row.unitPriceUsd === null ||
      (typeof row.unitPriceUsd === 'number' &&
        Number.isFinite(row.unitPriceUsd) &&
        row.unitPriceUsd >= 0)) &&
    (row.unit === undefined || typeof row.unit === 'string') &&
    (row.provider === undefined || typeof row.provider === 'string') &&
    (row.model === undefined || typeof row.model === 'string') &&
    (row.rateCheckedAt === undefined || typeof row.rateCheckedAt === 'string')
  );
}

export function isCallCostLedger(value: unknown): value is CallCostLedger {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CallCostLedger>;
  const components = row.components;
  return (
    row.version === 1 &&
    row.currency === 'USD' &&
    typeof row.createdAt === 'string' &&
    Number.isFinite(Date.parse(row.createdAt)) &&
    typeof row.complete === 'boolean' &&
    typeof row.knownSubtotalUsd === 'number' &&
    Number.isFinite(row.knownSubtotalUsd) &&
    row.knownSubtotalUsd >= 0 &&
    !!components &&
    COST_COMPONENT_NAMES.every((name) => isCallCostComponent(components[name]))
  );
}

export function isCallLineRate(value: unknown): value is CallLineRate {
  if (!value || typeof value !== 'object') return false;
  const rate = value as Partial<CallLineRate>;
  return (
    typeof rate.unit === 'string' &&
    Number.isFinite(rate.unitPriceUsd) &&
    (rate.unitPriceUsd ?? -1) >= 0
  );
}

export type CallSession = Omit<
  Records['callSessions'],
  'voiceRoute' | 'lineRate' | 'capacityReleasedAt'
> & {
  /** Null for legacy sessions; those fail closed before connecting media. */
  voiceRoute: CallVoiceRouteSnapshot | null;
  /** Null for legacy sessions; new calls freeze the tariff before dialing. */
  lineRate: CallLineRate | null;
  /** Only a definite pre-dial/provider refusal releases its daily capacity. */
  capacityReleasedAt?: Date | null;
};

export interface CallAdmissionOptions {
  now: Date;
  dailyLimit: number;
}

export type CallAdmissionResult =
  | { kind: 'admitted'; call: CallSession }
  | { kind: 'existing'; call: CallSession }
  | { kind: 'active_limit' | 'daily_limit' };

export function assertCallAdmissionOptions(options: CallAdmissionOptions): void {
  if (
    !Number.isFinite(options.now.getTime()) ||
    !Number.isSafeInteger(options.dailyLimit) ||
    options.dailyLimit < 0 ||
    options.dailyLimit > 100
  )
    throw new Error('Invalid call capacity limits');
}

export function isCallVoiceRouteSnapshot(value: unknown): value is CallVoiceRouteSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CallVoiceRouteSnapshot>;
  const rates = row.rates;
  if (
    row.version !== 1 ||
    typeof row.modelId !== 'string' ||
    !row.modelId ||
    typeof row.connectionId !== 'string' ||
    !row.connectionId ||
    !['openai', 'vertex'].includes(row.connectionKind ?? '') ||
    !['openai', 'vertex'].includes(row.provider ?? '') ||
    typeof row.providerModel !== 'string' ||
    !row.providerModel ||
    !(row.connectionUpdatedAt === null || typeof row.connectionUpdatedAt === 'string') ||
    !(row.voice === null || typeof row.voice === 'string') ||
    !rates ||
    ![
      rates.audioInputPerMTok,
      rates.audioOutputPerMTok,
      rates.textInputPerMTok,
      rates.textOutputPerMTok,
    ].every((rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) ||
    ![
      rates.cachedAudioInputPerMTok,
      rates.cachedTextInputPerMTok,
      rates.transcriptionUsdPerMinute,
    ].every(
      (rate) =>
        rate === undefined || (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0),
    ) ||
    !(rates.transcriptionModel === undefined || typeof rates.transcriptionModel === 'string') ||
    !(rates.rateCheckedAt === undefined || typeof rates.rateCheckedAt === 'string')
  )
    return false;
  if (row.provider === 'openai')
    return (
      row.connectionKind === 'openai' &&
      row.connectionId === 'openai' &&
      row.endpoint?.kind === 'openai-realtime' &&
      row.endpoint.url === 'wss://api.openai.com/v1/realtime'
    );
  return (
    row.connectionKind === 'vertex' &&
    row.connectionId === 'vertex' &&
    row.endpoint?.kind === 'vertex-live' &&
    typeof row.endpoint.project === 'string' &&
    !!row.endpoint.project &&
    typeof row.endpoint.location === 'string' &&
    !!row.endpoint.location
  );
}

export interface CallTranscriptLine {
  role: 'caller' | 'assistant' | 'system';
  text: string;
  at: string;
  sequence?: number;
}

export interface CallTranscriptBatch {
  id: string;
  sequence: number;
  lines: readonly CallTranscriptLine[];
}

export interface CallTranscriptState {
  nextSequence: number;
  pending: CallTranscriptBatch[];
  acknowledged: Array<{ sequence: number; id: string }>;
}

export type CallTranscriptBatchResult =
  | { accepted: true; duplicate: boolean; nextSequence: number }
  | { accepted: false; reason: 'conflict' | 'too_far_ahead' | 'invalid'; nextSequence: number };

export const EMPTY_CALL_TRANSCRIPT_STATE: CallTranscriptState = {
  nextSequence: 1,
  pending: [],
  acknowledged: [],
};

/** Pure reducer shared by the PostgreSQL and Firestore transactional adapters. */
export function acceptCallTranscriptBatch(
  transcript: readonly CallTranscriptLine[],
  rawState: unknown,
  batch: CallTranscriptBatch,
): {
  transcript: CallTranscriptLine[];
  state: CallTranscriptState;
  result: CallTranscriptBatchResult;
} {
  const state = normalizeCallTranscriptState(rawState);
  const reject = (reason: 'conflict' | 'too_far_ahead' | 'invalid') => ({
    transcript: [...transcript],
    state,
    result: { accepted: false as const, reason, nextSequence: state.nextSequence },
  });
  if (
    !batch ||
    typeof batch.id !== 'string' ||
    !batch.id ||
    !Number.isSafeInteger(batch.sequence) ||
    batch.sequence < 1 ||
    !Array.isArray(batch.lines) ||
    batch.lines.length === 0 ||
    batch.lines.length > 200 ||
    batch.lines.some(
      (line) =>
        !line ||
        !['caller', 'assistant', 'system'].includes(line.role) ||
        typeof line.text !== 'string' ||
        typeof line.at !== 'string',
    )
  )
    return reject('invalid');

  const old = state.acknowledged.find((item) => item.sequence === batch.sequence);
  if (old)
    return old.id === batch.id
      ? {
          transcript: [...transcript],
          state,
          result: { accepted: true, duplicate: true, nextSequence: state.nextSequence },
        }
      : reject('conflict');
  const pending = state.pending.find((item) => item.sequence === batch.sequence);
  if (pending)
    return pending.id === batch.id
      ? {
          transcript: [...transcript],
          state,
          result: { accepted: true, duplicate: true, nextSequence: state.nextSequence },
        }
      : reject('conflict');
  if (batch.sequence < state.nextSequence) return reject('conflict');
  if (batch.sequence > state.nextSequence + 32) return reject('too_far_ahead');

  const nextState: CallTranscriptState = {
    ...state,
    pending: [...state.pending, { ...batch, lines: [...batch.lines] }].sort(
      (a, b) => a.sequence - b.sequence,
    ),
  };
  const nextTranscript = [...transcript];
  while (true) {
    const ready = nextState.pending.find((item) => item.sequence === nextState.nextSequence);
    if (!ready) break;
    nextState.pending = nextState.pending.filter((item) => item.sequence !== ready.sequence);
    nextTranscript.push(...ready.lines.map((line) => ({ ...line, sequence: ready.sequence })));
    nextState.acknowledged.push({ sequence: ready.sequence, id: ready.id });
    nextState.nextSequence += 1;
  }
  // Keep bounded duplicate receipts; sequences older than this window fail closed.
  nextState.acknowledged = nextState.acknowledged.slice(-256);
  return {
    transcript: nextTranscript,
    state: nextState,
    result: { accepted: true, duplicate: false, nextSequence: nextState.nextSequence },
  };
}

function normalizeCallTranscriptState(value: unknown): CallTranscriptState {
  if (!value || typeof value !== 'object')
    return { ...EMPTY_CALL_TRANSCRIPT_STATE, pending: [], acknowledged: [] };
  const row = value as Partial<CallTranscriptState>;
  const nextSequence = row.nextSequence;
  return {
    nextSequence:
      typeof nextSequence === 'number' && Number.isSafeInteger(nextSequence) && nextSequence >= 1
        ? nextSequence
        : 1,
    pending: Array.isArray(row.pending) ? row.pending : [],
    acknowledged: Array.isArray(row.acknowledged) ? row.acknowledged : [],
  };
}

/** Immutable payload committed with the terminal call transition. */
export interface CallFinishDelivery {
  version: 1;
  attempts: number;
  nextAttemptAt: Date | string;
  result: {
    callId: string;
    to: string;
    status: string;
    outcome: string;
    summary: string;
    notes: string[];
    durationSeconds: number | null;
    transcript: Array<{ role: string; text: string }>;
    costUsd: number | null;
    costBreakdown?: CallCostLedger;
  };
  costs: {
    done: boolean;
    ledger?: CallCostLedger;
    twilio: {
      reservationId: string | null;
      idempotencyKey: string;
      usd: number;
      minutes: number;
      unit: string;
      unitPriceUsd: number;
    };
    model: {
      idempotencyKey: string;
      usd: number;
      provider: string;
      model: string;
    };
  };
  resultDelivered: boolean;
}

export function isCallFinishDelivery(value: unknown): value is CallFinishDelivery {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CallFinishDelivery>;
  return (
    row.version === 1 &&
    typeof row.attempts === 'number' &&
    Number.isSafeInteger(row.attempts) &&
    row.attempts >= 0 &&
    ((row.nextAttemptAt instanceof Date && Number.isFinite(row.nextAttemptAt.getTime())) ||
      (typeof row.nextAttemptAt === 'string' && Number.isFinite(Date.parse(row.nextAttemptAt)))) &&
    typeof row.result === 'object' &&
    row.result !== null &&
    typeof row.costs === 'object' &&
    row.costs !== null &&
    typeof row.costs.done === 'boolean' &&
    typeof row.costs.twilio?.idempotencyKey === 'string' &&
    typeof row.costs.model?.idempotencyKey === 'string' &&
    (row.costs.ledger === undefined || isCallCostLedger(row.costs.ledger)) &&
    (row.result.costBreakdown === undefined || isCallCostLedger(row.result.costBreakdown)) &&
    typeof row.resultDelivered === 'boolean'
  );
}

export interface CallCheckin {
  id: string;
  question: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
  via: string | null;
  revision?: number;
  expiresAt?: string | null;
  deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'answered' | 'expired' | 'superseded';
}

/** Statuses in which a call still occupies the line. */
export const ACTIVE_CALL_STATUSES = ['dialing', 'ringing', 'in_progress'] as const;

export type CallSessionCreate = Omit<
  CallSession,
  | 'createdAt'
  | 'updatedAt'
  | 'twilioCallSid'
  | 'answeredBy'
  | 'startedAt'
  | 'endedAt'
  | 'durationSeconds'
  | 'transcript'
  | 'transcriptState'
  | 'notes'
  | 'checkins'
  | 'hangupRequested'
  | 'outcome'
  | 'summary'
  | 'costUsd'
  | 'error'
  | 'finishDelivery'
  | 'lineRate'
  | 'capacityReleasedAt'
> & { lineRate?: CallLineRate | null };

export type CallSessionPatch = Partial<
  Pick<
    CallSession,
    | 'status'
    | 'twilioCallSid'
    | 'reservationId'
    | 'answeredBy'
    | 'startedAt'
    | 'endedAt'
    | 'durationSeconds'
    | 'outcome'
    | 'summary'
    | 'costUsd'
    | 'error'
    | 'finishDelivery'
  >
>;

/**
 * Phone calls and their live state. The media bridge may run on a different
 * agent instance than the one that dialed, so everything the two sides share —
 * check-in answers, a hang-up request, the answering-machine verdict — travels
 * through this repository rather than process memory.
 */
export interface CallSessionRepository {
  readonly kind: 'call-session-repository';
  create(input: CallSessionCreate): Promise<CallSession>;
  /** Atomic owner-scoped admission; existing or ambiguous sessions never dial again. */
  admit(input: CallSessionCreate, options: CallAdmissionOptions): Promise<CallAdmissionResult>;
  /** Idempotent release after a definite refusal, never for an ambiguous/stale dial. */
  releaseAdmission(id: string, now: Date): Promise<boolean>;
  get(id: string): Promise<CallSession | null>;
  getByCallSid(callSid: string): Promise<CallSession | null>;
  list(agentId: string, limit: number): Promise<CallSession[]>;
  /** Calls created since `since` (the daily cap). */
  countSince(agentId: string, since: Date): Promise<number>;
  /** Calls still dialing, ringing, or connected. */
  activeCount(agentId: string): Promise<number>;
  update(id: string, patch: CallSessionPatch): Promise<void>;
  /**
   * Redeem the one-shot media-stream token: returns the session only for the
   * first connection presenting the matching hash, clears the hash so a
   * replayed stream start is refused, and marks the call connected
   * (`in_progress`, `startedAt`).
   */
  claimStream(id: string, tokenHash: string, now: Date): Promise<CallSession | null>;
  /**
   * End a call exactly once: applies the patch only while the call is still
   * active and returns the finished row, or null when another path (the media
   * bridge or the status webhook) already finished it.
   */
  finish(id: string, patch: CallSessionPatch): Promise<CallSession | null>;
  /** Terminal calls whose result or metering outbox still needs delivery. */
  listPendingFinishDelivery(agentId: string, limit: number, now?: Date): Promise<CallSession[]>;
  /** Move a repeatedly failing row behind other eligible deliveries. */
  deferFinishDelivery(id: string): Promise<boolean>;
  /** Acknowledges a durable outbox leg without overwriting the other leg. */
  markFinishDelivery(id: string, leg: 'costs' | 'result'): Promise<boolean>;
  /** Replace the pending component ledger before its immutable result is delivered. */
  updateFinishCostLedger(
    id: string,
    ledger: CallCostLedger,
    resultCostUsd: number | null,
  ): Promise<boolean>;
  appendTranscript(id: string, lines: readonly CallTranscriptLine[]): Promise<void>;
  appendTranscriptBatch(id: string, batch: CallTranscriptBatch): Promise<CallTranscriptBatchResult>;
  appendNote(id: string, note: string): Promise<void>;
  addCheckin(id: string, checkin: CallCheckin): Promise<CallCheckin | null>;
  markCheckinDelivery(
    id: string,
    checkinId: string,
    revision: number,
    delivered: boolean,
  ): Promise<boolean>;
  /** The owner answers a check-in; false if unknown, not theirs, or already answered. */
  answerCheckin(
    agentId: string,
    id: string,
    checkinId: string,
    revision: number,
    answer: string,
    via: string,
  ): Promise<boolean>;
  /** The owner asks to end a live call; false when no such active call. */
  requestHangup(agentId: string, id: string): Promise<boolean>;
}
