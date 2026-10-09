import type {
  CallCheckin,
  CallSession,
  CallSessionRepository,
  CallTranscriptLine,
} from '@assistant/persistence';
import { ACTIVE_CALL_STATUSES } from '@assistant/persistence';

/**
 * Owner-facing phone calls: the record of each call, and the two things the
 * owner can do while one is live — answer the assistant's check-in and hang up.
 * Views never carry the call's tokens.
 */

export interface CallBriefView {
  goal: string;
  context: string;
  mayAgreeTo: string;
  mustNot: string;
  language: string;
  onVoicemail: string;
}

export interface CallView {
  id: string;
  taskId: string;
  to: string;
  contactName: string | null;
  status: string;
  active: boolean;
  outcome: string | null;
  summary: string | null;
  brief: CallBriefView;
  voiceModel: string;
  maxMinutes: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  costUsd: string | null;
  error: string | null;
  transcript: CallTranscriptLine[];
  notes: string[];
  checkins: CallCheckin[];
  /** The check-in the assistant is waiting on right now, if any. */
  openCheckin:
    | (CallCheckin & { revision: number; expiresAt: string; deliveryStatus: 'delivered' })
    | null;
}

export interface CallsPorts {
  calls: CallSessionRepository;
  agentId: string;
}

function view(row: CallSession): CallView {
  const brief = (row.brief ?? {}) as Partial<CallBriefView>;
  const checkins = (row.checkins as CallCheckin[]) ?? [];
  const active = (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status);
  const openCheckin = active
    ? ([...checkins].reverse().find(
        (
          checkin,
        ): checkin is CallCheckin & {
          revision: number;
          expiresAt: string;
          deliveryStatus: 'delivered';
        } =>
          checkin.answer === null &&
          checkin.deliveryStatus === 'delivered' &&
          typeof checkin.revision === 'number' &&
          typeof checkin.expiresAt === 'string' &&
          Date.parse(checkin.expiresAt) > Date.now(),
      ) ?? null)
    : null;
  return {
    id: row.id,
    taskId: row.taskId,
    to: row.to,
    contactName: row.contactName,
    status: row.status,
    active,
    outcome: row.outcome,
    summary: row.summary,
    brief: {
      goal: brief.goal ?? '',
      context: brief.context ?? '',
      mayAgreeTo: brief.mayAgreeTo ?? '',
      mustNot: brief.mustNot ?? '',
      language: brief.language ?? 'English',
      onVoicemail: brief.onVoicemail ?? 'hang_up',
    },
    voiceModel: row.voiceModel,
    maxMinutes: row.maxMinutes,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    costUsd: row.costUsd,
    error: row.error,
    transcript: (row.transcript as CallTranscriptLine[]) ?? [],
    notes: (row.notes as string[]) ?? [],
    checkins,
    openCheckin,
  };
}

export async function listCalls(ports: CallsPorts, limit = 50): Promise<CallView[]> {
  return (await ports.calls.list(ports.agentId, limit)).map(view);
}

export async function getCall(ports: CallsPorts, id: string): Promise<CallView | null> {
  const row = await ports.calls.get(id);
  return row && row.agentId === ports.agentId ? view(row) : null;
}

export async function answerCallCheckin(
  ports: CallsPorts,
  input: {
    callId: string;
    checkinId: string;
    revision: number;
    answer: string;
    via: 'web' | 'mobile';
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const answer = input.answer.trim();
  if (!answer) return { ok: false, error: 'Type an answer for the assistant.' };
  const ok = await ports.calls.answerCheckin(
    ports.agentId,
    input.callId,
    input.checkinId,
    input.revision,
    answer,
    input.via,
  );
  return ok
    ? { ok: true }
    : { ok: false, error: 'That question was already answered, or the call has ended.' };
}

export async function hangUpCall(
  ports: CallsPorts,
  callId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return (await ports.calls.requestHangup(ports.agentId, callId))
    ? { ok: true }
    : { ok: false, error: 'That call is no longer active.' };
}
