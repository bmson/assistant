import {
  assistantHealthAlerts,
  type Db,
  knowledgeGraphSources,
  memories,
  recallMetrics,
  responseChecks,
  tasks,
} from '@assistant/db';
import type {
  AssistantHealthObservations,
  AssistantHealthRepository,
  AssistantHealthSignal,
  CostRepository,
  KnowledgeGraphSyncRepository,
  ProactiveCanaryRepository,
} from '@assistant/persistence';
import {
  HEALTH_CANARY_PUSH_TEXT,
  ownerLocalDay,
  PROACTIVE_CANARY_ALERT_KINDS,
} from '@assistant/persistence';
import { and, eq, gte, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { pendingKnowledgeGraphSourceCount } from '../memory/knowledge-graph.js';
import type { ProactiveNotifier } from '../proactive/notify.js';
import {
  assessProactiveCanaries,
  dailyBudgetHoldHealth,
  mailHealthWindow,
  mailIntakeStallDetails,
  proactiveCanaryProblems,
  sqlMailHealthCounts,
} from '../proactive/pipeline-health.js';
import { notifyOwnerInNotifications } from './anomaly.js';

/** A completed graph extraction may hold a five-minute lease; ten minutes is actionable. */
const STALE_GRAPH_PENDING_MS = 10 * 60 * 1000;
const QUALITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_VERIFIER_UNAVAILABLE = 2;
const MIN_CONTRACT_BLOCKS = 3;
const MIN_MUST_ACT_RETRIES = 2;
const MIN_DEGRADED_STEPS = 3;
const MIN_GRAPH_RECALL_FAILURES = 3;
const MIN_HISTORY_RECALL_FAILURES = 3;
/** Two complete sync batches waiting is actionable without paging on normal ingestion. */
const MIN_GRAPH_BACKLOG = 50;
/** Persistent incidents receive a reminder, not a daily stream of identical pings. */
const HEALTH_ALERT_RENOTIFY_MS = 7 * 24 * 60 * 60 * 1000;
const MAIL_ALERT_RENOTIFY_MS = 24 * 60 * 60 * 1000;

interface HealthSignal extends AssistantHealthSignal {
  kind:
    | 'graph_quarantined'
    | 'graph_stale_pending'
    | 'graph_backlog'
    | 'graph_recall_unavailable'
    | 'history_recall_unavailable'
    | 'verification_unavailable'
    | 'response_contract_blocks'
    | 'must_act_retries'
    | 'degraded_steps'
    | 'mail_processing_stalled';
  detail: string;
}

export interface HealthMonitorResult {
  signals: string[];
  notified: boolean;
}

/**
 * Persist observed conditions and atomically claim only alerts that are new,
 * reopened, or old enough for a weekly reminder. A second monitor racing the
 * first sees the fresh `lastNotifiedAt` and cannot send a duplicate message.
 */
async function claimHealthNotifications(
  db: Db,
  agentId: string,
  signals: readonly AssistantHealthSignal[],
  now: Date,
  reminderBefore: Date,
): Promise<AssistantHealthSignal[]> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const notify: AssistantHealthSignal[] = [];
    for (const signal of signals) {
      const [claimed] = await txDb
        .update(assistantHealthAlerts)
        .set({
          detail: signal.detail,
          status: 'open',
          observationCount: sql`${assistantHealthAlerts.observationCount} + 1`,
          lastSeenAt: now,
          lastNotifiedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(assistantHealthAlerts.agentId, agentId),
            eq(assistantHealthAlerts.kind, signal.kind),
            or(
              signal.notificationDueBefore ? undefined : ne(assistantHealthAlerts.status, 'open'),
              isNull(assistantHealthAlerts.lastNotifiedAt),
              lt(
                assistantHealthAlerts.lastNotifiedAt,
                signal.notificationDueBefore ?? reminderBefore,
              ),
            ),
          ),
        )
        .returning({ id: assistantHealthAlerts.id });
      if (claimed) {
        notify.push(signal);
        continue;
      }

      const [created] = await txDb
        .insert(assistantHealthAlerts)
        .values({
          agentId,
          kind: signal.kind,
          detail: signal.detail,
          status: 'open',
          observationCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          lastNotifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [assistantHealthAlerts.agentId, assistantHealthAlerts.kind],
        })
        .returning({ id: assistantHealthAlerts.id });
      if (created) {
        notify.push(signal);
        continue;
      }

      // An existing open alert is still observed; update the diagnostic detail
      // and count without moving its notification cooldown.
      await txDb
        .update(assistantHealthAlerts)
        .set({
          detail: signal.detail,
          status: 'open',
          observationCount: sql`${assistantHealthAlerts.observationCount} + 1`,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(assistantHealthAlerts.agentId, agentId),
            eq(assistantHealthAlerts.kind, signal.kind),
          ),
        );
    }

    const kinds = signals.map((signal) => signal.kind);
    await txDb
      .update(assistantHealthAlerts)
      .set({ status: 'resolved', updatedAt: now })
      .where(
        and(
          eq(assistantHealthAlerts.agentId, agentId),
          eq(assistantHealthAlerts.status, 'open'),
          kinds.length ? notInArray(assistantHealthAlerts.kind, kinds) : undefined,
        ),
      );
    return notify;
  });
}

/**
 * Deterministic operational health checks. This intentionally does not ask a
 * model to interpret telemetry: known bad thresholds become a concise owner
 * notification. Durable alerts deduplicate persistent incidents and reopen
 * automatically when a resolved condition returns.
 */
export async function runAssistantHealthMonitor(
  deps: {
    db: Db;
    heartbeat?: () => Promise<void>;
    /** Portable persistence; both are supplied together or not at all. */
    health?: AssistantHealthRepository;
    graphSync?: KnowledgeGraphSyncRepository;
    canaries?: ProactiveCanaryRepository;
    readTotals?: CostRepository['totals'];
    ownerTimeZone?: () => Promise<string>;
    notifyOwner?: ProactiveNotifier;
  },
  opts: { agentId: string; taskId?: string; now?: Date },
): Promise<HealthMonitorResult> {
  const health = deps.health ?? postgresAssistantHealth(deps.db);
  const now = opts.now ?? new Date();
  const config = loadConfig();
  const graphRagEnabled = config.GRAPH_RAG_ENABLED;
  const chatRecallEnabled = config.CHAT_RECALL_ENABLED;
  const staleBefore = new Date(now.getTime() - STALE_GRAPH_PENDING_MS);
  const qualitySince = new Date(now.getTime() - QUALITY_WINDOW_MS);
  await deps.heartbeat?.();

  const [observed, graphBacklog, mail, canaries, budget, briefing] = await Promise.all([
    health.observe({ agentId: opts.agentId, staleBefore, qualitySince }),
    graphRagEnabled
      ? pendingKnowledgeGraphSourceCount(deps.graphSync ?? deps.db, opts.agentId)
      : Promise.resolve(0),
    health.observeMail?.(opts.agentId, mailHealthWindow(now)),
    deps.canaries ? assessProactiveCanaries(deps.canaries, opts.agentId, config, now) : undefined,
    deps.readTotals ? dailyBudgetHoldHealth(deps.readTotals) : undefined,
    deps.canaries?.briefing(opts.agentId, now).catch(() => ({ state: 'unavailable' })),
  ]);
  const {
    graphQuarantined: quarantined,
    graphStalePending: stalePending,
    graphRecallFailures,
    historyRecallFailures,
    verifierUnavailable,
    contractBlocks,
    mustActRetries,
    degradedSteps,
  } = observed;
  const mailIntake = mailIntakeStallDetails(mail, 'health');
  const mailExtraction = mail?.mailPendingOver6h7d ?? 0;
  const stalledMail = [
    ...mailIntake,
    ...(mailExtraction ? [`${mailExtraction} awaiting extraction`] : []),
  ];
  const signals: AssistantHealthSignal[] = [
    stalledMail.length > 0
      ? {
          kind: 'mail_processing_stalled',
          detail: `Mail processing has waited over six hours: ${stalledMail.join(', ')}.`,
          notificationDueBefore: new Date(now.getTime() - MAIL_ALERT_RENOTIFY_MS),
        }
      : null,
    graphRagEnabled && quarantined > 0
      ? {
          kind: 'graph_quarantined',
          detail: `${quarantined} GraphRAG source${quarantined === 1 ? '' : 's'} quarantined after bounded retries; retry paused sources from Knowledge review when the provider recovers.`,
        }
      : null,
    graphRagEnabled && stalePending > 0
      ? {
          kind: 'graph_stale_pending',
          detail: `${stalePending} GraphRAG source${stalePending === 1 ? '' : 's'} stuck in a pending lease for over ten minutes.`,
        }
      : null,
    graphRagEnabled && graphBacklog >= MIN_GRAPH_BACKLOG
      ? {
          kind: 'graph_backlog',
          detail: `${graphBacklog} GraphRAG source facts are waiting to be indexed. Check sync capacity or the extraction provider before memory freshness degrades.`,
        }
      : null,
    graphRagEnabled && graphRecallFailures >= MIN_GRAPH_RECALL_FAILURES
      ? {
          kind: 'graph_recall_unavailable',
          detail: `GraphRAG recall was unavailable ${graphRecallFailures} times in the last 24 hours; chat recall continued through the fallback path.`,
        }
      : null,
    chatRecallEnabled && historyRecallFailures >= MIN_HISTORY_RECALL_FAILURES
      ? {
          kind: 'history_recall_unavailable',
          detail: `Conversation memory recall was unavailable ${historyRecallFailures} times in the last 24 hours; responses continued without older-context retrieval.`,
        }
      : null,
    verifierUnavailable >= MIN_VERIFIER_UNAVAILABLE
      ? {
          kind: 'verification_unavailable',
          detail: `final-response verification was unavailable ${verifierUnavailable} times in the last 24 hours.`,
        }
      : null,
    contractBlocks >= MIN_CONTRACT_BLOCKS
      ? {
          kind: 'response_contract_blocks',
          detail: `the response contract corrected or blocked ${contractBlocks} final response${contractBlocks === 1 ? '' : 's'} in the last 24 hours.`,
        }
      : null,
    mustActRetries >= MIN_MUST_ACT_RETRIES
      ? {
          kind: 'must_act_retries',
          detail: `${mustActRetries} required-action step${mustActRetries === 1 ? '' : 's'} had to be retried without a tool call in the last 24 hours.`,
        }
      : null,
    degradedSteps >= MIN_DEGRADED_STEPS
      ? {
          kind: 'degraded_steps',
          detail: `${degradedSteps} workflow step${degradedSteps === 1 ? '' : 's'} used a fallback model in the last 24 hours.`,
        }
      : null,
  ].filter((signal): signal is HealthSignal => signal !== null);
  if (canaries) {
    for (const { key, detail } of proactiveCanaryProblems(canaries)) {
      signals.push({
        kind: `proactive_canary_${key}`,
        detail,
        notificationDueBefore: new Date(now.getTime() - MAIL_ALERT_RENOTIFY_MS),
      });
    }
  }

  const canaryReminderBefore = new Date(now.getTime() - MAIL_ALERT_RENOTIFY_MS);
  const budgetProblem = {
    at_threshold: 'Budget holds reached 25% of the daily spending cap.',
    above_threshold: 'Budget holds exceed 25% of the daily spending cap.',
    unavailable: 'Daily budget holds could not be checked.',
  };
  if (budget === 'at_threshold' || budget === 'above_threshold' || budget === 'unavailable') {
    signals.push({
      kind: 'proactive_canary_budget',
      detail: budgetProblem[budget],
      notificationDueBefore: canaryReminderBefore,
    });
  }
  // The independent watchdog owns overdue briefings. Report other recorded
  // briefing failures here without opening a second notification for that outage.
  if (briefing && ['aborted', 'unavailable'].includes(briefing.state)) {
    signals.push({
      kind: 'proactive_canary_briefing',
      detail: 'The scheduled briefing could not be verified.',
      notificationDueBefore: canaryReminderBefore,
    });
  }

  const notify = await health.claim({
    agentId: opts.agentId,
    signals,
    now,
    renotifyBefore: new Date(now.getTime() - HEALTH_ALERT_RENOTIFY_MS),
  });
  if (notify.length) {
    try {
      await health.notify({
        agentId: opts.agentId,
        text: [
          '⚠️ Assistant health needs attention:',
          ...notify.map((signal) => `• ${signal.detail}`),
          'These are deterministic checks; no configuration was changed automatically.',
        ].join('\n'),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      });
    } catch (error) {
      // The alert is not considered delivered until the durable owner message
      // exists. Releasing just this claim lets the normal task retry report it.
      await health.release({
        agentId: opts.agentId,
        kinds: notify.map((signal) => signal.kind),
        claimedAt: now,
      });
      throw error;
    }
  }
  if (
    deps.notifyOwner &&
    deps.ownerTimeZone &&
    signals.some(({ kind }) => PROACTIVE_CANARY_ALERT_KINDS.some((canary) => canary === kind))
  ) {
    try {
      const day = ownerLocalDay(await deps.ownerTimeZone(), now);
      await deps.notifyOwner({
        deliveryKey: `health-canary:${day}`,
        purpose: 'health-canary',
        urgency: 'interrupt',
        text: HEALTH_CANARY_PUSH_TEXT,
        conversationId: null,
      });
    } catch {
      // Dashboard admission is durable. The next active run replays the same
      // push key if this attempt did not reach the outbox.
      console.error('Unable to request scheduled health push');
    }
  }

  return { signals: signals.map((signal) => signal.detail), notified: notify.length > 0 };
}

/** The PostgreSQL implementation of the monitor's persistence. */
function postgresAssistantHealth(db: Db): AssistantHealthRepository {
  return {
    kind: 'assistant-health-repository',
    observeMail: (agentId, window) => sqlMailHealthCounts(db, agentId, window),
    observe: ({ agentId, staleBefore, qualitySince }) =>
      observePostgresHealth(db, agentId, staleBefore, qualitySince),
    claim: ({ agentId, signals, now, renotifyBefore }) =>
      claimHealthNotifications(db, agentId, signals, now, renotifyBefore),
    release: async ({ agentId, kinds, claimedAt }) => {
      await db
        .update(assistantHealthAlerts)
        .set({ lastNotifiedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(assistantHealthAlerts.agentId, agentId),
            inArray(assistantHealthAlerts.kind, [...kinds]),
            eq(assistantHealthAlerts.lastNotifiedAt, claimedAt),
          ),
        );
    },
    notify: ({ agentId, text, taskId }) => notifyOwnerInNotifications(db, agentId, text, taskId),
  };
}

async function observePostgresHealth(
  db: Db,
  agentId: string,
  staleBefore: Date,
  qualitySince: Date,
): Promise<AssistantHealthObservations> {
  const [[quarantinedRow], [stalePendingRow], [recallRow], [quality]] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)` })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(and(eq(memories.agentId, agentId), eq(knowledgeGraphSources.status, 'quarantined'))),
    db
      .select({ value: sql<number>`count(*)` })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(
          eq(memories.agentId, agentId),
          eq(knowledgeGraphSources.status, 'pending'),
          lt(knowledgeGraphSources.updatedAt, staleBefore),
        ),
      ),
    db
      .select({
        graphFailures: sql<number>`count(*) FILTER (WHERE ${recallMetrics.graphFailed})`,
        historyFailures: sql<number>`count(*) FILTER (WHERE ${recallMetrics.historyFailed})`,
      })
      .from(recallMetrics)
      .where(and(eq(recallMetrics.agentId, agentId), gte(recallMetrics.createdAt, qualitySince))),
    db
      .select({
        verifierUnavailable: sql<number>`count(*) FILTER (WHERE ${responseChecks.outputVerificationUnavailable})`,
        contractBlocks: sql<number>`count(*) FILTER (WHERE ${responseChecks.blocked})`,
        mustActRetries: sql<number>`COALESCE(sum(${responseChecks.mustActRetries}), 0)`,
        degradedSteps: sql<number>`COALESCE(sum(${responseChecks.degradedSteps}), 0)`,
      })
      .from(responseChecks)
      .innerJoin(tasks, eq(tasks.id, responseChecks.taskId))
      .where(and(eq(tasks.agentId, agentId), gte(responseChecks.createdAt, qualitySince))),
  ]);

  return {
    graphQuarantined: Number(quarantinedRow?.value ?? 0),
    graphStalePending: Number(stalePendingRow?.value ?? 0),
    graphRecallFailures: Number(recallRow?.graphFailures ?? 0),
    historyRecallFailures: Number(recallRow?.historyFailures ?? 0),
    verifierUnavailable: Number(quality?.verifierUnavailable ?? 0),
    contractBlocks: Number(quality?.contractBlocks ?? 0),
    mustActRetries: Number(quality?.mustActRetries ?? 0),
    degradedSteps: Number(quality?.degradedSteps ?? 0),
  };
}
