import type { CostEvidence } from './cost-evidence.js';
import type { Records } from './records.js';

/** Interfaces describe atomic domain operations, never SDK queries or transaction objects. */
export type SpendSource =
  | 'model'
  | 'embedding'
  | 'twilio_sms'
  | 'twilio_voice_min'
  | 'cloud_run_job_sec'
  | 'storage_gb_month'
  | 'external_api';

export interface CostTotals {
  dailySpentUsd: number;
  monthlySpentUsd: number;
  heldUsd: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  softPct: number;
}

export interface CostEventInput {
  evidence?: CostEvidence;
  source: SpendSource;
  usd: number;
  taskId?: string | null;
  toolCallId?: string | null;
  quantity?: number;
  unit?: string;
  unitPriceUsd?: number;
  description?: string;
  reservationId?: string;
  /** Stable operation identity for safe replay after an ambiguous commit. */
  idempotencyKey?: string;
  addToTaskSpend?: boolean;
}

export interface ReserveCostInput {
  source: SpendSource;
  estimatedUsd: number;
  taskId?: string;
  description?: string;
  critical?: boolean;
  /** Stable across a caller's transport retries. Reusing it for other work is rejected. */
  operationId?: string;
}

export type ReserveOutcome =
  | { ok: true; reservationId: string }
  | { ok: false; reason: string; resumeAt: Date };

export interface ReservationActual {
  evidence?: CostEvidence;
  usd: number;
  quantity?: number;
  unit?: string;
  unitPriceUsd?: number;
  toolCallId?: string;
  description?: string;
}

/** Privacy-minimized provider dispatch metadata; never store prompt content here. */
export interface CostAttemptMetadata {
  provider: string;
  model: string;
  role: string;
  requestDigest: string;
  inputTokenEstimate: number;
  outputTokenLimit: number;
  reasoning: 'enabled' | 'disabled' | 'unsupported' | 'unknown';
}

export interface CostRepository {
  readonly kind: 'cost-repository';
  getRate(key: string): Promise<{ unit: string; unitPriceUsd: number } | null>;
  totals(): Promise<CostTotals>;
  reserve(input: ReserveCostInput): Promise<ReserveOutcome>;
  /** Durably mark the one provider dispatch before network work begins. False means already dispatched/closed. */
  beginAttempt(reservationId: string, metadata: CostAttemptMetadata): Promise<boolean>;
  /** Keep the estimate as a held liability when a paid result or metering is uncertain. */
  markAttemptUnknown(
    reservationId: string,
    reason: string,
    providerReceipt?: { requestId?: string; endpoint?: string },
  ): Promise<void>;
  record(input: CostEventInput): Promise<void>;
  reconcile(reservationId: string, actual: ReservationActual): Promise<void>;
  release(reservationId: string): Promise<void>;
  releaseStale(olderThanMinutes?: number, batch?: number): Promise<number>;
}

export interface ReminderCancellation {
  cancelled: boolean;
  text?: string;
  queuedTasksCancelled?: number;
}

export interface ReminderRepository {
  readonly kind: 'reminder-repository';
  cancel(agentId: string, reminderId: string, now?: Date): Promise<ReminderCancellation>;
}

export function nextUtcDailyReset(from = new Date()): Date {
  const next = new Date(from);
  next.setUTCHours(24, 5, 0, 0);
  return next;
}

export function nextUtcMonthlyReset(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 5));
}

/** Timestamp enforces expiry; the opaque token fences replaced leases. Null supports existing PostgreSQL leases during upgrade. */
export type TaskLease = Records['tasks'] & { lockedUntil: Date };
export interface TaskCheckpoint {
  /** Metadata alone is durable state, not proof of a completed work step. */
  preserveFailureCounters?: boolean;
  progress?: string;
  progressPercent?: number | null;
  nextAction?: string;
  lastReflectedAt?: Date;
}
export interface TaskLeaseRepository {
  readonly kind: 'task-lease-repository';
  claim(taskId: string, generation?: number): Promise<TaskLease | null>;
  /** On success updates the supplied lease, matching existing executor semantics. */
  renew(task: TaskLease): Promise<boolean>;
  checkpoint(task: TaskLease, state: unknown, extra?: TaskCheckpoint): Promise<boolean>;
}
export interface AppendMessageInput {
  conversationId: string;
  taskId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  origin: 'owner' | 'known_contact' | 'unknown' | 'web' | 'assistant' | 'system';
  parts: unknown[];
  text: string;
  channelMessageId?: string;
  /** Present only for dashboard notification append; checked inside the message transaction. */
  notificationOutboxFence?: import('./generated-cards.js').NotificationOutboxAppendFence;
  /** A delayed application-confirmation task result; checked in the same append transaction. */
  applicationConfirmationNoticeFence?: import('./application-confirmation-notice.js').ApplicationConfirmationNoticeFence;
}
export interface MessageRepository {
  readonly kind: 'message-repository';
  /** Duplicate channel deliveries return undefined, as in the existing API. */
  append(input: AppendMessageInput): Promise<Records['messages'] | undefined>;
}
