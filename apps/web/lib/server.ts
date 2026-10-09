// Server-only singletons. Cached on globalThis so Next dev hot-reload doesn't
// leak postgres connection pools on every recompile.
import path from 'node:path';
import {
  acknowledgeChatMessageDelivery,
  addAssistantSkill,
  addOwnerKnowledgeGraphFact,
  addOwnerKnowledgeGraphFactFromRepository,
  applyImprovementProposal,
  archiveChatConversation,
  archiveInactiveChats,
  cancelChatTurn,
  changeChatModel,
  checkReadiness,
  checkReadinessWithProbe,
  correctKnowledgeGraphRelation,
  correctOwnerCommitment,
  correctOwnerKnowledgeGraphFactFromRepository,
  createCardFormAdmissionService,
  createChatConversation,
  createMcpConnection,
  decideApproval,
  deleteApprovalPolicy,
  deleteAssistantSkill,
  deleteDocument,
  deleteImportedSource,
  deleteMcpConnection,
  deleteReminder,
  dismissAnomalyRecord,
  dismissImprovementProposal,
  dismissOwnerCommitment,
  downloadArtifact,
  downloadArtifactWithLookup,
  editAssistantSkill,
  exportLongTermMemoryData,
  forgetLongTermMemory,
  getAssistantIdentity,
  getAssistantTimezone,
  getChatConversationView,
  getCostsDashboard,
  getDocument,
  getDocumentsOverview,
  getImportOverview,
  getMcpConnection,
  getPrimaryConversationId,
  getProactiveHealth,
  getProfileOverview,
  getSettingsOverview,
  getShellStatus,
  handleChatTurn,
  hideChatMessage,
  type ImportCommandPersistence,
  isValidChatCursor,
  listActivity,
  listAnomalies,
  listApprovalInbox,
  listAssistantSkills,
  listChatHistory,
  listClosedCommitmentOverview,
  listCommitmentOverview,
  listGoalsDashboard,
  listImprovementProposals,
  listMcpConnections,
  purgeImportedSource,
  recordOwnerForeground,
  recordOwnerLocationPing,
  recordOwnerLocationPingWithRepository,
  recordRecallFeedback,
  recordRecallFeedbackWithRepository,
  registerDeviceToken,
  registerDeviceTokenWithRepository,
  reopenOwnerCommitment,
  resolveOwnerCommitment,
  restoreChatConversation,
  reviewImportedSource,
  saveMcpDiscovery,
  setApprovalPolicyEnabled,
  setAssistantSkillDeprecated,
  setMcpConnectionEnabled,
  setRecurringJobEnabled,
  snoozeOwnerCommitment,
  startWorkspaceImport,
  suspendAnomalyRecord,
  unhideChatMessage,
  updateAssistantSettings,
  updateNotificationPrefs,
  uploadDocument,
  uploadImport,
  waitForChatUpdates,
} from '@assistant/application';
import { readAuditInvestigation } from '@assistant/application/audit-investigation';
import type { CallsPorts } from '@assistant/application/calls';
import type { GoalInput } from '@assistant/application/goals';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import type { ModelProviderPorts } from '@assistant/application/model-providers';
import { listPeopleDirectoryPage, personSummaryFromStoredRow } from '@assistant/application/people';
import {
  createProfileMemoryCommands,
  organizeMemoryNow,
  organizeMemoryNowWithRepository,
  type ProfileMemoryCommandPersistence,
  profileMemoryCommands,
} from '@assistant/application/profile';
import { getProviderBilling } from '@assistant/application/provider-billing';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  repoRoot,
  validateAgentPersistenceConfig,
  validateRestoreRehearsalConfig,
} from '@assistant/config';
import {
  encodeMessageCursor,
  getAgent,
  getOrCreatePrimaryConversation,
} from '@assistant/core/chat';
import {
  decryptStoredCredential,
  encryptMcpBearerToken,
  encryptStoredCredential,
} from '@assistant/core/mcp-secrets';
import { documentStats } from '@assistant/core/memory/document-catalog';
import { createConnectedModelProviders, ModelRouter } from '@assistant/core/model-router';
import {
  goalAutomationCadence,
  goalAutomationInstruction,
  nextRun,
} from '@assistant/core/workflow/schedules';
import {
  anomalies,
  assertPostgresRestoreRehearsalReadOnly,
  createDb,
  createPostgresApplicationChatPersistence,
  createPostgresAuditInvestigationRepository,
  createPostgresCallSessionRepository,
  createPostgresCardFormAdmissionRepository,
  createPostgresCardRefreshRepository,
  createPostgresEmailSyncRepository,
  createPostgresGeneratedCardRepository,
  createPostgresModelCatalogRepository,
  createPostgresModelConnectionRepository,
  createPostgresRecallSurfacingRepository,
  createPostgresSelfRepairRepository,
  createPostgresTaskDiscoveryRepository,
  createPostgresToolExecutionRepository,
  type Db,
  documents,
  files,
  improvementProposals,
  skills,
  withPostgresPrivacyObservationFence,
} from '@assistant/db';
import {
  assertPrivacyErasureFenceUnchanged,
  createFirestoreCardFormAdmissionRepository,
  createFirestoreExecutionPersistence,
  createFirestoreProfileMemoryCommandPersistence,
  createFirestoreSettingsPersistence,
  createInstallationStore,
  FirestoreActiveJobLookup,
  FirestoreApplicationChatPersistence,
  FirestoreAuditInvestigationRepository,
  FirestoreCallSessionRepository,
  FirestoreCommitmentMutationRepository,
  FirestoreDeviceTokenRepository,
  FirestoreDocumentReadRepository,
  FirestoreEmailSyncRepository,
  FirestoreGoalMutationRepository,
  FirestoreImportCommandRepository,
  FirestoreImportOverviewRepository,
  FirestoreLocationPingRepository,
  FirestoreMcpConnectionMutationRepository,
  FirestoreModelCatalogRepository,
  FirestoreModelConnectionRepository,
  FirestoreOwnerKnowledgeGraphFactRepository,
  FirestoreRecallFeedbackRepository,
  FirestoreRecallSurfacingRepository,
  FirestoreSelfRepairRepository,
  FirestoreShellStatusRepository,
  FirestoreSkillMutationRepository,
  FirestoreTaskDiscoveryRepository,
  FirestoreToolExecutionRepository,
  FirestoreWorkspaceAnomalyRepository,
  FirestoreWorkspaceFileLookup,
  FirestoreWorkspaceImprovementRepository,
  getFirestoreClosedCommitmentOverview,
  getFirestoreMobilePeopleDirectoryPage,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { FirestoreSkillLibraryRepository } from '@assistant/firestore/skill-library';
import type { SelfRepairRepository } from '@assistant/persistence';
import {
  embeddingSpaceIdentityKey,
  POSTGRES_EMBEDDING_DIMENSIONS,
  type RecallSurfacingRepository,
  validateEmbedding,
} from '@assistant/persistence';
import type { CardFormSubmission } from '@assistant/persistence/card-form';
import { inspectMcpConnection } from '@assistant/tools/mcp';
import {
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import { unstable_cache } from 'next/cache';
import { cache } from 'react';
import {
  decodeMobileDocumentCursor,
  encodeMobileDocumentCursor,
  type MobileDocumentCursor,
} from './mobile-document-pages.js';
import { decodeMobilePeopleCursor, encodeMobilePeopleCursor } from './mobile-people-pages.js';
import {
  decodeMobileWorkspaceCursor,
  encodeMobileWorkspaceCursor,
  type MobileWorkspaceCursor,
  type MobileWorkspacePageSection,
} from './mobile-workspace-pages.js';

const globalCache = globalThis as unknown as {
  __assistantDb?: Db;
  __assistantRouter?: ModelRouter;
  __assistantWorkspace?: WorkspaceStore;
  __assistantApplication?: ReturnType<typeof createApplication>;
  __assistantFirestoreStore?: ReturnType<typeof createInstallationStore>;
};

/** Keep credential encryption behind the server-only application boundary. */
export function encryptMcpConnectionBearerToken(token: string): string {
  return encryptMcpBearerToken(token);
}

/**
 * Settings → AI providers, bound to whichever driver this installation runs.
 * Keys are sealed and opened here, inside the server-only boundary.
 */
export function getModelProviderPorts(): ModelProviderPorts {
  const config = loadConfig();
  const firestore = config.PERSISTENCE_DRIVER === 'firestore';
  return {
    connections: firestore
      ? new FirestoreModelConnectionRepository(getFirestoreInstallationStore())
      : createPostgresModelConnectionRepository(getDb()),
    catalog: firestore
      ? new FirestoreModelCatalogRepository(getFirestoreInstallationStore())
      : createPostgresModelCatalogRepository(getDb()),
    config,
    seal: encryptStoredCredential,
    open: decryptStoredCredential,
  };
}

/** Shared by the web Costs page and native workspace, with durable hourly snapshots. */
/**
 * A cache miss refreshes from OpenRouter and BigQuery, which can take ten
 * seconds. The phone's workspace payload feeds every secondary screen, so none
 * of them may wait on that: past this budget the last snapshot is served and
 * the refresh finishes into the cache for the next read.
 */
export const MOBILE_BILLING_REFRESH_BUDGET_MS = 2_000;

export function getBillingOverview(options: { refreshBudgetMs?: number } = {}) {
  const config = loadConfig();
  return getProviderBilling({
    config,
    ...(options.refreshBudgetMs === undefined ? {} : { refreshBudgetMs: options.refreshBudgetMs }),
    models: getModelProviderPorts(),
    cache:
      config.PERSISTENCE_DRIVER === 'firestore'
        ? new FirestoreToolExecutionRepository(getFirestoreInstallationStore())
        : createPostgresToolExecutionRepository(getDb()),
  });
}

/** Phone calls for the owner, on whichever driver this installation runs. */
export async function getCallsPorts(): Promise<CallsPorts> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore')
    return {
      calls: new FirestoreCallSessionRepository(
        getFirestoreInstallationStore(),
        config.FIRESTORE_AGENT_ID,
      ),
      agentId: config.FIRESTORE_AGENT_ID,
    };
  return {
    calls: createPostgresCallSessionRepository(getDb()),
    agentId: (await getAgent(getDb())).id,
  };
}

/** Reuse one Firestore client across requests in a web process. */
export function getFirestoreInstallationStore() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    throw new Error('Firestore installation store requires Firestore persistence');
  globalCache.__assistantFirestoreStore ??= createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  return globalCache.__assistantFirestoreStore;
}

/** Run guarded discovery through the shared SSRF-checked MCP transport. */
export async function discoverFirestoreMcpConnection(connectionId: string) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    return { error: 'Firestore MCP discovery requires Firestore persistence.' };
  const repository = new FirestoreMcpConnectionMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
  try {
    const connection = await repository.beginDiscovery(connectionId);
    if (!connection) return { error: 'MCP connection not found or disabled.' };
    const result = await inspectMcpConnection(connection.endpoint, {
      bearerTokenEncrypted: connection.bearerTokenEncrypted,
    });
    if (
      !(await repository.saveDiscovery(connectionId, connection.attemptId, {
        status: result.status,
        serverName: result.serverName ?? null,
        serverVersion: result.serverVersion ?? null,
        instructions: result.instructions ?? null,
        tools: result.tools,
        error: result.error ?? null,
      }))
    )
      return { error: 'MCP connection changed while discovery was running.' };
    return {
      connectionId,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'MCP discovery could not be completed.',
    };
  }
}

export function getFirestoreGoalScheduleUpdate(id: string, input: GoalInput) {
  return {
    cron: goalAutomationCadence(input).cron,
    instruction: goalAutomationInstruction({
      id,
      title: input.title,
      description: input.description,
      progress: input.progress,
      nextAction: input.nextAction,
      targetDate: input.targetDate,
    }),
  };
}

function goalWorkAutomation(goal: {
  id: string;
  title: string;
  description: string;
  priority: number;
  progress: string;
  nextAction: string;
  targetDate: Date | null;
}) {
  const cadence = goalAutomationCadence(goal);
  return {
    cron: cadence.cron,
    instruction: goalAutomationInstruction(goal),
    nextRunAt: (timezone: string) => nextRun(cadence.cron, timezone),
  };
}

function goalWorkResult(work: { conversationId: string; taskId: string; taskCreatedAt: Date }) {
  return {
    conversationId: work.conversationId,
    taskId: work.taskId,
    messageCursor: encodeMessageCursor({ createdAt: work.taskCreatedAt, id: work.taskId }),
  };
}

export async function createFirestoreGoalWithWork(input: GoalInput) {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const repository = new FirestoreGoalMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
  return goalWorkResult(await repository.createWithWork(input, goalWorkAutomation));
}

export async function startFirestoreGoalWork(id: string) {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const repository = new FirestoreGoalMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
  return goalWorkResult(await repository.startWork(id, goalWorkAutomation));
}

export function getDb(): Db {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    throw new Error('PostgreSQL-backed web surface is unavailable in Firestore mode');
  }
  const restoreProblems = validateRestoreRehearsalConfig(config);
  if (restoreProblems.length) throw new Error(restoreProblems.join('; '));
  if (!globalCache.__assistantDb) {
    globalCache.__assistantDb = createDb(config.DATABASE_URL, {
      max: config.DB_POOL_MAX,
      idleTimeoutSeconds: config.DB_IDLE_TIMEOUT_SECONDS,
      connectTimeoutSeconds: config.DB_CONNECT_TIMEOUT_SECONDS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      sourceWritesFenced: config.POSTGRES_SOURCE_WRITES_FENCED,
      readOnly: config.RESTORE_REHEARSAL,
    });
  }
  return globalCache.__assistantDb;
}

export function getEmailObligationRepository() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    return new FirestoreEmailSyncRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
  }
  return createPostgresEmailSyncRepository(getDb());
}

export function getGeneratedCards() {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    return getFirestoreChatApplication().getGeneratedCards();
  }
  return createPostgresGeneratedCardRepository(getDb());
}

export function getCardRefresh() {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    return getFirestoreChatApplication().getCardRefresh();
  }
  return createPostgresCardRefreshRepository(getDb());
}

export function getRouter(): ModelRouter {
  const config = loadConfig();
  if (!globalCache.__assistantRouter) {
    const connections = createPostgresModelConnectionRepository(getDb());
    globalCache.__assistantRouter = new ModelRouter(
      getDb(),
      config.OPENROUTER_API_KEY,
      config.LLM_AUDIT_CAPTURE,
      createConnectedModelProviders(config, () => connections.list()),
      undefined,
      POSTGRES_EMBEDDING_DIMENSIONS,
    );
  }
  return globalCache.__assistantRouter;
}

/**
 * The owner's timezone (from the agent row), for rendering local timestamps.
 * cache() dedupes it to one query per request across all server components.
 * Falls back to UTC if the agent can't be read.
 */
export const getAgentTimezone = cache(async (): Promise<string> => {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    try {
      return await getFirestoreChatApplication().getAgentTimezone();
    } catch {
      return 'UTC';
    }
  }
  return getAssistantTimezone(getDb());
});

/**
 * The assistant's display identity (agent row). The name is seed-owned — it
 * matches the bot's Google-account profile so email From headers agree — and
 * the dashboard displays it wherever the assistant "speaks".
 */
export const getAgentIdentity = cache(
  async (): Promise<{ id: string; name: string; avatarUrl: string | null }> => {
    if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
      return getFirestoreChatApplication().getAgentIdentity();
    }
    return getAssistantIdentity(getDb());
  },
);

/** Owner-scoped recall hide/allow controls for web and mobile transports. */
export async function getRecallSurfacingPorts(): Promise<{
  agentId: string;
  repository: RecallSurfacingRepository;
}> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    return {
      agentId: config.FIRESTORE_AGENT_ID,
      repository: new FirestoreRecallSurfacingRepository(getFirestoreInstallationStore()),
    };
  }
  const db = getDb();
  return {
    agentId: (await getAgent(db)).id,
    repository: createPostgresRecallSurfacingRepository(db),
  };
}

/** Same workspace identity the agent composition root uses. */
export function getWorkspace(): WorkspaceStore {
  if (!globalCache.__assistantWorkspace) {
    const config = loadConfig();
    globalCache.__assistantWorkspace =
      config.FILES_DRIVER === 'gcs'
        ? new GcsWorkspaceStore(
            config.WORKSPACE_BUCKET,
            `workspace/${config.ASSISTANT_WORKSPACE_ID}`,
          )
        : new LocalWorkspaceStore(
            config.RESTORE_REHEARSAL
              ? config.RESTORE_REHEARSAL_ROOT
              : path.join(repoRoot, '.workspace'),
          );
  }
  return globalCache.__assistantWorkspace;
}

/** Owner-scoped import history read used by initial pages and web continuations. */
export async function getCurrentImportOverview(input?: {
  sourceCursor?: string | null;
  filesCursor?: string | null;
  limit?: number;
}) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return getApplication().getImports(input);
  const store = getFirestoreInstallationStore();
  const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
  const overview = await getImportOverview(
    new FirestoreImportOverviewRepository(store, config.FIRESTORE_AGENT_ID),
    getWorkspace(),
    input,
  );
  await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
  return overview;
}

/**
 * Bound application use-cases for the Next.js transport layer. Pages, route
 * handlers, and server actions call this facade instead of reaching into
 * persistence, model routing, or workspace adapters themselves.
 */
function createApplication(options: { profileMemory?: ProfileMemoryCommandPersistence } = {}) {
  const db = getDb();
  const memoryCommands = profileMemoryCommands(options.profileMemory ?? db, {
    embed: (texts) => getRouter().embed(texts),
    embedWithIdentity: async (texts) => {
      const result = await getRouter().embedWithIdentity(texts);
      return { embeddings: result.embeddings, embeddingSpaceKey: result.spaceKey };
    },
  });
  const workspace = getWorkspace();
  const refreshMcpConnection = async (connectionId: string) => {
    const current = await getMcpConnection(db, connectionId);
    if (!current) return { error: 'MCP connection not found.' };
    const discovery = await inspectMcpConnection(current.endpoint, {
      bearerTokenEncrypted: current.bearerTokenEncrypted,
    });
    if (!(await saveMcpDiscovery(db, connectionId, discovery))) {
      return { error: 'MCP connection not found.' };
    }
    return { connectionId, ...discovery };
  };
  return {
    ...memoryCommands,
    listAnomalies: () => listAnomalies(db),
    dismissAnomaly: (id: string) => dismissAnomalyRecord(db, id),
    suspendAnomaly: (id: string) => suspendAnomalyRecord(db, id),
    listImprovementProposals: () => listImprovementProposals(db),
    applyImprovementProposal: (id: string) => applyImprovementProposal(db, id),
    dismissImprovementProposal: (id: string) => dismissImprovementProposal(db, id),
    listSkills: () => listAssistantSkills(db),
    addSkill: (input: { name: string; preconditions: string; steps: string; gotchas: string }) =>
      addAssistantSkill(db, getRouter(), input),
    editSkill: (
      id: string,
      patch: { name: string; preconditions: string; steps: string; gotchas: string },
    ) => editAssistantSkill(db, getRouter(), id, patch),
    deleteSkill: (id: string) => deleteAssistantSkill(db, id),
    setSkillDeprecated: (id: string, deprecated: boolean) =>
      setAssistantSkillDeprecated(db, id, deprecated),
    listMcpConnections: () => listMcpConnections(db),
    addMcpConnection: async (input: { name: string; endpoint: string; bearerToken?: string }) => {
      const created = await createMcpConnection(db, input);
      if (!created.connectionId) return created;
      return refreshMcpConnection(created.connectionId);
    },
    refreshMcpConnection,
    setMcpConnectionEnabled: async (id: string, enabled: boolean) => {
      if (!(await setMcpConnectionEnabled(db, id, enabled)))
        return { error: 'MCP connection not found.' };
      return enabled ? refreshMcpConnection(id) : { connectionId: id, status: 'disabled' as const };
    },
    deleteMcpConnection: (id: string) => deleteMcpConnection(db, id),
    getSettings: () => getSettingsOverview(db),
    getProfileOverview: () => getProfileOverview(db),
    getCostsDashboard: () => getCostsDashboard(db),
    getProactiveHealth: () => getProactiveHealth(db),
    updateSettings: (input: { timezone: string; locale: string; signature: string }) =>
      updateAssistantSettings(db, input),
    updateNotificationPrefs: (input: {
      quietStart: string;
      quietEnd: string;
      ambientDailyCap: string;
    }) => updateNotificationPrefs(db, input),
    setScheduleEnabled: (id: string, enabled: boolean) => setRecurringJobEnabled(db, id, enabled),
    deleteReminder: (id: string) => deleteReminder(db, id),
    setPolicyEnabled: (id: string, enabled: boolean) => setApprovalPolicyEnabled(db, id, enabled),
    deletePolicy: (id: string) => deleteApprovalPolicy(db, id),
    getDocuments: () => getDocumentsOverview(db),
    getWorkspacePage: (input: WorkspacePageRequest) => queryPostgresWorkspacePage(db, input),
    getDocument: (id: string, options?: Parameters<typeof getDocument>[2]) =>
      getDocument(db, id, options),
    deleteDocument: (id: string) => deleteDocument(db, workspace, id),
    uploadDocument: (input: { name: string; title?: string; mime?: string; bytes: Buffer }) =>
      uploadDocument(db, workspace, input),
    downloadArtifact: (path: string) => downloadArtifact(db, workspace, path),
    exportLongTermMemoryData: () => exportLongTermMemoryData(db),
    forgetLongTermMemory: () => forgetLongTermMemory(db, workspace),
    getImports: (input?: {
      sourceCursor?: string | null;
      filesCursor?: string | null;
      limit?: number;
    }) => getImportOverview(db, workspace, input),
    startImport: (path: string, source: string) =>
      startWorkspaceImport(db, workspace, path, source),
    purgeImport: (source: string) => purgeImportedSource(db, source),
    deleteImport: (source: string) => deleteImportedSource(db, workspace, source),
    reviewImport: (source: string, verdict: 'approve' | 'reject') =>
      reviewImportedSource(db, source, verdict),
    uploadImport: (input: {
      fileName: string;
      content: string;
      source?: string;
      voice?: boolean;
      register?: string;
    }) => uploadImport(db, workspace, input),
    getPrimaryConversationId: () => getPrimaryConversationId(db),
    recordOwnerLocationPing: (body: unknown) => recordOwnerLocationPing(db, body),
    registerDeviceToken: (body: unknown) => registerDeviceToken(db, body),
    recordOwnerForeground: () => recordOwnerForeground(db),
    recordRecallFeedback: (messageId: string, verdict: 'helpful' | 'not_helpful') =>
      recordRecallFeedback(db, messageId, verdict),
    listActivity: (input: {
      archived: boolean;
      filter: 'all' | 'needs-you' | 'working' | 'scheduled' | 'completed';
      limit?: number;
    }) => listActivity(db, input),
    listCommitments: () => listCommitmentOverview(db),
    listClosedCommitments: () => listClosedCommitmentOverview(db),
    reopenCommitment: (id: string, expectedUpdatedAt: Date, operationId: string) =>
      reopenOwnerCommitment(db, id, expectedUpdatedAt, operationId),
    resolveCommitment: (id: string, resolution: string) =>
      resolveOwnerCommitment(db, id, resolution),
    snoozeCommitment: (id: string, until: Date) => snoozeOwnerCommitment(db, id, until),
    dismissCommitment: (id: string) => dismissOwnerCommitment(db, id),
    correctCommitment: (
      id: string,
      patch: { title: string; details?: string; nextAction?: string },
    ) => correctOwnerCommitment(db, id, patch),
    listGoals: (archived: boolean) => listGoalsDashboard(db, archived),
    listApprovals: () => listApprovalInbox(db),
    decideApproval: (approvalId: string, decision: 'approved' | 'denied') =>
      decideApproval(db, approvalId, decision),
    // The layout calls this on every request of every route (force-dynamic),
    // and memory health aggregates the whole knowledge-memory table. A sidebar
    // badge does not need transactional freshness; 30 seconds keeps the scan
    // off the per-navigation path as the table grows.
    getShellStatus: (agentId: string) =>
      unstable_cache(() => getShellStatus(db, agentId), ['shell-status', agentId], {
        revalidate: 30,
      })(),
    createChat: () => createChatConversation(db),
    changeChatModel: (conversationId: string, modelId: string | null) =>
      changeChatModel(db, conversationId, modelId),
    archiveChat: (conversationId: string) => archiveChatConversation(db, conversationId),
    restoreChat: (conversationId: string) => restoreChatConversation(db, conversationId),
    hideChatMessage: (conversationId: string, messageId: string) =>
      hideChatMessage(db, conversationId, messageId),
    unhideChatMessage: (conversationId: string, messageId: string) =>
      unhideChatMessage(db, conversationId, messageId),
    acknowledgeMessageDelivery: (conversationId: string, messageId: string, clientId: string) =>
      acknowledgeChatMessageDelivery(db, conversationId, messageId, clientId),
    archiveInactiveChats: () => archiveInactiveChats(db),
    listChatHistory: (archived: boolean) => listChatHistory(db, archived),
    getChatConversation: (conversationId: string, input: { taskId?: string; cursor?: string }) =>
      getChatConversationView(db, conversationId, input),
    getChatUpdates: (input: {
      conversationId: string;
      taskId?: string;
      cursor?: string;
      pageSize?: number;
      refreshIds?: string[];
      /** Hold the poll open for up to this long rather than answering "nothing yet". */
      waitMs?: number;
      /** The request's own signal, so a client that hangs up ends the hold. */
      signal?: AbortSignal;
    }) => waitForChatUpdates(db, input),
    submitCardForm: async (submission: CardFormSubmission) => {
      const agent = await getAgent(db);
      const admission = createCardFormAdmissionService(
        createPostgresCardFormAdmissionRepository(db),
      );
      const result = await admission.submit({ agentId: agent.id, submission });
      if (!result.ok) return result;
      const rows = await createPostgresApplicationChatPersistence(db).listMessagesByIds(
        agent.id,
        submission.conversationId,
        [result.messageId],
      );
      const message = rows?.find((row) => row.id === result.messageId);
      if (!message) throw new Error('Admitted form message could not be read back');
      return {
        ...result,
        messageCursor: encodeMessageCursor({ createdAt: message.createdAt, id: message.id }),
      };
    },
    isValidChatCursor,
    cancelChatTurn: (input: { conversationId: string; clientOperationId: string }) =>
      cancelChatTurn(db, input),
    handleChatTurn: (request: Request) =>
      handleChatTurn(request, { config: loadConfig(), db, router: getRouter() }),
    checkReadiness: () => checkReadiness(db),
  };
}

export function getApplication(): ReturnType<typeof createApplication> {
  globalCache.__assistantApplication ??= createApplication();
  return globalCache.__assistantApplication;
}

async function queryPostgresMobileDocumentPage(
  db: Db,
  input: { ownerId: string; limit: number; after?: MobileDocumentCursor },
) {
  const agent = await getAgent(db);
  if (agent.id !== input.ownerId) throw new Error('Document read is outside the configured owner');
  const afterDate = input.after ? new Date(input.after.createdAt) : undefined;
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      mime: documents.mime,
      source: documents.source,
      trust: documents.trust,
      status: documents.status,
      extractor: documents.extractor,
      extractionMetadata: documents.extractionMetadata,
      chunkCount: documents.chunkCount,
      charCount: documents.charCount,
      bytes: files.bytes,
      error: documents.error,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(
      and(
        eq(documents.agentId, input.ownerId),
        eq(files.agentId, input.ownerId),
        input.after && afterDate
          ? or(
              lt(documents.createdAt, afterDate),
              and(eq(documents.createdAt, afterDate), lt(documents.id, input.after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(input.limit + 1);
  const primary = await getOrCreatePrimaryConversation(db, input.ownerId);
  const stats = await documentStats(db, input.ownerId);
  const selected = rows.slice(0, input.limit).map((row) => ({ ...row, bytes: row.bytes ?? 0 }));
  const tail = selected.at(-1);
  const hasMore = rows.length > input.limit;
  return {
    documents: selected,
    stats,
    primaryConversationId: primary.id,
    hasMore,
    nextCursor:
      hasMore && tail
        ? encodeMobileDocumentCursor({
            version: 1,
            ownerId: input.ownerId,
            id: tail.id,
            createdAt: tail.createdAt.toISOString(),
          })
        : null,
  };
}

async function queryFirestoreMobileDocumentPage(
  ownerId: string,
  limit: number,
  after?: MobileDocumentCursor,
) {
  const page = await new FirestoreDocumentReadRepository(
    getFirestoreInstallationStore(),
    ownerId,
  ).listPage(ownerId, {
    limit,
    ...(after ? { after: { id: after.id, createdAt: new Date(after.createdAt) } } : {}),
  });
  return {
    documents: page.documents,
    stats: page.stats,
    primaryConversationId: page.primaryConversationId,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
      ? encodeMobileDocumentCursor({
          version: 1,
          ownerId,
          id: page.nextCursor.id,
          createdAt: page.nextCursor.createdAt.toISOString(),
        })
      : null,
  };
}

/** Server composition for the bounded mobile document read, including its privacy fence. */
export async function getMobileDocumentsPage(input: { limit: number; cursor: string | null }) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const ownerId = config.FIRESTORE_AGENT_ID;
    const after = input.cursor ? decodeMobileDocumentCursor(input.cursor, ownerId) : undefined;
    const page = await queryFirestoreMobileDocumentPage(ownerId, input.limit, after);
    return page;
  }
  const db = getDb();
  const ownerId = (await getAgent(db)).id;
  const after = input.cursor ? decodeMobileDocumentCursor(input.cursor, ownerId) : undefined;
  const page = await withPostgresPrivacyObservationFence(db, ownerId, () =>
    queryPostgresMobileDocumentPage(db, {
      ownerId,
      limit: input.limit,
      ...(after ? { after } : {}),
    }),
  );
  return page;
}

/** Server composition for the bounded mobile people read. */
export async function getMobilePeoplePage(input: { limit: number; cursor: string | null }) {
  const config = loadConfig();
  const now = new Date();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const ownerId = config.FIRESTORE_AGENT_ID;
    const after = input.cursor ? decodeMobilePeopleCursor(input.cursor, ownerId) : undefined;
    const page = await getFirestoreMobilePeopleDirectoryPage(
      getFirestoreInstallationStore(),
      ownerId,
      now,
      GRAPH_EXTRACTION_VERSION,
      { limit: input.limit, ...(after ? { after: { name: after.name, id: after.id } } : {}) },
    );
    return {
      people: page.people.map((row) => personSummaryFromStoredRow(row, now)),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor
        ? encodeMobilePeopleCursor({ version: 1, ownerId, ...page.nextCursor })
        : null,
      generatedAt: now.toISOString(),
    };
  }
  const db = getDb();
  const ownerId = (await getAgent(db)).id;
  const after = input.cursor ? decodeMobilePeopleCursor(input.cursor, ownerId) : undefined;
  const page = await withPostgresPrivacyObservationFence(db, ownerId, () =>
    listPeopleDirectoryPage(db, {
      now,
      limit: input.limit,
      ...(after ? { after: { name: after.name, id: after.id } } : {}),
    }),
  );
  return {
    people: page.people,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
      ? encodeMobilePeopleCursor({ version: 1, ownerId, ...page.nextCursor })
      : null,
    generatedAt: now.toISOString(),
  };
}

type WorkspacePageRequest = {
  section: MobileWorkspacePageSection;
  ownerId: string;
  after?: MobileWorkspaceCursor;
  archived: boolean;
  limit: number;
};

function workspaceConversationCursor(after: MobileWorkspaceCursor | undefined) {
  return after?.updatedAt ? { id: after.afterId, updatedAt: new Date(after.updatedAt) } : undefined;
}

async function queryPostgresWorkspacePage(db: Db, input: WorkspacePageRequest) {
  if (input.section === 'import-sources' || input.section === 'import-files') {
    const overview = await getImportOverview(db, getWorkspace(), {
      ...(input.section === 'import-sources' ? { sourceCursor: input.after?.afterId ?? null } : {}),
      ...(input.section === 'import-files' ? { filesCursor: input.after?.afterId ?? null } : {}),
      limit: input.limit,
    });
    const isSources = input.section === 'import-sources';
    const availability = isSources ? overview.sourceAvailability : overview.filesAvailability;
    if (availability.status !== 'available')
      throw new Error(availability.message ?? 'Import section unavailable');
    const next = isSources
      ? overview.sourcePagination.nextCursor
      : overview.filesPagination.nextCursor;
    return {
      consistency: isSources
        ? overview.sourcePagination.consistency
        : overview.filesPagination.consistency,
      items: isSources
        ? overview.sources.map((source) => ({
            id: source.id,
            source: source.source,
            workspacePath: source.workspacePath,
            kind: source.kind,
            status: source.status,
            itemsTotal: source.itemsTotal,
            itemsProcessed: source.itemsProcessed,
            memoriesSaved: source.memoriesSaved,
            quarantinedNow: overview.quarantineBySource[source.source] ?? 0,
            taskId: source.taskId,
            error: source.error,
            updatedAt: source.updatedAt.toISOString(),
          }))
        : overview.unstartedFiles,
      hasMore: isSources ? overview.sourcePagination.hasMore : overview.filesPagination.hasMore,
      nextCursor:
        next !== null
          ? encodeMobileWorkspaceCursor({
              version: 1,
              section: input.section,
              ownerId: input.ownerId,
              afterId: next,
            })
          : null,
    };
  }
  if (input.section === 'chats') {
    const chat = createPostgresApplicationChatPersistence(db);
    const page = await chat.listConversations(input.ownerId, {
      archived: input.archived,
      limit: input.limit,
      ...(workspaceConversationCursor(input.after)
        ? { after: workspaceConversationCursor(input.after) }
        : {}),
    });
    const active = new Set(await chat.listActiveConversationIds(input.ownerId));
    const tail = page.nextCursor;
    return {
      items: page.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        isPrimary: conversation.isPrimary,
        updatedAt: conversation.updatedAt,
        active: active.has(conversation.id),
      })),
      hasMore: page.hasMore,
      nextCursor: tail
        ? encodeMobileWorkspaceCursor({
            version: 1,
            section: 'chats',
            ownerId: input.ownerId,
            archived: input.archived,
            afterId: tail.id,
            updatedAt: tail.updatedAt.toISOString(),
          })
        : null,
    };
  }
  if (input.section === 'skills') {
    const rows = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.agentId, input.ownerId),
          input.after ? gt(skills.id, input.after.afterId) : undefined,
        ),
      )
      .orderBy(asc(skills.id))
      .limit(input.limit + 1);
    const items = rows
      .slice(0, input.limit)
      .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
    const hasMore = rows.length > input.limit;
    const tail = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && tail
          ? encodeMobileWorkspaceCursor({
              version: 1,
              section: 'skills',
              ownerId: input.ownerId,
              afterId: tail.id,
            })
          : null,
    };
  }
  if (input.section === 'anomalies') {
    const rows = await db
      .select()
      .from(anomalies)
      .where(
        and(
          eq(anomalies.agentId, input.ownerId),
          eq(anomalies.status, 'open'),
          input.after ? gt(anomalies.id, input.after.afterId) : undefined,
        ),
      )
      .orderBy(asc(anomalies.id))
      .limit(input.limit + 1);
    const items = rows.slice(0, input.limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      toolName: row.toolName,
      detail: row.detail,
      observed: row.observed,
      expected: row.expected,
      citationCount: row.toolCallIds.length,
      hasPolicy: row.policyId !== null,
      createdAt: row.createdAt.toISOString(),
    }));
    const hasMore = rows.length > input.limit;
    const tail = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && tail
          ? encodeMobileWorkspaceCursor({
              version: 1,
              section: 'anomalies',
              ownerId: input.ownerId,
              afterId: tail.id,
            })
          : null,
    };
  }
  const rows = await db
    .select()
    .from(improvementProposals)
    .where(
      and(
        eq(improvementProposals.agentId, input.ownerId),
        eq(improvementProposals.status, 'open'),
        input.after ? gt(improvementProposals.id, input.after.afterId) : undefined,
      ),
    )
    .orderBy(asc(improvementProposals.id))
    .limit(input.limit + 1);
  const items = rows.slice(0, input.limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    rationale: row.rationale,
    suggestion:
      typeof (row.change as { suggestion?: unknown } | null)?.suggestion === 'string'
        ? (row.change as { suggestion: string }).suggestion
        : '',
    evidenceCount: row.evidenceIds.length,
    applyable: row.kind === 'model_role',
    createdAt: row.createdAt.toISOString(),
  }));
  const hasMore = rows.length > input.limit;
  const tail = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && tail
        ? encodeMobileWorkspaceCursor({
            version: 1,
            section: 'improvements',
            ownerId: input.ownerId,
            afterId: tail.id,
          })
        : null,
  };
}

async function queryFirestoreWorkspacePage(
  store: ReturnType<typeof getFirestoreInstallationStore>,
  input: WorkspacePageRequest,
) {
  if (input.section === 'import-sources' || input.section === 'import-files') {
    const overview = await getImportOverview(
      new FirestoreImportOverviewRepository(store, input.ownerId),
      getWorkspace(),
      {
        ...(input.section === 'import-sources'
          ? { sourceCursor: input.after?.afterId ?? null }
          : {}),
        ...(input.section === 'import-files' ? { filesCursor: input.after?.afterId ?? null } : {}),
        limit: input.limit,
      },
    );
    const isSources = input.section === 'import-sources';
    const availability = isSources ? overview.sourceAvailability : overview.filesAvailability;
    if (availability.status !== 'available')
      throw new Error(availability.message ?? 'Import section unavailable');
    const next = isSources
      ? overview.sourcePagination.nextCursor
      : overview.filesPagination.nextCursor;
    return {
      consistency: isSources
        ? overview.sourcePagination.consistency
        : overview.filesPagination.consistency,
      items: isSources
        ? overview.sources.map((source) => ({
            id: source.id,
            source: source.source,
            workspacePath: source.workspacePath,
            kind: source.kind,
            status: source.status,
            itemsTotal: source.itemsTotal,
            itemsProcessed: source.itemsProcessed,
            memoriesSaved: source.memoriesSaved,
            quarantinedNow: overview.quarantineBySource[source.source] ?? 0,
            taskId: source.taskId,
            error: source.error,
            updatedAt: source.updatedAt.toISOString(),
          }))
        : overview.unstartedFiles,
      hasMore: isSources ? overview.sourcePagination.hasMore : overview.filesPagination.hasMore,
      nextCursor:
        next !== null
          ? encodeMobileWorkspaceCursor({
              version: 1,
              section: input.section,
              ownerId: input.ownerId,
              afterId: next,
            })
          : null,
    };
  }
  if (input.section === 'chats') {
    const chat = new FirestoreApplicationChatPersistence(store);
    const page = await chat.listConversations(input.ownerId, {
      archived: input.archived,
      limit: input.limit,
      ...(workspaceConversationCursor(input.after)
        ? { after: workspaceConversationCursor(input.after) }
        : {}),
    });
    const active = new Set(await chat.listActiveConversationIds(input.ownerId));
    const tail = page.nextCursor;
    return {
      items: page.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        isPrimary: conversation.isPrimary,
        updatedAt: conversation.updatedAt,
        active: active.has(conversation.id),
      })),
      hasMore: page.hasMore,
      nextCursor: tail
        ? encodeMobileWorkspaceCursor({
            version: 1,
            section: 'chats',
            ownerId: input.ownerId,
            archived: input.archived,
            afterId: tail.id,
            updatedAt: tail.updatedAt.toISOString(),
          })
        : null,
    };
  }
  const pageInput = { afterId: input.after?.afterId, limit: input.limit };
  if (input.section === 'skills') {
    const page = await new FirestoreSkillLibraryRepository(store).listPage(
      input.ownerId,
      pageInput,
    );
    return {
      items: page.items.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor
        ? encodeMobileWorkspaceCursor({
            version: 1,
            section: 'skills',
            ownerId: input.ownerId,
            afterId: page.nextCursor,
          })
        : null,
    };
  }
  if (input.section === 'anomalies') {
    const page = await new FirestoreWorkspaceAnomalyRepository(store).listOpenPage(
      input.ownerId,
      pageInput,
    );
    return {
      items: page.items.map((row) => ({
        id: row.id,
        kind: row.kind,
        toolName: row.toolName,
        detail: row.detail,
        observed: row.observed,
        expected: row.expected,
        citationCount: row.toolCallIds.length,
        hasPolicy: row.policyId !== null,
        createdAt: row.createdAt.toISOString(),
      })),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor
        ? encodeMobileWorkspaceCursor({
            version: 1,
            section: 'anomalies',
            ownerId: input.ownerId,
            afterId: page.nextCursor,
          })
        : null,
    };
  }
  const page = await new FirestoreWorkspaceImprovementRepository(store).listOpenPage(
    input.ownerId,
    pageInput,
  );
  return {
    items: page.items.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      rationale: row.rationale,
      suggestion: typeof row.change.suggestion === 'string' ? row.change.suggestion : '',
      evidenceCount: row.evidenceIds.length,
      applyable: row.kind === 'model_role',
      createdAt: row.createdAt.toISOString(),
    })),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
      ? encodeMobileWorkspaceCursor({
          version: 1,
          section: 'improvements',
          ownerId: input.ownerId,
          afterId: page.nextCursor,
        })
      : null,
  };
}

export async function getMobileWorkspaceSectionPage(input: {
  section: MobileWorkspacePageSection;
  archived: boolean;
  limit: number;
  cursor: string | null;
}) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const ownerId = config.FIRESTORE_AGENT_ID;
    const after = input.cursor
      ? decodeMobileWorkspaceCursor(input.cursor, {
          section: input.section,
          ownerId,
          ...(input.section === 'chats' ? { archived: input.archived } : {}),
        })
      : undefined;
    const store = getFirestoreInstallationStore();
    const fence = await readPrivacyErasureFence(store, ownerId);
    const page = await queryFirestoreWorkspacePage(store, {
      ...input,
      ownerId,
      ...(after ? { after } : {}),
    });
    await assertPrivacyErasureFenceUnchanged(store, ownerId, fence);
    return page;
  }
  const db = getDb();
  const ownerId = (await getAgent(db)).id;
  const after = input.cursor
    ? decodeMobileWorkspaceCursor(input.cursor, {
        section: input.section,
        ownerId,
        ...(input.section === 'chats' ? { archived: input.archived } : {}),
      })
    : undefined;
  if (input.section === 'import-sources' || input.section === 'import-files') {
    // getImportOverview owns one bounded owner/privacy-fenced transaction for
    // both independently paged streams. Wrapping the same read here would open
    // a second transaction that waits on its own owner-row lock.
    return queryPostgresWorkspacePage(db, { ...input, ownerId, ...(after ? { after } : {}) });
  }
  return withPostgresPrivacyObservationFence(db, ownerId, () =>
    queryPostgresWorkspacePage(db, { ...input, ownerId, ...(after ? { after } : {}) }),
  );
}

export async function withPostgresMobileWorkspaceRead<T>(
  read: (context: {
    ownerId: string;
    application: ReturnType<typeof createApplication>;
  }) => Promise<T>,
): Promise<T> {
  const db = getDb();
  const ownerId = (await getAgent(db)).id;
  return withPostgresPrivacyObservationFence(db, ownerId, () =>
    read({ ownerId, application: getApplication() }),
  );
}

/** Portable chat operations exposed to web and mobile transports in Firestore mode. */
function createFirestoreChatApplication() {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = getFirestoreInstallationStore();
  const persistence = createFirestoreExecutionPersistence(
    store,
    config.FIRESTORE_AGENT_ID,
    parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
  );
  const embeddingSpace = parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE);
  const chat = new FirestoreApplicationChatPersistence(store, config.FIRESTORE_AGENT_ID);
  const recallFeedback = new FirestoreRecallFeedbackRepository(store);
  const shellStatus = new FirestoreShellStatusRepository(store, config.FIRESTORE_AGENT_ID);
  const modelConnections = new FirestoreModelConnectionRepository(store);
  const router = new ModelRouter(
    persistence.modelRouting,
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConnectedModelProviders(config, () => modelConnections.list()),
    embeddingSpace,
  );
  const ownerGraphFacts = new FirestoreOwnerKnowledgeGraphFactRepository(
    store,
    embeddingSpace,
    config.FIRESTORE_AGENT_ID,
  );
  const ownerGraphEmbedding = {
    embed: (texts: string[]) => router.embed(texts, { expectedSpace: embeddingSpace }),
    embeddingSpace: async () => embeddingSpace,
  };
  const locationPings = new FirestoreLocationPingRepository(store);
  const imports: ImportCommandPersistence = {
    kind: 'import-command-persistence',
    imports: new FirestoreImportCommandRepository(store, config.FIRESTORE_AGENT_ID),
    ownerCards: persistence.ownerCardCompilation,
  };
  const deviceTokens = new FirestoreDeviceTokenRepository(store);
  const memoryCommands = createProfileMemoryCommands(
    createFirestoreProfileMemoryCommandPersistence(store, embeddingSpace),
    {
      embed: async (texts: string[]) => {
        const vectors = await router.embed(texts, {
          expectedSpace: embeddingSpace,
        });
        for (const vector of vectors) validateEmbedding(embeddingSpace, vector);
        return vectors;
      },
      embedWithIdentity: async (texts: string[]) => ({
        embeddings: await router.embed(texts, { expectedSpace: embeddingSpace }),
        embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
      }),
    },
  );
  const commitments = new FirestoreCommitmentMutationRepository(store, config.FIRESTORE_AGENT_ID);
  const chatReads = { chat, generatedCards: persistence.generatedCards };
  const settings = createFirestoreSettingsPersistence(store, config.FIRESTORE_AGENT_ID);
  const skillMutations = new FirestoreSkillMutationRepository(store, embeddingSpace);
  const skillEmbeddingText = (input: {
    name: string;
    preconditions: string;
    steps: string;
    gotchas: string;
  }) =>
    [
      input.name,
      input.preconditions && `When: ${input.preconditions}`,
      input.steps && `Steps: ${input.steps}`,
      input.gotchas && `Gotchas: ${input.gotchas}`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);
  const embedSkillText = async (text: string): Promise<number[]> => {
    const [vector] = await router.embed([text], {
      expectedSpace: embeddingSpace,
    });
    const result = vector ?? [];
    validateEmbedding(embeddingSpace, result);
    return result;
  };
  const embedSkill = async (input: {
    name: string;
    preconditions: string;
    steps: string;
    gotchas: string;
  }) => {
    return embedSkillText(skillEmbeddingText(input));
  };
  return {
    recordOwnerLocationPing: async (body: unknown) => {
      const agent = await chat.resolveAgent();
      return recordOwnerLocationPingWithRepository(
        locationPings,
        persistence.tasks,
        { id: agent.id, timezone: agent.timezone || 'UTC' },
        body,
      );
    },
    organizeMemoryNow: () =>
      organizeMemoryNowWithRepository(
        new FirestoreActiveJobLookup(store),
        persistence.tasks,
        config.FIRESTORE_AGENT_ID,
      ),
    registerDeviceToken: (body: unknown) =>
      registerDeviceTokenWithRepository(deviceTokens, config.FIRESTORE_AGENT_ID, body),
    checkReadiness: () =>
      checkReadinessWithProbe(async () => {
        const agents = await store.collection('agents').limit(2).get();
        return agents.size === 1 && agents.docs[0]?.get('id') === config.FIRESTORE_AGENT_ID;
      }),
    ...memoryCommands,
    resolveCommitment: (id: string, resolution: string) => commitments.resolve(id, resolution),
    listClosedCommitments: () =>
      getFirestoreClosedCommitmentOverview(store, config.FIRESTORE_AGENT_ID),
    reopenCommitment: (id: string, expectedUpdatedAt: Date, operationId: string) =>
      commitments.reopen(id, expectedUpdatedAt, operationId),
    snoozeCommitment: (id: string, until: Date) => commitments.snooze(id, until),
    dismissCommitment: (id: string) => commitments.dismiss(id),
    correctCommitment: (
      id: string,
      patch: { title: string; details?: string; nextAction?: string },
    ) =>
      commitments.correct(id, {
        title: patch.title,
        details: patch.details ?? '',
        nextAction: patch.nextAction ?? '',
      }),
    addOwnerKnowledgeGraphFact: (input: {
      subjectLabel: string;
      subjectKind: string;
      subjectId?: string;
      subjectContactId?: string;
      predicate: string;
      objectLabel: string;
      objectKind: string;
      objectId?: string;
      note: string;
    }) => addOwnerKnowledgeGraphFactFromRepository(ownerGraphFacts, ownerGraphEmbedding, input),
    correctOwnerKnowledgeGraphFact: (
      relationId: string,
      input: Parameters<typeof correctOwnerKnowledgeGraphFactFromRepository>[3],
    ) =>
      correctOwnerKnowledgeGraphFactFromRepository(
        ownerGraphFacts,
        ownerGraphEmbedding,
        relationId,
        input,
      ),
    embedSkillText,
    startImport: (path: string, source: string) =>
      startWorkspaceImport(imports, getWorkspace(), path, source),
    purgeImport: (source: string) => purgeImportedSource(imports, source),
    deleteImport: (source: string) => deleteImportedSource(imports, getWorkspace(), source),
    reviewImport: (source: string, verdict: 'approve' | 'reject') =>
      reviewImportedSource(imports, source, verdict),
    uploadImport: (input: Parameters<typeof uploadImport>[2]) =>
      uploadImport(imports, getWorkspace(), input),
    getWorkspaceSettings: () => getSettingsOverview(settings),
    addSkill: async (input: {
      name: string;
      preconditions: string;
      steps: string;
      gotchas: string;
    }) => {
      const normalized = {
        name: input.name.trim().slice(0, 200),
        preconditions: input.preconditions.trim(),
        steps: input.steps.trim(),
        gotchas: input.gotchas.trim(),
      };
      if (!normalized.name) return { error: 'Give the skill a name.' };
      if (!normalized.steps) return { error: 'Describe the steps.' };
      try {
        const embedding = await embedSkill(normalized);
        await skillMutations.saveOwner(config.FIRESTORE_AGENT_ID, normalized, embedding);
        return {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
      }
    },
    editSkill: async (
      id: string,
      input: { name: string; preconditions: string; steps: string; gotchas: string },
    ) => {
      const normalized = {
        name: input.name.trim().slice(0, 200),
        preconditions: input.preconditions.trim(),
        steps: input.steps.trim(),
        gotchas: input.gotchas.trim(),
      };
      if (!normalized.name || !normalized.steps) return { error: 'Name and steps are required.' };
      try {
        const embedding = await embedSkill(normalized);
        await skillMutations.editOwner(config.FIRESTORE_AGENT_ID, id, normalized, embedding);
        return {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
      }
    },
    deleteSkill: (id: string) => skillMutations.delete(config.FIRESTORE_AGENT_ID, id),
    setSkillDeprecated: (id: string, deprecated: boolean) =>
      skillMutations.setDeprecated(config.FIRESTORE_AGENT_ID, id, deprecated),
    getGeneratedCards: () => persistence.generatedCards,
    getCardRefresh: () => persistence.cardRefresh,
    getAgentIdentity: async () => {
      const agent = await chat.resolveAgent();
      return { id: agent.id, name: agent.name || 'Assistant', avatarUrl: agent.avatarUrl ?? null };
    },
    getAgentTimezone: async () => (await chat.resolveAgent()).timezone || 'UTC',
    getShellStatus: (agentId: string) =>
      unstable_cache(
        () => getShellStatus(shellStatus, agentId),
        ['firestore-shell-status', config.GCP_PROJECT, config.ASSISTANT_WORKSPACE_ID, agentId],
        { revalidate: 30 },
      )(),
    getPrimaryConversationId: () => getPrimaryConversationId(chat),
    createChat: () => createChatConversation(chat),
    changeChatModel: (conversationId: string, modelId: string | null) =>
      changeChatModel(chat, conversationId, modelId),
    archiveChat: (conversationId: string) => archiveChatConversation(chat, conversationId),
    restoreChat: (conversationId: string) => restoreChatConversation(chat, conversationId),
    hideChatMessage: (conversationId: string, messageId: string) =>
      hideChatMessage(chat, conversationId, messageId),
    unhideChatMessage: (conversationId: string, messageId: string) =>
      unhideChatMessage(chat, conversationId, messageId),
    acknowledgeMessageDelivery: (conversationId: string, messageId: string, clientId: string) =>
      acknowledgeChatMessageDelivery(chat, conversationId, messageId, clientId),
    archiveInactiveChats: () => archiveInactiveChats(chat),
    listChatHistory: (archived: boolean) => listChatHistory(chat, archived),
    getChatConversation: (conversationId: string, input: { taskId?: string; cursor?: string }) =>
      getChatConversationView(chatReads, conversationId, input),
    cancelChatTurn: (input: { conversationId: string; clientOperationId: string }) =>
      cancelChatTurn(chat, input),
    handleChatTurn: (request: Request) =>
      handleChatTurn(request, { config, router, chat, persistence }),
    getChatUpdates: (input: Parameters<typeof waitForChatUpdates>[1]) =>
      waitForChatUpdates(chatReads, input),
    submitCardForm: async (submission: CardFormSubmission) => {
      const admission = createCardFormAdmissionService(
        createFirestoreCardFormAdmissionRepository(store, config.FIRESTORE_AGENT_ID),
      );
      const result = await admission.submit({
        agentId: config.FIRESTORE_AGENT_ID,
        submission,
      });
      if (!result.ok) return result;
      const rows = await chat.listMessagesByIds(
        config.FIRESTORE_AGENT_ID,
        submission.conversationId,
        [result.messageId],
      );
      const message = rows?.find((row) => row.id === result.messageId);
      if (!message) throw new Error('Admitted form message could not be read back');
      return {
        ...result,
        messageCursor: encodeMessageCursor({ createdAt: message.createdAt, id: message.id }),
      };
    },
    isValidChatCursor,
    recordRecallFeedback: (messageId: string, verdict: 'helpful' | 'not_helpful') =>
      recordRecallFeedbackWithRepository(
        recallFeedback,
        config.FIRESTORE_AGENT_ID,
        messageId,
        verdict,
      ),
  };
}

const firestoreChatCache = globalThis as unknown as {
  __assistantFirestoreChatApplication?: ReturnType<typeof createFirestoreChatApplication>;
};

function getFirestoreChatApplication() {
  firestoreChatCache.__assistantFirestoreChatApplication ??= createFirestoreChatApplication();
  return firestoreChatCache.__assistantFirestoreChatApplication;
}

export function embedFirestoreSkillText(text: string): Promise<number[]> {
  return getFirestoreChatApplication().embedSkillText(text);
}

export function getChatApplication() {
  return loadConfig().PERSISTENCE_DRIVER === 'firestore'
    ? getFirestoreChatApplication()
    : getApplication();
}

/** Owner graph writes use the selected driver's atomic persistence boundary. */
export function addOwnerKnowledgeGraphFactForCurrentPersistence(input: {
  subjectLabel: string;
  subjectKind: string;
  subjectId?: string;
  subjectContactId?: string;
  predicate: string;
  objectLabel: string;
  objectKind: string;
  objectId?: string;
  note: string;
}) {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return getFirestoreChatApplication().addOwnerKnowledgeGraphFact(input);
  return addOwnerKnowledgeGraphFact(getDb(), getRouter(), input);
}

/** Source-backed relationship correction on the selected driver's atomic write boundary. */
export function correctOwnerKnowledgeGraphFactForCurrentPersistence(
  relationId: string,
  input: Parameters<typeof correctKnowledgeGraphRelation>[3],
) {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return getFirestoreChatApplication().correctOwnerKnowledgeGraphFact(relationId, input);
  return correctKnowledgeGraphRelation(getDb(), getRouter(), relationId, input);
}

/** The mobile workspace settings section, backed by the configured owner in either driver. */
export function getWorkspaceSettings() {
  return loadConfig().PERSISTENCE_DRIVER === 'firestore'
    ? getFirestoreChatApplication().getWorkspaceSettings()
    : getApplication().getSettings();
}

/** Record an owner location ping and run the arrival hook with the configured driver. */
export function recordOwnerLocation(body: unknown) {
  return getChatApplication().recordOwnerLocationPing(body);
}

/** Stream an owner artifact with the configured driver's `files` record as the gate. */
export function downloadOwnerArtifact(workspacePath: string) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    return getApplication().downloadArtifact(workspacePath);
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return downloadArtifactWithLookup(
    new FirestoreWorkspaceFileLookup(getFirestoreInstallationStore()),
    getWorkspace(),
    config.FIRESTORE_AGENT_ID,
    workspacePath,
  );
}

/** Queue an owner-requested memory organization pass with the configured driver. */
export function organizeOwnerMemoryNow() {
  return loadConfig().PERSISTENCE_DRIVER === 'firestore'
    ? getFirestoreChatApplication().organizeMemoryNow()
    : organizeMemoryNow(getDb());
}

/** Register the owner's APNs token with the configured driver. */
export function registerOwnerDeviceToken(body: unknown) {
  return getChatApplication().registerDeviceToken(body);
}

/** Readiness for the configured driver; Firestore never opens a SQL connection. */
export async function checkWebReadiness() {
  const config = loadConfig();
  if (config.RESTORE_REHEARSAL) {
    try {
      await assertPostgresRestoreRehearsalReadOnly(getDb());
    } catch {
      return { ready: false, database: 'unavailable' as const };
    }
  }
  return getChatApplication().checkReadiness();
}

/**
 * Owner memory and open-loop commands for the configured driver. Both
 * compositions bind the same application commands; only persistence differs.
 */
export function getOwnerMemoryCommands() {
  const application =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? getFirestoreChatApplication()
      : getApplication();
  return {
    confirmMemory: application.confirmMemory,
    restoreMemory: application.restoreMemory,
    correctMemory: application.correctMemory,
    forgetMemory: application.forgetMemory,
    setMemoryProminence: application.setMemoryProminence,
    approveQuarantinedMemory: application.approveQuarantinedMemory,
    rejectQuarantinedMemory: application.rejectQuarantinedMemory,
    createMemory: application.createMemory,
    resolveCommitment: application.resolveCommitment,
    listClosedCommitments: application.listClosedCommitments,
    reopenCommitment: application.reopenCommitment,
    snoozeCommitment: application.snoozeCommitment,
    dismissCommitment: application.dismissCommitment,
    correctCommitment: application.correctCommitment,
  };
}

/**
 * Owner import commands for the configured driver. Uploaded bytes go to the
 * installation's workspace store either way; only the records differ.
 */
export function getImportCommands() {
  const application =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? getFirestoreChatApplication()
      : getApplication();
  return {
    startImport: application.startImport,
    purgeImport: application.purgeImport,
    deleteImport: application.deleteImport,
    reviewImport: application.reviewImport,
    uploadImport: application.uploadImport,
  };
}

/** The administration console and bot use the same owner-scoped evidence projection. */
export async function getOwnerAuditInvestigation(
  taskId: string,
  options: Parameters<typeof readAuditInvestigation>[3] = {},
) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore')
    return readAuditInvestigation(
      new FirestoreAuditInvestigationRepository(getFirestoreInstallationStore()),
      config.FIRESTORE_AGENT_ID,
      taskId,
      options,
    );
  const db = getDb();
  const agent = await getAgent(db);
  return readAuditInvestigation(
    createPostgresAuditInvestigationRepository(db),
    agent.id,
    taskId,
    options,
  );
}

/** Shared owner-scoped repair service for web and native clients. */
export async function getSelfRepairService(): Promise<{
  repository: SelfRepairRepository;
  agentId: string;
}> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore')
    return {
      repository: new FirestoreSelfRepairRepository(
        getFirestoreInstallationStore(),
        config.FIRESTORE_AGENT_ID,
      ),
      agentId: config.FIRESTORE_AGENT_ID,
    };
  const db = getDb();
  return { repository: createPostgresSelfRepairRepository(db), agentId: (await getAgent(db)).id };
}

/** Composition boundary for owner-scoped historical task discovery. */
export async function getTaskDiscoveryPorts() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore')
    return {
      repository: new FirestoreTaskDiscoveryRepository(getFirestoreInstallationStore()),
      agentId: config.FIRESTORE_AGENT_ID,
    };
  return {
    repository: createPostgresTaskDiscoveryRepository(getDb()),
    agentId: (await getAgent(getDb())).id,
  };
}
