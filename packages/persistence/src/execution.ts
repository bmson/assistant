import type { AnomalyScanRepository } from './anomaly-scan.js';
import type { ApplicationConfirmationRepository } from './application-confirmations.js';
import type { ApprovalPolicyRepository } from './approval-policies.js';
import type { ApprovalRepository } from './approvals.js';
import type { AssistantHealthRepository } from './assistant-health.js';
import type { AuditInvestigationRepository } from './audit-investigation.js';
import type { BriefingRepository } from './briefing.js';
import type {
  ConversationSearchRepository,
  SituationDecisionContextRepository,
} from './builtin-tools.js';
import type { CallSessionRepository } from './call-sessions.js';
import type { CardRefreshRepository } from './card-refresh.js';
import type { CommitmentMaintenanceRepository } from './commitment-maintenance.js';
import type { CostRepository, MessageRepository } from './contracts.js';
import type { ConversationSegmentationRepository } from './conversation-segmentation.js';
import type { DeviceTokenRepository } from './device-tokens.js';
import type { ToolExecutionRepository } from './dispatch.js';
import type {
  DocumentCatalogRepository,
  DocumentProcessorRepository,
  DocumentSearchRepository,
} from './document-catalog.js';
import type { DreamRepository } from './dream.js';
import type { EmailAttachmentCustodyRepository } from './email-attachment-custody.js';
import type { EmailExtractionRepository } from './email-extraction.js';
import type { EmailSyncRepository } from './email-sync.js';
import type { ExecutionContextRepository } from './execution-context.js';
import type { ExecutionEvidenceRepository } from './execution-evidence.js';
import type { ExecutionJobRepository } from './execution-jobs.js';
import type { GeneratedCardRepository } from './generated-cards.js';
import type { GoalRuntimeRepository } from './goals.js';
import type { GraphCuriosityRepository } from './graph-curiosity.js';
import type { GraphDateBackfillRepository } from './graph-date-backfill.js';
import type { GraphRecallRepository } from './graph-recall.js';
import type { HistoryRecallRepository } from './history-recall.js';
import type { KnowledgeGraphSyncRepository } from './knowledge-graph-sync.js';
import type { MaintenanceRepository } from './maintenance.js';
import type { MemoryConsolidationRepository } from './memory-consolidation.js';
import type { MemoryExtractionRepository } from './memory-extraction.js';
import type { MemorySupersedeRepository } from './memory-supersede.js';
import type { MemoryToolRepository } from './memory-tools.js';
import type { MissionRepository } from './missions.js';
import type {
  ModelCatalogRepository,
  ModelConnectionRepository,
  ModelRoutingRepository,
} from './model-routing.js';
import type { NotificationOutboxRepository } from './notification-outbox.js';
import type {
  NotificationsConversationRepository,
  OwnerNoticeRepository,
} from './notifications.js';
import type { NudgePolicyRepository } from './nudge-policy.js';
import type { OwnerCardCompilationRepository } from './owner-card-compilation.js';
import type { AmbientSnapshotRepository, OwnerContextRepository } from './owner-context.js';
import type { PulseRepository } from './pulse.js';
import type { RecallMetricsRepository } from './recall-metrics.js';
import type { RecallSurfacingRepository } from './recall-surfacing.js';
import type { ReminderDeliveryRepository } from './reminders.js';
import type { SelfImprovementRepository } from './self-improvement.js';
import type { SelfMaintenanceRepository } from './self-maintenance.js';
import type { SelfRepairRepository } from './self-repair.js';
import type { SkillContextRepository } from './skill-context.js';
import type { SkillReflectionRepository } from './skill-reflection.js';
import type { SmsChannelRepository } from './sms-channel.js';
import type { SuggestionRepository } from './suggestions.js';
import type { TaskRepository } from './task-lifecycle.js';
import type { VoiceContextRepository } from './voice-context.js';
import type { WatchRepository } from './watches.js';

/** One store supplies every migrated executor operation. Remaining domain ports are separate. */
export interface ExecutionPersistence {
  readonly driver: 'postgres' | 'firestore';
  readonly tasks: TaskRepository;
  readonly costs: CostRepository;
  readonly messages: MessageRepository;
  readonly approvals: ApprovalRepository;
  readonly approvalPolicies: ApprovalPolicyRepository;
  readonly modelRouting: ModelRoutingRepository;
  readonly toolExecution: ToolExecutionRepository;
  readonly executionContext: ExecutionContextRepository;
  readonly executionJobs: ExecutionJobRepository;
  readonly executionEvidence: ExecutionEvidenceRepository;
  readonly ownerContext: OwnerContextRepository;
  /** Bounded owner-confirmed situation choices for chat context before planning. */
  readonly situationDecisionContext?: SituationDecisionContextRepository;
  /** Owner-scoped local refresh for persisted conversations.search results on resume. */
  readonly conversationSearch?: ConversationSearchRepository;
  readonly ownerCardCompilation: OwnerCardCompilationRepository;
  readonly skills: SkillContextRepository;
  readonly history: HistoryRecallRepository;
  readonly memory: MemoryToolRepository;
  readonly memorySupersede: MemorySupersedeRepository;
  /** Present while the bounded consolidation job is migrated off SQL. */
  readonly memoryConsolidation?: MemoryConsolidationRepository;
  /** Present where the nightly `memory.extract` job has a portable adapter. */
  readonly memoryExtraction?: MemoryExtractionRepository;
  readonly graph: GraphRecallRepository;
  readonly graphSync: KnowledgeGraphSyncRepository;
  readonly generatedCards: GeneratedCardRepository;
  readonly cardRefresh: CardRefreshRepository;
  readonly recallMetrics: RecallMetricsRepository;
  /** Source-identity ledger and owner controls for historical context surfaced in replies. */
  readonly recallSurfacing?: RecallSurfacingRepository;
  readonly watches: WatchRepository;
  readonly notifications: NotificationsConversationRepository;
  /** Durable per-destination owner notification intents and receipts. */
  readonly notificationOutbox: NotificationOutboxRepository;
  readonly goals: GoalRuntimeRepository;
  readonly missions: MissionRepository;
  /** Present where the health monitor job has a portable adapter. */
  readonly assistantHealth?: AssistantHealthRepository;
  /**
   * Present where scheduled reminder delivery has a portable adapter. Without
   * it the `reminder.notify` job keeps its PostgreSQL delivery path.
   */
  readonly reminderDelivery?: ReminderDeliveryRepository;
  /**
   * Present where the maintenance sweep has a portable adapter. PostgreSQL
   * runs the same steps through the core SQL functions.
   */
  readonly maintenance?: MaintenanceRepository;
  /** Present where the ambient refresh job has a portable writer. */
  readonly ambientSnapshots?: AmbientSnapshotRepository;
  /** Present where the open-loop sweep has a portable adapter. */
  readonly commitmentMaintenance?: CommitmentMaintenanceRepository;
  /** Present where the push channel reads and invalidates device tokens portably. */
  readonly deviceTokens?: DeviceTokenRepository;
  /** Present where out-of-band pings consult quiet hours and the daily cap portably. */
  readonly nudgePolicy?: NudgePolicyRepository;
  /** Present where outbound rewrites read the owner's voice portably. */
  readonly voiceContext?: VoiceContextRepository;
  /** Present where the SMS channel keeps its state portably. */
  readonly smsChannel?: SmsChannelRepository;
  /** Phone calls placed by the calls module. */
  readonly callSessions?: CallSessionRepository;
  /** Owner-connected model providers (keys sealed). */
  readonly modelConnections?: ModelConnectionRepository;
  /** The model catalog and role routing. */
  readonly modelCatalog?: ModelCatalogRepository;
  /** Present where application confirmation watches are kept portably. */
  readonly applications?: ApplicationConfirmationRepository;
  /** Present where Gmail sync keeps its state portably. */
  readonly emailSync?: EmailSyncRepository;
  /** Present only when the driver atomically fences attachment custody and erasure. */
  readonly emailAttachmentCustody?: EmailAttachmentCustodyRepository;
  /** Present where documents are catalogued portably (uploads, email attachments). */
  readonly documentCatalog?: DocumentCatalogRepository;
  /** Present where document passages are searched portably. */
  readonly documentSearch?: DocumentSearchRepository;
  /** Present where the document processor lifecycle is kept portably. */
  readonly documentProcessor?: DocumentProcessorRepository;
  /** Present where the `email.extract` job has a portable adapter. */
  readonly emailExtraction?: EmailExtractionRepository;
  /** Present where the `anomaly.scan` job has a portable adapter. */
  readonly anomalyScan?: AnomalyScanRepository;
  /** Present where background producers post their dashboard copy portably. */
  readonly ownerNotices?: OwnerNoticeRepository;
  /** Present where producers record one-tap suggestions portably. */
  readonly suggestions?: SuggestionRepository;
  /** Present where the `briefing.compose` job has a portable adapter. */
  readonly briefing?: BriefingRepository;
  /** Present where the `pulse.check` job has a portable adapter. */
  readonly pulse?: PulseRepository;
  /** Present where the `chat.segment` job has a portable adapter. */
  readonly conversationSegmentation?: ConversationSegmentationRepository;
  /** Present where the `skill.reflect` job has a portable adapter. */
  readonly skillReflection?: SkillReflectionRepository;
  /** Present where the `self.maintain` job has a portable adapter. */
  readonly selfMaintenance?: SelfMaintenanceRepository;
  readonly selfRepair?: SelfRepairRepository;
  readonly selfRepairAudit?: AuditInvestigationRepository;
  /** Present where the `dream.run` job has a portable adapter. */
  readonly dream?: DreamRepository;
  /** Present where the `self.improve` job has a portable adapter. */
  readonly selfImprovement?: SelfImprovementRepository;
  /** Present where the `memory.graph_date_backfill` job has a portable adapter. */
  readonly graphDateBackfill?: GraphDateBackfillRepository;
  /** Present where the `graph.curiosity` job has a portable adapter. */
  readonly graphCuriosity?: GraphCuriosityRepository;
}
