import type { Db, TaskRow } from '@assistant/db';
import type {
  ApplicationConfirmationNoticeFence,
  DocumentExtractionRepository,
  EmailThreadHeadReader,
  ExecutionPersistence,
  FinalChannelDeliveryReport,
  FinalChannelDeliveryResult,
  ImportJobRepository,
  NotificationDeliveryResult,
  ReminderEventDependency,
} from '@assistant/persistence';
import type { ZodType } from 'zod';
import type { StagedJobPending } from '../../code-exec.js';
import type { Trust } from '../../events.js';
import type { DocumentProcessorConfig } from '../../memory/document-processor.js';
import type { WorkspaceReader } from '../../memory/import.js';
import type { ReminderSportsScoreboardReader } from '../../memory/jobs.js';
import type { ModelRouter } from '../../model-router/router.js';
import type { BriefingCalendarReader, CalendarEventReader } from '../briefing.js';
import type { OwnerIntent } from '../owner-intent.js';

/** Structural port implemented by @assistant/tools' ToolDispatcher — keeps core free of a package cycle. */
export interface DispatcherPort {
  toolDefs(
    trust: Trust,
    scope?: { isMissionSession: boolean },
  ): Array<{ name: string; description: string; inputSchema: ZodType }>;
  resultIsUntrusted(toolName: string): boolean;
  dispatch(input: {
    task: TaskRow;
    step: number;
    modelToolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    ctx: ToolContextLike;
    provenance: { plannerVersion: number; promptVersion: number; model: string };
  }): Promise<
    | { kind: 'executed'; toolCallId: string; result: unknown; cached: boolean }
    | {
        kind: 'recorded';
        toolCallId: string;
        effectOutcome: 'completed' | 'failed' | 'unknown' | 'not_executed';
        detailsExpired: true;
        requestedArgumentsVerified: false;
      }
    | {
        kind: 'awaiting_approval';
        toolCallId: string;
        approvalId: string;
        shortCode: string;
        summary: string;
      }
    | { kind: 'rejected'; reason: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  >;
  executeApproved(
    toolCallId: string,
    ctx: ToolContextLike,
    expectedToolName?: string,
  ): Promise<
    | { kind: 'executed'; result: unknown }
    | {
        kind: 'recorded';
        toolCallId: string;
        effectOutcome: 'completed' | 'failed' | 'unknown' | 'not_executed';
        detailsExpired: true;
        requestedArgumentsVerified: false;
      }
    | { kind: 'failed'; error: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  >;
}

export interface ToolContextLike {
  taskId: string;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  tainted: boolean;
  /** Typed provenance and directly authored scope for this task's latest owner turn. */
  ownerIntent?: OwnerIntent;
  /** Owner/thread-provided recipients used by the dispatcher's provenance guard. */
  knownAddresses?: { emails: string[]; phones: string[] };
  db: Db;
  now: () => Date;
  /** Immutable task request clock and owner timezone for relative schedules. */
  requestAt?: Date;
  requestTimeZone?: string;
  verifiedReminderEvent?: ReminderEventDependency;
  bookingOccurrence?: {
    agentId: string;
    bookingKey: string;
    version: number;
    operation?: 'cancel_existing';
    calendarEventId?: string;
    bookingIdentity?: string;
  };
  assertBookingOccurrenceCurrent?: () => Promise<boolean>;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
  execution?: { dbToolCallId: string; modelToolCallId: string; toolName: string };
  stageBrowserJob?: (job: {
    dbToolCallId: string;
    modelToolCallId: string;
    toolName: string;
    pending: StagedJobPending;
  }) => Promise<void>;
  clearStagedBrowserJob?: (job: {
    dbToolCallId: string;
    modelToolCallId: string;
    toolName: string;
    pending: StagedJobPending;
  }) => Promise<void>;
}

export interface ExecutorDeps {
  db: Db;
  /** Shared adapters for migrated executor operations; domain helpers still require Db. */
  persistence?: ExecutionPersistence;
  /** Recheck an opaque arrival observation before effects/final delivery. */
  isArrivalObservationActive?: (agentId: string, observationId: string) => Promise<boolean>;
  /** Firestore-backed document lifecycle selected by the Firestore agent composition. */
  documentExtractionRepository?: DocumentExtractionRepository;
  /** Firestore-backed import and voice-ingest lifecycle selected by the Firestore agent composition. */
  importJobRepository?: ImportJobRepository;
  router: ModelRouter;
  dispatcher: DispatcherPort;
  /** Workspace file store — required only for code jobs that read archives (imports). */
  workspace?: WorkspaceReader;
  /** Document-processor launcher + callback URL (Phase 14). Absent = feature inert. */
  documentProcessor?: DocumentProcessorConfig;
  /**
   * Calendar read for the briefing code job, supplied by the composition root
   * from the google module's client. Absent without that module — the briefing
   * then has no calendar section.
   */
  calendarReader?: BriefingCalendarReader;
  calendarEventReader?: CalendarEventReader;
  emailThreadReader?: EmailThreadHeadReader;
  /** True only when the active dispatcher exposes the bound cancellation tool. */
  calendarCancellationEnabled?: boolean;
  /** Synthetic provider seam for event-completion reminder tests. */
  reminderSportsScoreboardReader?: ReminderSportsScoreboardReader;
  /**
   * Returns a completion summary when a code job belongs to a module this
   * installation does not have, so the job completes instead of failing.
   */
  jobUnavailable?: (job: string) => string | null;
  /** Final-channel result for one persisted attempt. Legacy void adapters fail closed as unknown. */
  deliverFinal?: (
    task: TaskRow,
    text: string,
    attemptId: string,
    previous?: FinalChannelDeliveryReport,
  ) => Promise<FinalChannelDeliveryReport | FinalChannelDeliveryResult | void>;
  /**
   * Owner notification when approvals park a task (e.g. SMS "Reply YES A7").
   *
   * Receives the task so the deliverer can also answer on the channel the
   * request arrived on. That matters for email: parking otherwise leaves the
   * thread the owner is watching completely silent, because
   * postConversationNotice only writes a dashboard row.
   */
  notifyApproval?: (
    task: TaskRow,
    approvals: Array<{ taskId: string; shortCode: string; summary: string; toolName?: string }>,
  ) => Promise<void>;
  /**
   * Out-of-band owner ping for async events the owner would otherwise only see
   * by opening the dashboard: a task that permanently failed (dead-letter), a
   * task stalled on its own budget cap, or a mission that needs a decision.
   * Delivered to the owner's channel (e.g. SMS, push) in addition to the
   * dashboard conversation notice. Best-effort — callers swallow its errors.
   *
   * `urgency` chooses whether the nudge policy governs the phone leg. Omitted
   * it stays `interrupt`, which is what every caller above is: the owner is
   * the one waiting on a dead-letter or a budget stall, so those are never
   * held back. Proactive producers — the briefing, the pulse, curiosity —
   * pass `ambient`, which subjects the ping to quiet hours and the daily cap.
   *
   * `conversationId` names the thread that already holds this notice, so the
   * dashboard leg can skip mirroring a second copy; the phone legs ignore it.
   */
  notifyOwner?: (input: {
    deliveryKey?: string;
    taskId?: string;
    conversationId: string | null;
    text: string;
    urgency?: 'ambient' | 'interrupt';
    applicationConfirmationNoticeFence?: ApplicationConfirmationNoticeFence;
  }) => Promise<NotificationDeliveryResult | void>;
}

export type ExecuteResult = {
  outcome:
    | 'done'
    | 'parked'
    | 'sleeping'
    | 'failed'
    | 'dead_letter'
    | 'not_claimable'
    | 'needs_attention'
    | 'clarify'
    | 'cancelled';
  detail?: string;
};

export const LOST_LEASE: ExecuteResult = {
  outcome: 'not_claimable',
  detail: 'task lease was cancelled, expired, or reclaimed',
};
