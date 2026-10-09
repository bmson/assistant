import {
  type EmbeddingSpace,
  type ExecutionPersistence,
  snapshotEmbeddingSpace,
} from '@assistant/persistence';
import { FirestoreAmbientSnapshotRepository } from './ambient-snapshots.js';
import { FirestoreAnomalyScanRepository } from './anomaly-scan.js';
import { FirestoreApplicationConfirmationRepository } from './application-confirmations.js';
import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreApprovalRepository } from './approvals.js';
import { FirestoreAssistantHealthRepository } from './assistant-health.js';
import { FirestoreAuditInvestigationRepository } from './audit-investigation.js';
import { FirestoreBriefingRepository } from './briefing.js';
import { FirestoreCallSessionRepository } from './call-sessions.js';
import { createFirestoreCardRefreshRepository } from './card-refresh.js';
import { FirestoreCommitmentMaintenanceRepository } from './commitment-maintenance.js';
import { FirestoreConversationSearchRepository } from './conversation-search.js';
import { FirestoreConversationSegmentationRepository } from './conversation-segmentation.js';
import { FirestoreCostRepository } from './costs.js';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import { FirestoreDocumentCatalogRepository } from './document-catalog.js';
import { FirestoreDocumentProcessorRepository } from './document-processor.js';
import { FirestoreDocumentSearchRepository } from './document-search.js';
import { FirestoreDreamRepository } from './dream.js';
import { FirestoreEmailAttachmentCustodyRepository } from './email-attachment-custody.js';
import { FirestoreEmailExtractionRepository } from './email-extraction.js';
import { FirestoreEmailSyncRepository } from './email-sync.js';
import { FirestoreExecutionContextRepository } from './execution-context.js';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { FirestoreExecutionJobRepository } from './execution-jobs.js';
import { FirestoreGeneratedCardRepository } from './generated-cards.js';
import { FirestoreGoalRuntimeRepository } from './goal-runtime.js';
import { FirestoreGraphCuriosityRepository } from './graph-curiosity.js';
import { FirestoreGraphDateBackfillRepository } from './graph-date-backfill.js';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { FirestoreHistoryRecallRepository } from './history-recall.js';
import { FirestoreKnowledgeGraphSyncRepository } from './knowledge-graph-sync.js';
import { FirestoreMaintenanceRepository } from './maintenance.js';
import { FirestoreMemoryConsolidationRepository } from './memory-consolidation.js';
import { FirestoreMemoryExtractionRepository } from './memory-extraction.js';
import { FirestoreMemorySupersedeRepository } from './memory-supersede.js';
import { FirestoreMemoryToolRepository } from './memory-tools.js';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreMissionRepository } from './missions.js';
import {
  FirestoreModelCatalogRepository,
  FirestoreModelConnectionRepository,
} from './model-connections.js';
import { FirestoreModelRoutingRepository } from './model-routing.js';
import { FirestoreNotificationOutboxRepository } from './notification-outbox.js';
import { FirestoreNudgePolicyRepository } from './nudge-policy.js';
import { FirestoreOwnerCardCompilationRepository } from './owner-card-compilation.js';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import { FirestoreOwnerNoticeRepository, firestoreOwnerNotices } from './owner-notices.js';
import { FirestorePulseRepository } from './pulse.js';
import { FirestoreRecallMetricsRepository } from './recall-metrics.js';
import { FirestoreRecallSurfacingRepository } from './recall-surfacing.js';
import { FirestoreReminderDeliveryRepository } from './reminders.js';
import { FirestoreSelfImprovementRepository } from './self-improvement.js';
import { FirestoreSelfMaintenanceRepository } from './self-maintenance.js';
import { FirestoreSelfRepairRepository } from './self-repair.js';
import { FirestoreSituationToolRepository } from './situation-tools.js';
import { FirestoreSkillContextRepository } from './skill-context.js';
import { FirestoreSkillReflectionRepository } from './skill-reflection.js';
import { FirestoreSmsChannelRepository } from './sms-channel.js';
import type { InstallationStore } from './store.js';
import { FirestoreSuggestionRepository } from './suggestions.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';
import { FirestoreVoiceContextRepository } from './voice-context.js';
import { FirestoreWatchRepository } from './watches.js';

/** Composes migrated operations only; this is not a complete application driver switch. */
export function createFirestoreExecutionPersistence(
  store: InstallationStore,
  agentId: string,
  skillEmbeddingSpace: EmbeddingSpace,
): ExecutionPersistence & {
  tasks: FirestoreTaskRepository;
  maintenance: FirestoreMaintenanceRepository;
} {
  const capturedEmbeddingSpace = snapshotEmbeddingSpace(skillEmbeddingSpace);
  const notifications = new FirestoreOwnerNoticeRepository(store, agentId);
  const situationDecisionContext = new FirestoreSituationToolRepository(store, agentId);
  return {
    driver: 'firestore',
    conversationSearch: new FirestoreConversationSearchRepository(store, capturedEmbeddingSpace),
    tasks: new FirestoreTaskRepository(store),
    costs: new FirestoreCostRepository(store),
    messages: new FirestoreMessageRepository(store),
    memory: new FirestoreMemoryToolRepository(store, capturedEmbeddingSpace),
    memorySupersede: new FirestoreMemorySupersedeRepository(store, capturedEmbeddingSpace),
    memoryConsolidation: new FirestoreMemoryConsolidationRepository(store, capturedEmbeddingSpace),
    memoryExtraction: new FirestoreMemoryExtractionRepository(store, capturedEmbeddingSpace),
    approvals: new FirestoreApprovalRepository(store),
    approvalPolicies: new FirestoreApprovalPolicyRepository(store),
    modelRouting: new FirestoreModelRoutingRepository(store, agentId),
    toolExecution: new FirestoreToolExecutionRepository(store),
    executionContext: new FirestoreExecutionContextRepository(store),
    executionJobs: new FirestoreExecutionJobRepository(store),
    executionEvidence: new FirestoreExecutionEvidenceRepository(store),
    ownerContext: new FirestoreOwnerContextRepository(store),
    situationDecisionContext,
    ownerCardCompilation: new FirestoreOwnerCardCompilationRepository(store),
    skills: new FirestoreSkillContextRepository(store, capturedEmbeddingSpace),
    history: new FirestoreHistoryRecallRepository(store, capturedEmbeddingSpace),
    graph: new FirestoreGraphRecallRepository(store, capturedEmbeddingSpace),
    graphSync: new FirestoreKnowledgeGraphSyncRepository(store),
    generatedCards: new FirestoreGeneratedCardRepository(store),
    cardRefresh: createFirestoreCardRefreshRepository(store),
    recallMetrics: new FirestoreRecallMetricsRepository(store),
    recallSurfacing: new FirestoreRecallSurfacingRepository(store),
    watches: new FirestoreWatchRepository(store),
    assistantHealth: new FirestoreAssistantHealthRepository(store, agentId),
    reminderDelivery: new FirestoreReminderDeliveryRepository(store, agentId),
    maintenance: new FirestoreMaintenanceRepository(store, agentId, capturedEmbeddingSpace),
    notifications,
    notificationOutbox: new FirestoreNotificationOutboxRepository(store, agentId),
    goals: new FirestoreGoalRuntimeRepository(store, agentId),
    missions: new FirestoreMissionRepository(store, agentId),
    ambientSnapshots: new FirestoreAmbientSnapshotRepository(store),
    commitmentMaintenance: new FirestoreCommitmentMaintenanceRepository(store),
    deviceTokens: new FirestoreDeviceTokenRepository(store),
    nudgePolicy: new FirestoreNudgePolicyRepository(store, agentId),
    voiceContext: new FirestoreVoiceContextRepository(store, agentId, capturedEmbeddingSpace),
    smsChannel: new FirestoreSmsChannelRepository(store, agentId),
    callSessions: new FirestoreCallSessionRepository(store, agentId),
    modelConnections: new FirestoreModelConnectionRepository(store),
    modelCatalog: new FirestoreModelCatalogRepository(store),
    applications: new FirestoreApplicationConfirmationRepository(store, agentId),
    emailSync: new FirestoreEmailSyncRepository(store, agentId),
    emailAttachmentCustody: new FirestoreEmailAttachmentCustodyRepository(store, agentId),
    documentCatalog: new FirestoreDocumentCatalogRepository(store, agentId),
    documentSearch: new FirestoreDocumentSearchRepository(store, agentId, capturedEmbeddingSpace),
    documentProcessor: new FirestoreDocumentProcessorRepository(store, agentId),
    emailExtraction: new FirestoreEmailExtractionRepository(store, agentId, capturedEmbeddingSpace),
    anomalyScan: new FirestoreAnomalyScanRepository(store, agentId),
    ownerNotices: firestoreOwnerNotices(notifications),
    suggestions: new FirestoreSuggestionRepository(store),
    briefing: new FirestoreBriefingRepository(store),
    pulse: new FirestorePulseRepository(store),
    conversationSegmentation: new FirestoreConversationSegmentationRepository(
      store,
      capturedEmbeddingSpace,
    ),
    skillReflection: new FirestoreSkillReflectionRepository(store, agentId, capturedEmbeddingSpace),
    selfMaintenance: new FirestoreSelfMaintenanceRepository(store, agentId),
    selfRepair: new FirestoreSelfRepairRepository(store, agentId),
    selfRepairAudit: new FirestoreAuditInvestigationRepository(store),
    dream: new FirestoreDreamRepository(store, agentId),
    selfImprovement: new FirestoreSelfImprovementRepository(store, agentId),
    graphDateBackfill: new FirestoreGraphDateBackfillRepository(store, agentId),
    graphCuriosity: new FirestoreGraphCuriosityRepository(store, agentId),
  };
}
