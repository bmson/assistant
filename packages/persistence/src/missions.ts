import type { Records } from './records.js';

type Task = Records['tasks'];

export type MissionReport = Records['missionReports'];

/**
 * Build a report for a generic task-lifecycle terminal transition associated
 * with a mission. This wording reports the persisted task status only; it
 * never claims that an external effect was delivered or understood.
 */
export function missionTaskTerminalReport(input: {
  mission: Pick<Task, 'id' | 'agentId' | 'goalId' | 'conversationId'>;
  task: Pick<Task, 'id'>;
  status: 'done' | 'failed' | 'cancelled' | 'needs_attention';
  attempt?: number;
  now: Date;
}): MissionReport {
  const isSession = input.task.id !== input.mission.id;
  const text = isSession
    ? `A mission work session reached task status “${input.status}”. Review the session task before waking the mission again; this status does not verify external delivery.`
    : `The mission task reached generic status “${input.status}”. This status does not verify external delivery; review its saved activity before treating any effect as delivered.`;
  const attemptSuffix = input.attempt === undefined ? '' : `:attempt:${input.attempt}`;
  return {
    id: isSession
      ? `mission:${input.mission.id}:session:${input.task.id}:terminal:${input.status}${attemptSuffix}`
      : `mission:${input.mission.id}:task-terminal:${input.status}${attemptSuffix}`,
    agentId: input.mission.agentId,
    missionId: input.mission.id,
    goalId: input.mission.goalId,
    conversationId: input.mission.conversationId,
    outcome: isSession ? `session_${input.status}` : `task_${input.status}`,
    text,
    chatStatus: 'pending',
    ownerStatus: 'pending',
    mirrorStatus: 'pending',
    claimToken: null,
    lockedUntil: null,
    nextAttemptAt: input.now,
    attempts: 0,
    createdAt: input.now,
    updatedAt: input.now,
    chatDeliveredAt: null,
    ownerDeliveredAt: null,
    mirrorDeliveredAt: null,
    lastError: null,
  };
}

export type MissionReportLeg = 'chat' | 'owner' | 'mirror';
export type MissionReportLegStatus =
  | MissionReport['chatStatus']
  | MissionReport['ownerStatus']
  | MissionReport['mirrorStatus'];

export interface MissionReportLease {
  report: MissionReport;
  claimToken: string;
}

export interface MissionReportTransitionInput {
  taskId: string;
  agentId: string;
  leaseToken: string;
  eventId: string;
  outcome: string;
  status: 'done' | 'cancelled' | 'needs_attention' | 'waiting_event';
  progress?: string;
  progressPercent?: number | null;
  lastReflectedAt?: Date;
  text: string;
}

/** Mission reads that the wake loop needs beyond the task lifecycle. */
export interface MissionRepository {
  readonly kind: 'mission-repository';
  /** The most recently updated session child that has not finished, if any. */
  activeSession(agentId: string, missionId: string): Promise<Pick<Task, 'id' | 'status'> | null>;
  /** Model spend charged to the mission and all of its session children, in USD. */
  spentUsd(agentId: string, missionId: string): Promise<number>;
  /** Commit a mission state transition and its durable report in one transaction. */
  transitionWithReport(input: MissionReportTransitionInput): Promise<boolean>;
  /** Pending report identities for the periodic read-repair sweep. */
  dueReports(agentId: string, limit?: number): Promise<string[]>;
  /** Claim one report with an expiring fenced lease. */
  claimReport(id: string, agentId: string, leaseMs?: number): Promise<MissionReportLease | null>;
  /** Acknowledge one report leg without overwriting the other. */
  settleReportLeg(input: {
    id: string;
    claimToken: string;
    leg: MissionReportLeg;
    status: MissionReportLegStatus;
    error?: string;
  }): Promise<boolean>;
  /** Release a report after processing; failed legs receive bounded backoff. */
  releaseReport(input: { id: string; claimToken: string; error?: string }): Promise<boolean>;
}

export interface MissionSessionProgressInput {
  agentId: string;
  /** The session task calling mission.update; its parent must be a mission. */
  sessionTaskId: string;
  progress: string;
  nextAction: string;
  /** Omitted or null keeps the mission's current percentage. */
  progressPercent?: number | null;
  /** Empty keeps the mission's current scratchpad. */
  notes: string;
}

/** The mission.update tool: a session writes its progress to its parent mission. */
export interface MissionProgressRepository {
  recordSessionProgress(input: MissionSessionProgressInput): Promise<{ updated: string }>;
}
