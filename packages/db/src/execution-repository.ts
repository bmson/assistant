import type { ExecutionPersistence } from '@assistant/persistence';
import { createPostgresApplicationConfirmationRepository } from './application-confirmation-repository.js';
import { createPostgresApprovalPolicyRepository } from './approval-policy-repository.js';
import { createPostgresApprovalRepository } from './approval-repository.js';
import { createPostgresCallSessionRepository } from './call-session-repository.js';
import { createPostgresCardRefreshRepository } from './card-refresh-repository.js';
import type { Db } from './client.js';
import { createPostgresConversationSearchRepository } from './conversation-search-repository.js';
import { createPostgresCostRepository } from './cost-repository.js';
import { createPostgresDeviceTokenRepository } from './device-token-repository.js';
import { createPostgresDocumentProcessorRepository } from './document-processor-repository.js';
import { createPostgresDocumentSearchRepository } from './document-search-repository.js';
import { createPostgresEmailAttachmentCustodyRepository } from './email-attachment-custody-repository.js';
import { createPostgresEmailSyncRepository } from './email-sync-repository.js';
import { createPostgresExecutionContextRepository } from './execution-context-repository.js';
import { createPostgresExecutionEvidenceRepository } from './execution-evidence-repository.js';
import { createPostgresExecutionJobRepository } from './execution-jobs-repository.js';
import { createPostgresGeneratedCardRepository } from './generated-card-repository.js';
import { createPostgresGoalRuntimeRepository } from './goal-runtime-repository.js';
import { createPostgresGraphRecallRepository } from './graph-recall-repository.js';
import { createPostgresHistoryRecallRepository } from './history-recall-repository.js';
import { createPostgresKnowledgeGraphSyncRepository } from './knowledge-graph-sync-repository.js';
import { createPostgresMemorySupersedeRepository } from './memory-supersede-repository.js';
import { createPostgresMemoryToolRepository } from './memory-tool-repository.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresMissionRepository } from './mission-repository.js';
import { createPostgresModelCatalogRepository } from './model-catalog-repository.js';
import { createPostgresModelConnectionRepository } from './model-connection-repository.js';
import { createPostgresModelRoutingRepository } from './model-routing-repository.js';
import { createPostgresNotificationOutboxRepository } from './notification-outbox-repository.js';
import { createPostgresNotificationsConversationRepository } from './notifications-conversation-repository.js';
import { createPostgresNudgePolicyRepository } from './nudge-policy-repository.js';
import { createPostgresOwnerCardCompilationRepository } from './owner-card-compilation-repository.js';
import { createPostgresOwnerContextRepository } from './owner-context-repository.js';
import { createPostgresRecallMetricsRepository } from './recall-metrics-repository.js';
import { createPostgresRecallSurfacingRepository } from './recall-surfacing-repository.js';
import { createPostgresSkillContextRepository } from './skill-context-repository.js';
import { createPostgresSmsChannelRepository } from './sms-channel-repository.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';
import { createPostgresVoiceContextRepository } from './voice-context-repository.js';
import { createPostgresWatchRepository } from './watch-repository.js';

export function createPostgresExecutionPersistence(db: Db): ExecutionPersistence {
  return {
    driver: 'postgres',
    conversationSearch: createPostgresConversationSearchRepository(db),
    tasks: createPostgresTaskRepository(db),
    costs: createPostgresCostRepository(db),
    messages: createPostgresMessageRepository(db),
    memory: createPostgresMemoryToolRepository(db),
    memorySupersede: createPostgresMemorySupersedeRepository(db),
    approvals: createPostgresApprovalRepository(db),
    approvalPolicies: createPostgresApprovalPolicyRepository(db),
    modelRouting: createPostgresModelRoutingRepository(db),
    toolExecution: createPostgresToolExecutionRepository(db),
    executionContext: createPostgresExecutionContextRepository(db),
    executionJobs: createPostgresExecutionJobRepository(db),
    executionEvidence: createPostgresExecutionEvidenceRepository(db),
    ownerContext: createPostgresOwnerContextRepository(db),
    ownerCardCompilation: createPostgresOwnerCardCompilationRepository(db),
    skills: createPostgresSkillContextRepository(db),
    history: createPostgresHistoryRecallRepository(db),
    graph: createPostgresGraphRecallRepository(db),
    graphSync: createPostgresKnowledgeGraphSyncRepository(db),
    generatedCards: createPostgresGeneratedCardRepository(db),
    cardRefresh: createPostgresCardRefreshRepository(db),
    recallMetrics: createPostgresRecallMetricsRepository(db),
    recallSurfacing: createPostgresRecallSurfacingRepository(db),
    watches: createPostgresWatchRepository(db),
    notifications: createPostgresNotificationsConversationRepository(db),
    notificationOutbox: createPostgresNotificationOutboxRepository(db),
    goals: createPostgresGoalRuntimeRepository(db),
    missions: createPostgresMissionRepository(db),
    deviceTokens: createPostgresDeviceTokenRepository(db),
    nudgePolicy: createPostgresNudgePolicyRepository(db),
    voiceContext: createPostgresVoiceContextRepository(db),
    smsChannel: createPostgresSmsChannelRepository(db),
    callSessions: createPostgresCallSessionRepository(db),
    modelConnections: createPostgresModelConnectionRepository(db),
    modelCatalog: createPostgresModelCatalogRepository(db),
    applications: createPostgresApplicationConfirmationRepository(db),
    emailSync: createPostgresEmailSyncRepository(db),
    emailAttachmentCustody: createPostgresEmailAttachmentCustodyRepository(db),
    documentSearch: createPostgresDocumentSearchRepository(db),
    documentProcessor: createPostgresDocumentProcessorRepository(db),
  };
}
