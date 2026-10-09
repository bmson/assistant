import path from 'node:path';
import {
  type Config,
  loadConfig,
  parseFirestoreEmbeddingSpace,
  repoRoot,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  createConnectedModelProviders,
  type DocumentProcessorConfig,
  findPrimaryConversation,
  getAgent,
  goalAutomationCadence,
  goalAutomationInstruction,
  ModelRouter,
  nextRun,
} from '@assistant/core';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import { supersedeContradictedFacts } from '@assistant/core/memory/supersede';
import { evaluateOutOfBandPing } from '@assistant/core/proactive/nudge-policy';
import {
  conversations,
  createDb,
  createPostgresAuditInvestigationRepository,
  createPostgresConversationSearchRepository,
  createPostgresExecutionPersistence,
  createPostgresModelConnectionRepository,
  createPostgresSelfRepairRepository,
  type Db,
  tasks,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  createInstallationStore,
  FirestoreAuditInvestigationRepository,
  FirestoreContactLookupRepository,
  FirestoreConversationSearchRepository,
  FirestoreDocumentExtractionRepository,
  FirestoreGoalMutationRepository,
  FirestoreGoalProgressRepository,
  FirestoreGoalReadRepository,
  FirestoreGraphRecallRepository,
  FirestoreImportJobRepository,
  FirestoreMcpConnectionReadRepository,
  FirestoreMissionRepository,
  FirestoreModelConnectionRepository,
  FirestoreOccasionToolRepository,
  FirestoreOwnerNoticeRepository,
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
  FirestoreSituationToolRepository,
  type FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';
import {
  browserModule,
  composedModuleMetas as collectModuleMetas,
  documentsModule,
  type InstalledModuleSet,
  installModules,
  type ModuleMeta,
  type ModuleServices,
  noopOwnerNotifier,
  type OwnerNotifier,
  type SmsChannelDeps,
  smsModule,
} from '@assistant/modules';
import {
  curiosityNudgeChannel,
  type DocumentExtractionRepository,
  drainNotificationOutbox,
  EmailObserverEffectFenceRejectedError,
  type EmbeddingSpace,
  type ExecutionPersistence,
  embeddingModelId,
  embeddingSpaceIdentityKey,
  type GoalToolRepository,
  hasEffectiveNotificationDelivery,
  type ImportJobRepository,
  type ModelRoutingRepository,
  type NotificationDeliveryResult,
  type NotificationOutboxLeg,
  type NotificationOutboxSendResult,
  type NudgePolicyRepository,
  notificationDashboardMessageId,
  notificationDeliveryKey,
  notificationLeg,
  notificationLegEntry,
  POSTGRES_EMBEDDING_DIMENSIONS,
  type Records,
  sendNotificationOutboxLeg,
} from '@assistant/persistence';
import type { BrowserJobLauncher } from '@assistant/tools/browser';
import {
  registerAuditTools,
  registerBuiltinTools,
  registerPortableContactLookupTool,
  registerPortableConversationSearchTool,
  registerPortableGoalProgressTool,
  registerPortableGoalTools,
  registerPortableGraphSnapshotTool,
  registerPortableMemoryTools,
  registerPortableOccasionTools,
  registerPortableOwnerNotifyTool,
  registerPortableReadResultTool,
  registerPortableTaskTools,
  registerPortableWebWorkspaceTools,
  registerSelfRepairTools,
  registerSituationTools,
  registerSportsTools,
  registerWeatherTool,
} from '@assistant/tools/builtin';
import { ToolDispatcher } from '@assistant/tools/dispatcher';
import { registerMcpTools } from '@assistant/tools/mcp';
import { ToolRegistry } from '@assistant/tools/registry';
import {
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
import { and, eq } from 'drizzle-orm';
// The installation's composition file, at the repository root. Importing it
// here is what bakes the chosen modules into the built image.
import composition from '../../../assistant.config.js';
import { firestoreMaintenanceReady as checkFirestoreMaintenanceReady } from './firestore-maintenance-ready.js';

/**
 * Process-level dependency graph. Apps compose concrete adapters here while
 * business code consumes only the narrower ports exposed by core and tools.
 */
export interface AgentDeps {
  config: Config;
  db: Db;
  persistence?: ExecutionPersistence;
  firestoreStore?: InstallationStore;
  firestoreTasks?: FirestoreTaskRepository;
  documentExtractionRepository?: DocumentExtractionRepository;
  importJobRepository?: ImportJobRepository;
  router: ModelRouter;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  workspace: WorkspaceStore;
  /** Installed capabilities, for code that asks a module what it produced. */
  modules: InstalledModuleSet;
  /** The modules' owner notifier behind the nudge policy — the phone legs only. */
  outOfBandNotifier: OwnerNotifier;
  browserLauncher?: BrowserJobLauncher;
  documentProcessor?: DocumentProcessorConfig;
}

/** Maintenance stays fenced while an imported workspace awaits explicit activation. */
export async function firestoreMaintenanceReady(deps: AgentDeps): Promise<boolean> {
  return checkFirestoreMaintenanceReady(deps.firestoreStore, deps.config.FIRESTORE_AGENT_ID);
}

/**
 * The owner's MCP tools over Firestore connection snapshots. Registered in
 * every environment, as the PostgreSQL composition does; each call still
 * passes the approval, audit and taint spine.
 */
export function registerFirestoreMcpTools(
  registry: ToolRegistry,
  store: InstallationStore,
  agentId: string,
): ToolRegistry {
  const connections = new FirestoreMcpConnectionReadRepository(store, agentId);
  return registerMcpTools(registry, {
    list: (ownerId) => connections.list(ownerId),
    get: (ownerId, connectionId) => connections.getForTools(ownerId, connectionId),
  });
}

/**
 * The composed modules' plain metadata. Route mounters read this at import
 * time — before any deps exist — because Hono routes register statically while
 * enabled-guards evaluate per request.
 */
export const composedModuleMetas: readonly ModuleMeta[] = collectModuleMetas(composition);

/**
 * The sms channel's narrow deps, from the agent graph. Canaries — the one
 * consumer left in the agent — reach the channel through this; everything
 * else consumes the owner-notifier port.
 */
export function smsDeps(deps: AgentDeps): SmsChannelDeps {
  const persistence = deps.persistence ?? createPostgresExecutionPersistence(deps.db);
  const { smsChannel } = persistence;
  if (!smsChannel) throw new Error('sms: persistence has no SMS channel repository');
  return {
    config: deps.config,
    registry: deps.registry,
    twilio: deps.modules.requireExports(smsModule),
    persistence: { ...persistence, smsChannel },
    owner: () => getAgent(deps.db),
  };
}

/**
 * The owner notifier the platform always has.
 *
 * `OwnerNotifier` is a port that channel MODULES provide, and SMS is the only
 * module that implements it — so without Twilio installed, every notice the
 * platform generates went to `noopOwnerNotifier` and vanished. The dashboard is
 * core platform rather than an optional capability, so it belongs here in the
 * composition root rather than behind a module.
 *
 * Composed with (not substituted for) whatever modules provide: a notice should
 * reach the owner's chat AND their phone when both exist. Each leg is
 * best-effort and independent, so a Twilio outage cannot swallow the dashboard
 * copy, and vice versa.
 */
export function shouldMirrorIntoPrimary(
  sourceConversationId: string | null | undefined,
  primaryConversationId: string | null | undefined,
): boolean {
  return !sourceConversationId || sourceConversationId !== primaryConversationId;
}

export function approvalSummaryNotice(
  approvals: ReadonlyArray<{ purpose?: string; id?: string }>,
): {
  text: string;
  extraParts: readonly unknown[];
} {
  const purpose =
    approvals.find((approval) => approval.purpose?.trim())?.purpose?.trim() ?? 'Continue this task';
  const approvalCount = approvals.length;
  // Naming the approvals is what lets the card stop saying "waiting for
  // review" once they are answered: without them the count is frozen at
  // whatever it was when the notice was written. See hydrateChatApprovals.
  const approvalIds = approvals
    .map((approval) => approval.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return {
    text: [
      `Approval needed to continue: ${purpose}`,
      `${approvalCount} ${approvalCount === 1 ? 'action is' : 'actions are'} waiting for review in Approvals.`,
    ].join('\n'),
    extraParts: [
      {
        type: 'approval-summary',
        purpose,
        approvalCount,
        ...(approvalIds.length > 0 ? { approvalIds } : {}),
      },
    ],
  };
}

function dashboardOwnerNotifier(deps: AgentDeps): OwnerNotifier {
  const post = async (
    text: string,
    taskId?: string,
    sourceConversationId?: string | null,
    extraParts?: readonly unknown[],
    deliveryKey?: string,
    emailObserverEffectFence?: import('@assistant/persistence').EmailObserverEffectFence,
    applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence,
  ): Promise<NotificationDeliveryResult> => {
    const agent = await getAgent(deps.db);
    const primary = await findPrimaryConversation(deps.db, agent.id);
    // Executor notices are already persisted into their owning conversation.
    // Mirroring one whose owner IS the primary chat creates the exact pair the
    // reader used to see: a structured card followed by a prose restatement.
    if (!shouldMirrorIntoPrimary(sourceConversationId, primary?.id))
      return notificationLeg('dashboard', 'skipped', 'already-in-source-conversation');
    const persistence = deps.persistence ?? createPostgresExecutionPersistence(deps.db);
    const destination =
      primary?.id ??
      (await persistence.notifications.getOrCreate(
        agent.id,
        emailObserverEffectFence,
        applicationConfirmationNoticeFence,
      ));
    return persistDashboardNotice(deps, persistence, {
      agentId: agent.id,
      conversationId: destination,
      ...(taskId ? { taskId } : {}),
      text,
      extraParts,
      deliveryKey:
        deliveryKey ?? notificationDeliveryKey('dashboard-notice', taskId ?? agent.id, text),
      ...(emailObserverEffectFence ? { emailObserverEffectFence } : {}),
      ...(applicationConfirmationNoticeFence ? { applicationConfirmationNoticeFence } : {}),
    });
  };
  return {
    notifyOwner: async ({
      text,
      taskId,
      conversationId,
      deliveryKey,
      emailObserverEffectFence,
      applicationConfirmationNoticeFence,
    }) => {
      return post(
        text,
        taskId,
        conversationId,
        undefined,
        deliveryKey,
        emailObserverEffectFence,
        applicationConfirmationNoticeFence,
      );
    },
    // Approval cards are already posted into the originating conversation by the
    // executor. Mirror one compact, purpose-first summary for an owner who is
    // looking at the primary chat instead — details remain on Approvals.
    notifyApprovals: async (pending) => {
      if (pending.length === 0) return notificationLeg('dashboard', 'skipped', 'empty-batch');
      const agent = await getAgent(deps.db);
      const primary = await findPrimaryConversation(deps.db, agent.id);
      const notices = pending.filter((approval) =>
        shouldMirrorIntoPrimary(approval.conversationId, primary?.id),
      );
      if (notices.length === 0)
        return notificationLeg('dashboard', 'skipped', 'already-in-source-conversation');
      const summary = approvalSummaryNotice(notices);
      return post(
        summary.text,
        notices[0]?.taskId,
        notices[0]?.conversationId,
        summary.extraParts,
        notificationDeliveryKey(
          'dashboard-approval-batch',
          ...notices.map((notice) => `${notice.taskId}:${notice.shortCode}`).sort(),
        ),
      );
    },
  };
}

/**
 * Dashboard delivery is an outbox leg too. The deterministic channel message
 * identity makes a crash after message append but before receipt commit
 * recoverable without creating a second chat message.
 */
async function persistDashboardNotice(
  deps: AgentDeps,
  persistence: ExecutionPersistence,
  input: {
    agentId: string;
    conversationId: string;
    taskId?: string;
    text: string;
    extraParts?: readonly unknown[];
    deliveryKey: string;
    emailObserverEffectFence?: import('@assistant/persistence').EmailObserverEffectFence;
    applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence;
  },
): Promise<NotificationDeliveryResult> {
  const legKey = 'dashboard';
  const now = new Date();
  const result = await sendNotificationOutboxLeg(
    persistence.notificationOutbox,
    {
      agentId: input.agentId,
      deliveryKey: input.deliveryKey,
      legKey,
      adapter: 'dashboard',
      destination: { conversationId: input.conversationId },
      payload: {
        text: input.text,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        extraParts: input.extraParts ?? [],
      },
      ...(input.emailObserverEffectFence
        ? { emailObserverEffectFence: input.emailObserverEffectFence }
        : {}),
      ...(input.applicationConfirmationNoticeFence
        ? { applicationConfirmationNoticeFence: input.applicationConfirmationNoticeFence }
        : {}),
      now,
    },
    (row) => sendDashboardOutboxLeg(deps, persistence, row),
  );
  return { legs: [result] };
}

async function sendDashboardOutboxLeg(
  deps: AgentDeps,
  persistence: ExecutionPersistence,
  row: NotificationOutboxLeg,
): Promise<NotificationOutboxSendResult> {
  const destination = row.destination as { conversationId?: unknown } | null;
  const payload = row.payload as { text?: unknown; taskId?: unknown; extraParts?: unknown } | null;
  if (
    !destination ||
    typeof destination.conversationId !== 'string' ||
    !payload ||
    typeof payload.text !== 'string' ||
    (payload.taskId !== undefined && typeof payload.taskId !== 'string') ||
    !Array.isArray(payload.extraParts)
  )
    return { status: 'skipped', reason: 'dashboard-payload-erased-or-invalid' };
  const conversationId = destination.conversationId;
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined;
  if (deps.config.PERSISTENCE_DRIVER === 'firestore') {
    const store = deps.firestoreStore;
    if (!store)
      return { status: 'failed', retryable: true, reason: 'conversation-store-unavailable' };
    const conversation = await store.doc('conversations', conversationId).get();
    if (
      !conversation.exists ||
      conversation.get('id') !== conversationId ||
      conversation.get('agentId') !== row.agentId
    )
      return { status: 'skipped', reason: 'dashboard-conversation-no-longer-owned' };
    if (taskId) {
      const task = await store.doc('tasks', taskId).get();
      if (!task.exists || task.get('id') !== taskId || task.get('agentId') !== row.agentId)
        return { status: 'skipped', reason: 'dashboard-task-no-longer-owned' };
    }
  } else {
    const [conversation] = await deps.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, row.agentId)))
      .limit(1);
    if (!conversation)
      return { status: 'skipped', reason: 'dashboard-conversation-no-longer-owned' };
    if (taskId) {
      const [task] = await deps.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, row.agentId)))
        .limit(1);
      if (!task) return { status: 'skipped', reason: 'dashboard-task-no-longer-owned' };
    }
  }
  const channelMessageId = notificationDashboardMessageId(row.agentId, row.deliveryKey, row.legKey);
  try {
    await persistence.messages.append({
      conversationId,
      ...(taskId ? { taskId } : {}),
      role: 'assistant',
      origin: 'assistant',
      parts: [{ type: 'text', text: payload.text }, ...payload.extraParts],
      text: payload.text,
      channelMessageId,
      ...(row.leaseToken && (row.producerWorkId || row.producerTaskId)
        ? {
            notificationOutboxFence: {
              agentId: row.agentId,
              legId: row.id,
              leaseToken: row.leaseToken,
              producerWorkId: row.producerWorkId ?? null,
              producerTaskId: row.producerTaskId ?? null,
              producerApplicationId: row.producerApplicationId ?? null,
              producerConfirmationMessageId: row.producerConfirmationMessageId ?? null,
              producerPrivacyGeneration: row.producerPrivacyGeneration ?? null,
            },
          }
        : {}),
    });
    return { status: 'delivered', providerMessageId: channelMessageId };
  } catch (error) {
    if (error instanceof EmailObserverEffectFenceRejectedError)
      return { status: 'skipped', reason: 'email-observer-fence-invalid' };
    // Append is deduped by channelMessageId, so retry remains safe if a
    // connection failed after the insert committed.
    return {
      status: 'failed',
      retryable: true,
      retryAt: new Date(Date.now() + 15_000),
      reason: 'dashboard-persistence-temporarily-unavailable',
    };
  }
}

async function drainDashboardNotificationOutbox(deps: AgentDeps): Promise<number> {
  const persistence = deps.persistence ?? createPostgresExecutionPersistence(deps.db);
  const agent =
    deps.config.PERSISTENCE_DRIVER === 'firestore'
      ? await persistence.executionContext.getAgent(deps.config.FIRESTORE_AGENT_ID)
      : await getAgent(deps.db);
  if (!agent) throw new Error('Notification outbox owner is unavailable');
  return drainNotificationOutbox(persistence.notificationOutbox, {
    agentId: agent.id,
    adapter: 'dashboard',
    now: new Date(),
    limit: 100,
    send: (row) => sendDashboardOutboxLeg(deps, persistence, row),
  });
}

/** Firestore's dashboard sink keeps notices durable without opening SQL. */
function firestoreDashboardOwnerNotifier(deps: AgentDeps): OwnerNotifier {
  if (!deps.firestoreStore)
    throw new Error('Firestore owner notices require an installation store');
  const persistence = deps.persistence;
  if (!persistence) throw new Error('Firestore owner notices require execution persistence');
  const notices = new FirestoreOwnerNoticeRepository(
    deps.firestoreStore,
    deps.config.FIRESTORE_AGENT_ID,
  );
  return {
    notifyOwner: async ({
      text,
      taskId,
      conversationId,
      deliveryKey,
      emailObserverEffectFence,
      applicationConfirmationNoticeFence,
    }) => {
      const agentId = deps.config.FIRESTORE_AGENT_ID;
      const primaryId = await notices.primaryConversationId();
      if (!shouldMirrorIntoPrimary(conversationId, primaryId))
        return notificationLeg('dashboard', 'skipped', 'already-in-source-conversation');
      const destinationId =
        primaryId ??
        (await notices.getOrCreate(
          agentId,
          emailObserverEffectFence,
          applicationConfirmationNoticeFence,
        ));
      return persistDashboardNotice(deps, persistence, {
        agentId,
        conversationId: destinationId,
        ...(taskId ? { taskId } : {}),
        text,
        deliveryKey:
          deliveryKey ?? notificationDeliveryKey('dashboard-notice', taskId ?? agentId, text),
        ...(emailObserverEffectFence ? { emailObserverEffectFence } : {}),
        ...(applicationConfirmationNoticeFence ? { applicationConfirmationNoticeFence } : {}),
      });
    },
    notifyApprovals: async (pending) => {
      if (pending.length === 0) return notificationLeg('dashboard', 'skipped', 'empty-batch');
      const primaryId = await notices.primaryConversationId();
      const toMirror = pending.filter((approval) =>
        shouldMirrorIntoPrimary(approval.conversationId, primaryId),
      );
      if (toMirror.length === 0)
        return notificationLeg('dashboard', 'skipped', 'already-in-source-conversation');
      const summary = approvalSummaryNotice(toMirror);
      return persistDashboardNotice(deps, persistence, {
        agentId: deps.config.FIRESTORE_AGENT_ID,
        conversationId: primaryId ?? (await notices.getOrCreate(deps.config.FIRESTORE_AGENT_ID)),
        taskId: toMirror[0]?.taskId,
        text: summary.text,
        extraParts: summary.extraParts,
        deliveryKey: notificationDeliveryKey(
          'dashboard-approval-batch',
          ...toMirror.map((notice) => `${notice.taskId}:${notice.shortCode}`).sort(),
        ),
      });
    },
  };
}

/**
 * The nudge-policy gate on the out-of-band legs (SMS/push). Ambient notices
 * consult quiet hours and the daily cap here — one choke point every module
 * notifier passes through, so no producer has to know the others exist. A
 * held notice is recorded in the ping ledger and still posts to the dashboard
 * leg, which is composed separately and never gated. Approvals bypass the
 * policy entirely: the owner is the one waiting on them.
 */
function policyGatedOutOfBand(
  policy: Db | NudgePolicyRepository,
  owner: () => Promise<{ id: string; timezone: string }>,
  inner: OwnerNotifier,
): OwnerNotifier {
  return {
    notifyOwner: async (input) => {
      const decision = await evaluateOutOfBandPing(policy, await owner(), {
        urgency: input.urgency ?? 'interrupt',
        ...(input.deliveryKey?.startsWith('curiosity-notice:')
          ? { channel: curiosityNudgeChannel(input.deliveryKey) }
          : {}),
      });
      if (!decision.deliver)
        return notificationLeg('out-of-band', 'held', decision.reason ?? 'policy-held');
      return (
        (await inner.notifyOwner(input)) ??
        notificationLeg('out-of-band', 'skipped', 'legacy-no-result')
      );
    },
    notifyApprovals: (pending) => inner.notifyApprovals(pending),
  };
}

/** Fan a notice out to every notifier, so one failing channel cannot silence the rest. */
function composeOwnerNotifiers(
  notifiers: readonly { name: string; notifier: OwnerNotifier }[],
): OwnerNotifier {
  const each = async (
    run: (notifier: OwnerNotifier) => Promise<NotificationDeliveryResult | void>,
    method: string,
  ): Promise<NotificationDeliveryResult> => {
    const legs: NotificationDeliveryResult['legs'][number][] = [];
    for (const { name, notifier } of notifiers) {
      // A leg that throws synchronously is isolated the same as one that rejects.
      try {
        const result = await run(notifier);
        legs.push(...(result?.legs ?? [notificationLegEntry(name, 'skipped', 'legacy-no-result')]));
      } catch (err) {
        console.error(`${method} notification failed in ${name}`, err);
        legs.push(notificationLegEntry(name, 'failed', 'notifier-threw'));
      }
    }
    return { legs };
  };
  return {
    notifyOwner: (input) => {
      const prepared = {
        ...input,
        deliveryKey:
          input.deliveryKey ??
          notificationDeliveryKey(
            'owner-notice',
            input.taskId ?? 'no-task',
            input.conversationId ?? 'no-conversation',
            input.text,
          ),
      };
      return each((notifier) => notifier.notifyOwner(prepared), 'owner');
    },
    notifyApprovals: (approvals) => {
      const prepared = approvals.map((approval) => ({
        ...approval,
        deliveryKey:
          approval.deliveryKey ??
          notificationDeliveryKey('approval-notice', approval.taskId, approval.shortCode),
      }));
      return each((notifier) => notifier.notifyApprovals(prepared), 'approval');
    },
  };
}

/** The invocation-time services module hooks receive. */
export function agentServices(deps: AgentDeps): ModuleServices {
  return {
    config: deps.config,
    db: deps.db,
    router: deps.router,
    registry: deps.registry,
    dispatcher: deps.dispatcher,
    workspace: deps.workspace,
    ownerNotifier: composeOwnerNotifiers([
      {
        name: 'dashboard',
        notifier:
          deps.config.PERSISTENCE_DRIVER === 'firestore'
            ? firestoreDashboardOwnerNotifier(deps)
            : dashboardOwnerNotifier(deps),
      },
      { name: 'out-of-band', notifier: deps.outOfBandNotifier },
    ]),
    emailObservers: deps.modules.emailObservers,
    durableEmailObservers: deps.modules.durableEmailObservers,
    persistence: deps.persistence ?? createPostgresExecutionPersistence(deps.db),
    operationalReady: () =>
      deps.config.PERSISTENCE_DRIVER === 'firestore'
        ? firestoreMaintenanceReady(deps)
        : Promise.resolve(true),
  };
}

let cached: AgentDeps | undefined;

/** A type-compatible tripwire for legacy paths that have no Firestore adapter yet. */
function unavailableSqlDb(): Db {
  return new Proxy({} as Db, {
    get(_target, property) {
      throw new Error(
        `PostgreSQL access is unavailable in Firestore agent mode: ${String(property)}`,
      );
    },
  });
}

/** Reject a model-role change before it can mix incompatible memory vectors. */
export function pinnedMemoryEmbed(
  space: EmbeddingSpace,
  routing: Pick<ModelRoutingRepository, 'role'>,
  embed: (texts: string[], expectedSpace: EmbeddingSpace) => Promise<number[][]>,
): (texts: string[]) => Promise<number[][]> {
  return async (texts) => {
    const selected = await routing.role('embed');
    const expected = embeddingModelId(space);
    if (selected?.primaryModel !== expected) {
      throw new Error(`Firestore memory embedding role must use ${expected}`);
    }
    return embed(texts, space);
  };
}

/** The recurring automation a goal created by goals.create runs on, as the PostgreSQL goal sync builds it. */
function goalAutomation(goal: Records['goals']) {
  const cadence = goalAutomationCadence(goal);
  return {
    cron: cadence.cron,
    instruction: goalAutomationInstruction(goal),
    nextRunAt: (timezone: string) => nextRun(cadence.cron, timezone),
  };
}

/** goals.list and goals.create on the Firestore goal repositories. */
function firestoreGoalTools(store: InstallationStore, agentId: string): GoalToolRepository {
  const reads = new FirestoreGoalReadRepository(store, agentId);
  const mutations = new FirestoreGoalMutationRepository(store, agentId);
  return {
    listStanding: (ownerId) => reads.listStanding(ownerId),
    create: (input) => {
      if (input.agentId !== agentId)
        throw new Error('Goal creation is outside the configured Firestore agent');
      return mutations.createFromTool(
        {
          title: input.title,
          description: input.description,
          priority: input.priority,
          targetDate: input.targetDate,
          progress: '',
          nextAction: '',
          mirrorToPrimary: false,
          taintedOrigin: input.taintedOrigin,
        },
        goalAutomation,
      );
    },
  };
}

function buildFirestoreDeps(config: Config): AgentDeps {
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return composeFirestoreAgent(config);
}

/**
 * The Firestore composition itself, without the runtime policy that narrows
 * which modules may be enabled. `buildDeps` always validates first. This is
 * exported so a test can compose every production module and prove that
 * construction opens no SQL client.
 */
export function composeFirestoreAgent(config: Config): AgentDeps {
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  const embeddingSpace = parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE);
  const persistence = createFirestoreExecutionPersistence(
    store,
    config.FIRESTORE_AGENT_ID,
    embeddingSpace,
  );
  const documentExtractionRepository = new FirestoreDocumentExtractionRepository(
    store,
    config.FIRESTORE_AGENT_ID,
    embeddingSpace,
  );
  const importJobRepository = new FirestoreImportJobRepository(
    store,
    config.FIRESTORE_AGENT_ID,
    embeddingSpace,
  );
  const db = unavailableSqlDb();
  const modelConnections = new FirestoreModelConnectionRepository(store);
  const router = new ModelRouter(
    persistence.modelRouting,
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConnectedModelProviders(config, () => modelConnections.list()),
    embeddingSpace,
  );
  const workspacePrefix = `workspace/${config.ASSISTANT_WORKSPACE_ID}`;
  const workspaceRoot = config.RESTORE_REHEARSAL
    ? config.RESTORE_REHEARSAL_ROOT
    : path.join(repoRoot, '.workspace');
  const workspace: WorkspaceStore =
    config.FILES_DRIVER === 'gcs'
      ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, workspacePrefix)
      : new LocalWorkspaceStore(workspaceRoot);
  const ownerTimezone = async (agentId: string): Promise<string> => {
    if (agentId !== config.FIRESTORE_AGENT_ID)
      throw new Error('Owner is outside the configured Firestore agent');
    const owner = await store.doc('agents', agentId).get();
    const timezone = owner.exists ? owner.get('timezone') : null;
    if (typeof timezone !== 'string' || !timezone)
      throw new Error('Firestore owner timezone is unavailable');
    return timezone;
  };
  // Memory, scheduling, goals, missions, owner notices, and keyless lookups use
  // portable repositories.
  const notices = new FirestoreOwnerNoticeRepository(store, config.FIRESTORE_AGENT_ID);
  // Late-bound like the PostgreSQL composition: owner.notify registers before
  // the modules that supply the phone legs are installed.
  let outOfBandNotifier: OwnerNotifier = noopOwnerNotifier;
  const registry = registerFirestoreMcpTools(
    registerPortableOwnerNotifyTool(
      registerPortableGoalProgressTool(
        registerPortableTaskTools(
          registerPortableMemoryTools(
            registerPortableWebWorkspaceTools(
              registerSportsTools(
                registerWeatherTool(new ToolRegistry(), { ownerContext: persistence.ownerContext }),
                { timezone: ownerTimezone },
              ),
              { workspace },
            ),
            {
              memory: persistence.memory,
              embed: pinnedMemoryEmbed(embeddingSpace, persistence.modelRouting, (texts) =>
                router.embed(texts, { expectedSpace: embeddingSpace }),
              ),
              embedWithIdentity: async (texts) => ({
                embeddings: await pinnedMemoryEmbed(
                  embeddingSpace,
                  persistence.modelRouting,
                  (values) => router.embed(values, { expectedSpace: embeddingSpace }),
                )(texts),
                embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
              }),
              supersede: (input) =>
                supersedeContradictedFacts(
                  {
                    memory: persistence.memorySupersede,
                    router,
                    onRetired: () =>
                      compileOwnerCard(persistence.ownerCardCompilation, input.agentId),
                  },
                  input,
                ),
            },
          ),
          { tasks: persistence.tasks },
        ),
        new FirestoreGoalProgressRepository(store, config.FIRESTORE_AGENT_ID),
      ),
      {
        post: (input) => {
          if (input.agentId !== config.FIRESTORE_AGENT_ID)
            throw new Error('Owner notice is outside the configured Firestore agent');
          return notices.postToolNotice(input);
        },
        notifyOwner: async (input) => {
          const result = await outOfBandNotifier.notifyOwner(input);
          if (!hasEffectiveNotificationDelivery(result))
            throw new Error('No out-of-band notification provider acknowledged the ping');
        },
      },
    ),
    store,
    config.FIRESTORE_AGENT_ID,
  );
  registerPortableGoalTools(registry, {
    goals: firestoreGoalTools(store, config.FIRESTORE_AGENT_ID),
    missions: new FirestoreMissionRepository(store, config.FIRESTORE_AGENT_ID),
  });
  // Built-in record tools (graph snapshot, stored results, occasions,
  // contacts, conversation search, situation packs) use their Firestore
  // repositories. Vector reads use the pinned embedding space.
  const recordEmbed = pinnedMemoryEmbed(embeddingSpace, persistence.modelRouting, (texts) =>
    router.embed(texts, { expectedSpace: embeddingSpace }),
  );
  registerPortableGraphSnapshotTool(registry, {
    embed: recordEmbed,
    graph: new FirestoreGraphRecallRepository(store, embeddingSpace),
  });
  const conversations = new FirestoreConversationSearchRepository(store, embeddingSpace);
  registerPortableReadResultTool(registry, {
    toolExecution: persistence.toolExecution,
    conversations,
  });
  registerAuditTools(registry, new FirestoreAuditInvestigationRepository(store));
  if (persistence.selfRepair) registerSelfRepairTools(registry, persistence.selfRepair);
  registerPortableOccasionTools(
    registry,
    new FirestoreOccasionToolRepository(store, config.FIRESTORE_AGENT_ID),
  );
  registerPortableContactLookupTool(
    registry,
    new FirestoreContactLookupRepository(store, config.FIRESTORE_AGENT_ID),
  );
  registerPortableConversationSearchTool(registry, {
    embed: async (texts) => ({
      embeddings: await recordEmbed(texts),
      embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
    }),
    conversations,
  });
  registerSituationTools(
    registry,
    new FirestoreSituationToolRepository(store, config.FIRESTORE_AGENT_ID),
  );

  let dashboardDrainDeps: AgentDeps | undefined;
  const installedModules = installModules(composition.modules, {
    config,
    db,
    registry,
    repoRoot,
    router,
    workspace,
    workspacePrefix,
    workspaceRoot,
    persistence,
    portableReminders: {
      schedules: new FirestoreScheduleRepository(store),
      reminders: new FirestoreReminderRepository(store),
      getTimezone: ownerTimezone,
    },
  });
  const modules: InstalledModuleSet = {
    ...installedModules,
    sweepSteps: [
      {
        name: 'drainDashboardNotificationOutbox',
        portable: true,
        run: async () => {
          if (!dashboardDrainDeps) throw new Error('Dashboard notification sweep is not ready');
          return drainDashboardNotificationOutbox(dashboardDrainDeps);
        },
      },
      ...installedModules.sweepSteps,
    ],
  };
  const nudgePolicy = persistence.nudgePolicy;
  if (!nudgePolicy) throw new Error('Firestore persistence has no nudge policy');
  outOfBandNotifier = policyGatedOutOfBand(
    nudgePolicy,
    async () => ({
      id: config.FIRESTORE_AGENT_ID,
      timezone: await ownerTimezone(config.FIRESTORE_AGENT_ID),
    }),
    modules.ownerNotifier,
  );
  const documentProcessor = modules.exportsOf(documentsModule);
  const composed: AgentDeps = {
    config,
    db,
    firestoreStore: store,
    firestoreTasks: persistence.tasks,
    documentExtractionRepository,
    importJobRepository,
    persistence,
    router,
    registry,
    dispatcher: new ToolDispatcher(
      db,
      registry,
      persistence.toolExecution,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    ),
    workspace,
    modules,
    outOfBandNotifier,
    ...(documentProcessor ? { documentProcessor } : {}),
  };
  dashboardDrainDeps = composed;
  return composed;
}

export function buildDeps(): AgentDeps {
  if (cached) return cached;

  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    cached = buildFirestoreDeps(config);
    return cached;
  }
  const db = createDb(config.DATABASE_URL, {
    max: config.DB_POOL_MAX,
    idleTimeoutSeconds: config.DB_IDLE_TIMEOUT_SECONDS,
    connectTimeoutSeconds: config.DB_CONNECT_TIMEOUT_SECONDS,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    // The restore profile's non-elevated role and server-enforced
    // default_transaction_read_only fence are stronger. Keeping the cutover
    // proxy here would also reject the read-only catalog inspection needed to
    // verify that database fence before listening.
    sourceWritesFenced: config.POSTGRES_SOURCE_WRITES_FENCED && !config.RESTORE_REHEARSAL,
    readOnly: config.RESTORE_REHEARSAL,
  });
  const persistence = createPostgresExecutionPersistence(db);
  const modelConnections = createPostgresModelConnectionRepository(db);
  const router = new ModelRouter(
    persistence.modelRouting,
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConnectedModelProviders(config, () => modelConnections.list()),
    undefined,
    POSTGRES_EMBEDDING_DIMENSIONS,
  );
  const workspacePrefix = `workspace/${config.ASSISTANT_WORKSPACE_ID}`;
  const workspaceRoot = config.RESTORE_REHEARSAL
    ? config.RESTORE_REHEARSAL_ROOT
    : path.join(repoRoot, '.workspace');
  const workspace: WorkspaceStore =
    config.FILES_DRIVER === 'gcs'
      ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, workspacePrefix)
      : new LocalWorkspaceStore(workspaceRoot);

  // The policy-gated out-of-band notifier is a late binding: built-in tools
  // register BEFORE modules are installed, so the owner.notify `ping` leg
  // reaches the (by then assigned) gated aggregate through this closure.
  // Until then it no-ops — a ping during boot has nowhere to go anyway.
  let outOfBandNotifier: OwnerNotifier = noopOwnerNotifier;

  // Built-ins are the base platform: memory, goals, approvals, missions, and
  // workspace tools. Optional provider/worker modules are installed below, and
  // each registers its own tools — the composition root names none of them.
  const registry = registerMcpTools(
    registerBuiltinTools(new ToolRegistry(), {
      conversations: createPostgresConversationSearchRepository(db),
      tasks: persistence.tasks,
      memory: persistence.memory,
      embed: async (texts) => {
        const space = await router.embeddingSpace();
        return router.embed(texts, { expectedSpace: space });
      },
      embedWithIdentity: async (texts) => {
        const result = await router.embedWithIdentity(texts);
        return { embeddings: result.embeddings, embeddingSpaceKey: result.spaceKey };
      },
      workspace,
      notifyOwner: async (input) => {
        const result = await outOfBandNotifier.notifyOwner(input);
        if (!hasEffectiveNotificationDelivery(result))
          throw new Error('No out-of-band notification provider acknowledged the ping');
      },
      supersede: (input) =>
        supersedeContradictedFacts(
          {
            memory: persistence.memorySupersede,
            router,
            onRetired: () => compileOwnerCard(persistence.ownerCardCompilation, input.agentId),
          },
          input,
        ),
    }),
  );
  registerAuditTools(registry, createPostgresAuditInvestigationRepository(db));
  registerSelfRepairTools(registry, createPostgresSelfRepairRepository(db));
  const installedModules = installModules(composition.modules, {
    config,
    db,
    registry,
    repoRoot,
    router,
    workspace,
    workspacePrefix,
    workspaceRoot,
    persistence,
  });
  const modules: InstalledModuleSet = {
    ...installedModules,
    sweepSteps: [
      {
        name: 'drainDashboardNotificationOutbox',
        portable: true,
        run: async () => {
          if (!cached) throw new Error('Dashboard notification sweep is not ready');
          return drainDashboardNotificationOutbox(cached);
        },
      },
      ...installedModules.sweepSteps,
    ],
  };
  outOfBandNotifier = policyGatedOutOfBand(db, () => getAgent(db), modules.ownerNotifier);

  const browserLauncher = modules.exportsOf(browserModule);
  const documentProcessor = modules.exportsOf(documentsModule);
  cached = {
    config,
    db,
    router,
    registry,
    persistence,
    dispatcher: new ToolDispatcher(
      db,
      registry,
      persistence.toolExecution,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    ),
    workspace,
    modules,
    outOfBandNotifier,
    ...(browserLauncher ? { browserLauncher } : {}),
    ...(documentProcessor ? { documentProcessor } : {}),
  };
  return cached;
}
