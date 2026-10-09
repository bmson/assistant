import {
  createPostgresAuditInvestigationRepository,
  createPostgresMessageRepository,
  createPostgresSelfRepairRepository,
  type Db,
  type ScheduleRow,
  schedules,
  type TaskRow,
} from '@assistant/db';
import type {
  DocumentExtractionRepository,
  EmailThreadHeadReader,
  ExecutionPersistence,
  ImportJobRepository,
  ReminderEventDependency,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import { getOrCreateNotificationsConversation, persistMessage } from '../chat.js';
import { loadConfig } from '../config.js';
import type { ModelRouter } from '../model-router/router.js';
import { curiositySummary, runCuriosity } from '../proactive/curiosity.js';
import type { ProactiveNotifier } from '../proactive/notify.js';
import { pingOwner } from '../proactive/notify.js';
import { pulseSummary, runPulse } from '../proactive/pulse.js';
import { fetchScoreboard, leagueByKey, type ScoreboardGame } from '../sports/index.js';
import { runAnomalyScan } from '../workflow/anomaly.js';
import {
  type BriefingCalendarReader,
  briefingSummary,
  type CalendarEventReader,
  runBriefing,
} from '../workflow/briefing.js';
import { runDream } from '../workflow/dream.js';
import { runAssistantHealthMonitor } from '../workflow/health-monitor.js';
import { runSelfImprove } from '../workflow/improve.js';
import { createGitHubRepairWorker } from '../workflow/repair-github.js';
import { createHostedRepairWorker } from '../workflow/repair-hosted.js';
import { runSelfMaintenance } from '../workflow/self-maintenance.js';
import { runRepairCycle } from '../workflow/self-repair.js';
import { runWatchSuggest } from '../workflow/watch-suggest.js';
import { refreshAmbientSnapshot } from './ambient.js';
import { extractCommitments, maintainCommitments } from './commitments.js';
import { runMemoryConsolidation } from './consolidation.js';
import { type DocumentProcessorConfig, runDocumentProcessing } from './document-processor.js';
import { runDocumentExtraction } from './documents.js';
import { pendingEmailExtractionCount, runEmailIngestExtraction } from './email-extraction.js';
import { runMemoryExtraction } from './extraction.js';
import { backfillGraphDates } from './graph-date-backfill.js';
import { runImportJob, type WorkspaceReader } from './import.js';
import {
  backfillKnowledgeGraphDates,
  countRelativeDateSources,
  graphSyncSpendUsd,
  pendingKnowledgeGraphSourceCount,
  syncKnowledgeGraph,
} from './knowledge-graph.js';
import { segmentConversations } from './segmentation.js';
import { runSkillReflection } from './skill-reflect.js';
import { runVoiceIngest } from './voice-ingest.js';

export type ReminderSportsScoreboardReader = (input: {
  league: string;
  date: string;
  timeZone: string;
  now: Date;
}) => Promise<ScoreboardGame[]>;

export function isExactCompletedSportsOccurrence(
  dependency: ReminderEventDependency,
  games: readonly ScoreboardGame[],
): boolean {
  const exact = games.filter(
    (game) =>
      game.id === dependency.eventId &&
      game.league === dependency.league &&
      game.startsAt === dependency.startsAt &&
      game.home.id === dependency.homeTeamId &&
      game.away.id === dependency.awayTeamId,
  );
  return exact.length === 1 && exact[0]?.state === 'post';
}

/**
 * Code jobs: tasks whose trigger payload carries { job: '<name>' } run a
 * registered function instead of the model step loop. Costs still meter to
 * the task (model/embed calls pass taskId), failures go through the normal
 * retry/dead-letter machinery, and a job may yield (done: false) to sleep
 * and resume from its checkpoint — that's how imports survive interruption.
 */
export type CodeJobName =
  | 'memory.extract'
  | 'email.extract'
  | 'reminder.notify'
  | 'briefing.compose'
  | 'memory.consolidate'
  | 'memory.sweep_loops'
  | 'memory.graph_sync'
  | 'memory.graph_date_backfill'
  | 'chat.segment'
  | 'import.run'
  | 'voice.ingest'
  | 'anomaly.scan'
  | 'skill.reflect'
  | 'self.improve'
  | 'documents.extract'
  | 'documents.process'
  | 'ambient.refresh'
  | 'dream.run'
  | 'self.maintain'
  | 'self.repair'
  | 'health.monitor'
  | 'watch.suggest'
  | 'pulse.check'
  | 'graph.curiosity';

const CODE_JOBS: ReadonlySet<string> = new Set([
  'memory.extract',
  'email.extract',
  'reminder.notify',
  'briefing.compose',
  'memory.consolidate',
  'memory.sweep_loops',
  'memory.graph_sync',
  'memory.graph_date_backfill',
  'chat.segment',
  'import.run',
  'voice.ingest',
  'anomaly.scan',
  'skill.reflect',
  'self.improve',
  'documents.extract',
  'documents.process',
  'ambient.refresh',
  'dream.run',
  'self.maintain',
  'self.repair',
  'health.monitor',
  'watch.suggest',
  'pulse.check',
  'graph.curiosity',
]);

/**
 * Feature-gated jobs remain registered so schedules can safely be seeded in
 * every environment. The scheduler advances a disabled job without creating
 * task rows, and a manually queued job completes without provider work.
 */
export function isCodeJobEnabled(job: string): boolean {
  if (job === 'self.repair') return loadConfig().SELF_REPAIR_ENABLED;
  // Everything that reads or writes the knowledge graph rides the same switch —
  // curiosity included, since a graph that is turned off has no gaps to ask
  // about and would otherwise produce a question built on nothing.
  const needsGraph = job.startsWith('memory.graph_') || job.startsWith('graph.');
  return !needsGraph || loadConfig().GRAPH_RAG_ENABLED;
}

/**
 * Code jobs whose Firestore composition reaches storage only through
 * `ExecutionPersistence` ports. Every other job still needs PostgreSQL. Under
 * Firestore those jobs are skipped at the schedule and complete benignly if
 * already queued, instead of failing into the SQL tripwire and dead-lettering
 * with an owner notice. Add a job here only with an emulator test that runs it
 * against a throwing SQL proxy.
 */
const FIRESTORE_PORTABLE_CODE_JOBS: ReadonlySet<string> = new Set([
  'reminder.notify',
  'memory.extract',
  'memory.sweep_loops',
  'memory.consolidate',
  'memory.graph_sync',
  'briefing.compose',
  'chat.segment',
  'ambient.refresh',
  'health.monitor',
  'documents.extract',
  'watch.suggest',
  'import.run',
  'voice.ingest',
  'dream.run',
  'pulse.check',
  'anomaly.scan',
  'skill.reflect',
  'self.maintain',
  'self.repair',
  'self.improve',
  'memory.graph_date_backfill',
  'graph.curiosity',
  'documents.process',
  'email.extract',
]);

/** Registered code jobs that still need PostgreSQL, so a Firestore agent skips them. */
export function sqlOnlyCodeJobs(): string[] {
  return [...CODE_JOBS].filter((job) => !FIRESTORE_PORTABLE_CODE_JOBS.has(job)).sort();
}

/** A completion summary when `job` cannot run on Firestore persistence yet, otherwise null. */
export function firestoreCodeJobUnavailable(job: string): string | null {
  if (!CODE_JOBS.has(job) || FIRESTORE_PORTABLE_CODE_JOBS.has(job)) return null;
  return `${job} skipped because it is not yet available on Firestore persistence`;
}

export interface CodeJobOutcome {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

export function codeJobName(task: TaskRow): CodeJobName | null {
  const payload = (task.trigger as { payload?: { job?: unknown } } | null)?.payload;
  const job = typeof payload?.job === 'string' ? payload.job : null;
  return job && CODE_JOBS.has(job) ? (job as CodeJobName) : null;
}

/**
 * A delivered reminder lands in the owner's primary thread, beside their chat
 * replies. The card is what tells them apart — on screen, and in the window a
 * later chat turn is seeded from (see backgroundNoticeIds in chat.ts). Without
 * it a fired reminder reads as the assistant's own last conversational turn.
 */
function reminderMessageParts(taskId: string, reminderText: string): unknown[] {
  return [
    { type: 'text', text: reminderText },
    {
      type: 'data-card',
      data: {
        kind: 'proactive-alert',
        id: `reminder-fired:${taskId}`,
        category: 'commitment',
        urgencyLabel: 'Reminder',
        title: reminderText,
      },
    },
  ];
}

export async function runCodeJob(
  deps: {
    db: Db;
    router: ModelRouter;
    workspace?: WorkspaceReader;
    documentProcessor?: DocumentProcessorConfig;
    /**
     * Calendar read for the briefing, injected by the composition root when
     * the google module is installed (core holds no provider credentials).
     */
    calendarReader?: BriefingCalendarReader;
    calendarEventReader?: CalendarEventReader;
    emailThreadReader?: EmailThreadHeadReader;
    calendarCancellationEnabled?: boolean;
    /** Synthetic provider seam for event-completion reminders; production uses the built-in scores reader. */
    reminderSportsScoreboardReader?: ReminderSportsScoreboardReader;
    /**
     * The phone leg for proactive jobs, injected by the composition root.
     * Without it a job still posts its dashboard copy — the owner just has to
     * open the app to find it, which is exactly the silence this exists to fix.
     */
    notifyOwner?: ProactiveNotifier;
    persistence?: ExecutionPersistence;
    documentExtractionRepository?: DocumentExtractionRepository;
    /** Firestore-backed import lifecycle selected by the Firestore agent composition. */
    importJobRepository?: ImportJobRepository;
    heartbeat?: () => Promise<void>;
    /**
     * Supplied by the composition root: returns a completion summary when the
     * module owning this job is not installed. A job queued before its module
     * was removed then completes benignly instead of dead-lettering. Core does
     * not know which module owns which job.
     */
    jobUnavailable?: (job: CodeJobName) => string | null;
  },
  job: CodeJobName,
  task: TaskRow,
): Promise<CodeJobOutcome> {
  const unavailable = deps.jobUnavailable?.(job);
  if (unavailable) return { done: true, summary: unavailable };
  switch (job) {
    case 'reminder.notify': {
      const payload = (
        task.trigger as {
          payload?: {
            reminderText?: unknown;
            instruction?: unknown;
            reminderKind?: unknown;
            scheduleId?: unknown;
            schedule?: unknown;
            occurrenceId?: unknown;
            reminderEventDependency?: unknown;
          };
        } | null
      )?.payload;
      const reminderText =
        typeof payload?.reminderText === 'string' && payload.reminderText.trim()
          ? payload.reminderText.trim()
          : typeof payload?.instruction === 'string'
            ? payload.instruction
                .replace(/^Reminder for the owner:\s*/i, '')
                .split(/\n\n/)[0]
                ?.trim()
            : '';
      if (!reminderText) {
        return { done: true, summary: 'reminder: missing reminder text' };
      }
      const scheduleId = typeof payload?.scheduleId === 'string' ? payload.scheduleId : null;
      const scheduleName = typeof payload?.schedule === 'string' ? payload.schedule : null;
      if (payload?.reminderKind === 'event_completion') {
        const dependency = payload.reminderEventDependency as ReminderEventDependency | undefined;
        if (
          dependency?.provider !== 'sports' ||
          !dependency.eventId ||
          !dependency.league ||
          !dependency.eventDate ||
          !dependency.timezone ||
          !dependency.homeTeamId ||
          !dependency.awayTeamId
        ) {
          return { done: true, summary: 'reminder: event dependency is incomplete; not delivered' };
        }
        const league = leagueByKey(dependency.league);
        if (!league)
          return { done: true, summary: 'reminder: event league is unsupported; not delivered' };
        const now = new Date();
        const readScoreboard: ReminderSportsScoreboardReader =
          deps.reminderSportsScoreboardReader ??
          ((input) =>
            fetchScoreboard({
              league,
              date: input.date,
              timeZone: input.timeZone,
              now: input.now,
            }));
        const games = await readScoreboard({
          league: league.key,
          date: dependency.eventDate,
          timeZone: dependency.timezone,
          now,
        });
        const exact = games.filter(
          (game) =>
            game.id === dependency.eventId &&
            game.league === dependency.league &&
            game.startsAt === dependency.startsAt &&
            game.home.id === dependency.homeTeamId &&
            game.away.id === dependency.awayTeamId,
        );
        if (exact.length !== 1)
          return {
            done: true,
            summary:
              'reminder: exact fixture not present in current provider result; not delivered',
          };
        if (!isExactCompletedSportsOccurrence(dependency, games))
          return {
            done: true,
            summary: 'reminder: verified fixture has not finished; next check remains scheduled',
          };
      }

      // Portable stores commit the message, the occurrence receipt, and the
      // one-time delivered stamp in one fenced write. Every reminder they fire
      // carries its schedule occurrence, so a missing one is refused rather
      // than delivered without the cancellation and duplicate fences.
      const reminderDelivery = deps.persistence?.reminderDelivery;
      if (reminderDelivery) {
        const occurrenceId =
          typeof payload?.occurrenceId === 'string' ? payload.occurrenceId : null;
        if (!scheduleId || !occurrenceId)
          throw new Error('reminder: portable delivery requires the firing schedule occurrence');
        if (!task.lockedUntil) throw new Error('reminder: delivery requires an active task lease');
        const outcome = await reminderDelivery.deliver({
          agentId: task.agentId,
          reminderId: scheduleId,
          occurrenceId,
          lease: { ...task, lockedUntil: task.lockedUntil },
          conversationId: task.conversationId,
          text: reminderText,
          parts: reminderMessageParts(task.id, reminderText),
        });
        if (!outcome.delivered)
          return {
            done: true,
            summary: 'reminder: not delivered (cancelled, already delivered, or lease lost)',
          };
        const pinged = await pingOwner(deps.notifyOwner, {
          taskId: task.id,
          conversationId: outcome.conversationId,
          text: reminderText,
        });
        return { done: true, summary: `reminder: delivered${pinged ? ' and pinged' : ''}` };
      }

      const managedSchedule = Boolean(scheduleId || scheduleName?.startsWith('reminder:'));
      const [initialSchedule] = managedSchedule
        ? await deps.db
            .select()
            .from(schedules)
            .where(
              and(
                eq(schedules.agentId, task.agentId),
                scheduleId
                  ? eq(schedules.id, scheduleId)
                  : eq(schedules.name, scheduleName as string),
              ),
            )
            .limit(1)
        : [undefined];
      if (managedSchedule && !initialSchedule) {
        return { done: true, summary: 'reminder: cancelled before delivery' };
      }

      const deliver = async (database: Db, schedule?: ScheduleRow): Promise<CodeJobOutcome> => {
        const template = (schedule?.taskTemplate ?? {}) as {
          reminderKind?: 'once' | 'recurring' | 'event_completion';
          reminderCancelledAt?: string;
          reminderDeliveredAt?: string;
        };
        if (
          template.reminderCancelledAt ||
          template.reminderDeliveredAt ||
          (schedule && template.reminderKind !== 'once' && !schedule.enabled)
        ) {
          return { done: true, summary: 'reminder: cancelled before delivery' };
        }
        const conversationId =
          task.conversationId ??
          (await getOrCreateNotificationsConversation(database, task.agentId));
        await persistMessage(database, {
          conversationId,
          taskId: task.id,
          role: 'assistant',
          origin: 'assistant',
          parts: reminderMessageParts(task.id, reminderText),
          text: reminderText,
        });
        const pinged = await pingOwner(deps.notifyOwner, {
          taskId: task.id,
          conversationId,
          text: reminderText,
        });
        if (schedule && template.reminderKind === 'event_completion') {
          await database
            .update(schedules)
            .set({
              enabled: false,
              nextRunAt: null,
              taskTemplate: { ...template, reminderDeliveredAt: new Date().toISOString() },
              updatedAt: sql`now()`,
            })
            .where(eq(schedules.id, schedule.id));
        } else if (schedule && template.reminderKind === 'once') {
          await database
            .update(schedules)
            .set({
              taskTemplate: { ...template, reminderDeliveredAt: new Date().toISOString() },
              updatedAt: sql`now()`,
            })
            .where(eq(schedules.id, schedule.id));
        }
        return {
          done: true,
          summary: `reminder: delivered${pinged ? ' and pinged' : ''}`,
        };
      };

      if (!initialSchedule) return deliver(deps.db);
      return deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${initialSchedule.id}))`);
        const [lockedSchedule] = await tx
          .select()
          .from(schedules)
          .where(eq(schedules.id, initialSchedule.id))
          .limit(1);
        if (!lockedSchedule) {
          return { done: true, summary: 'reminder: cancelled before delivery' };
        }
        return deliver(tx as unknown as Db, lockedSchedule);
      });
    }
    case 'memory.extract': {
      await deps.heartbeat?.();
      // Read at each commit: every heartbeat renewal rotates the lease token.
      const lease = () => ({ taskId: task.id, leaseToken: task.leaseToken ?? '' });
      const r = await runMemoryExtraction(deps, {
        taskId: task.id,
        agentId: task.agentId,
        lease,
      });
      const loops = await extractCommitments(deps, {
        agentId: task.agentId,
        taskId: task.id,
        lease,
      });
      const failuresByCategory = r.failedBatches.reduce<Record<string, number>>(
        (counts, failure) => {
          counts[failure.category] = (counts[failure.category] ?? 0) + 1;
          return counts;
        },
        {},
      );
      const deferred = r.failedBatches.length
        ? `, ${r.failedBatches.length} deferred batch(es): ${Object.entries(failuresByCategory)
            .map(([category, count]) => `${count} ${category}`)
            .join(', ')}`
        : '';
      return {
        done: true,
        summary: `extraction: ${r.saved} saved (${r.quarantined} quarantined, ${r.contactsCreated} new people), ${r.duplicates} duplicate, ${r.tombstoned} tombstoned, ${r.occasionsSaved} occasion(s), ${r.occasionsRejected} occasion(s) rejected, from ${r.conversationsScanned} conversation(s)${deferred}; open loops ${loops.saved} saved (${loops.duplicates} duplicate)`,
      };
    }
    // Wake obligations independently of model-backed extraction and its budget.
    case 'memory.sweep_loops': {
      const result = await maintainCommitments(
        deps.persistence?.commitmentMaintenance ?? deps.db,
        task.agentId,
      );
      return {
        done: true,
        summary: `open loops: ${result.woken} snooze(s) woken, ${result.restored} legacy obligation(s) restored`,
      };
    }
    case 'email.extract': {
      await deps.heartbeat?.();
      const extraction = deps.persistence?.emailExtraction;
      const r = await runEmailIngestExtraction(
        { ...deps, ...(extraction ? { store: extraction } : {}) },
        { taskId: task.id },
      );
      const pending = await pendingEmailExtractionCount(extraction ?? deps.db);
      return {
        // A backlog drains across runs rather than in one long job: report it
        // so a mailbox that is falling behind is visible in the task summary.
        done: true,
        summary:
          `email extraction: ${r.saved} saved (${r.usable} recallable, ${r.quarantined} awaiting review), ` +
          `${r.duplicates} duplicate, ${r.occasionsSaved} occasion(s), from ${r.rowsVisited} message(s) ` +
          `(${r.skippedLowImportance} routine), ${pending} still pending`,
      };
    }
    case 'graph.curiosity': {
      if (!isCodeJobEnabled(job)) {
        return { done: true, summary: 'curiosity: knowledge graph disabled' };
      }
      await deps.heartbeat?.();
      return {
        done: true,
        summary: curiositySummary(
          await runCuriosity(deps, { agentId: task.agentId, taskId: task.id }),
        ),
      };
    }
    case 'pulse.check': {
      await deps.heartbeat?.();
      return {
        done: true,
        summary: pulseSummary(await runPulse(deps, { taskId: task.id, agentId: task.agentId })),
      };
    }
    case 'briefing.compose': {
      await deps.heartbeat?.();
      return {
        done: true,
        summary: briefingSummary(
          await runBriefing(deps, { taskId: task.id, agentId: task.agentId }),
        ),
      };
    }
    case 'memory.consolidate': {
      await deps.heartbeat?.();
      const r = await runMemoryConsolidation(deps, { taskId: task.id, agentId: task.agentId });
      return {
        done: true,
        summary: `consolidation: ${r.memoriesReviewed + r.standaloneReviewed} memories reviewed in ${r.batches} batch(es) across ${r.entities} people, ${r.duplicatesExpired} duplicates expired, ${r.contradictionsResolved} contradictions resolved, ${r.factsUnified} facts unified, ${r.domainsAssigned} domains assigned, ${r.occasionsSaved} occasion(s) found, owner card recompiled`,
      };
    }
    case 'memory.graph_sync': {
      if (!isCodeJobEnabled(job)) {
        return { done: true, summary: 'knowledge graph: disabled' };
      }
      await deps.heartbeat?.();
      const graphSync = deps.persistence?.graphSync;
      if (deps.persistence && !graphSync)
        throw new Error('Knowledge graph sync repository is missing from execution persistence');
      const r = await syncKnowledgeGraph(
        { db: deps.db, router: deps.router, graphSync },
        {
          taskId: task.id,
          agentId: task.agentId,
          heartbeat: deps.heartbeat,
        },
      );
      const [pending, spentUsd] = await Promise.all([
        pendingKnowledgeGraphSourceCount(graphSync ?? deps.db, task.agentId),
        graphSyncSpendUsd(graphSync ?? deps.db, task.id),
      ]);
      return {
        done: true,
        summary:
          `knowledge graph: ${r.relationships} relation(s) from ${r.processed}/${r.candidates} source(s), ` +
          `${r.failed} retrying, ${r.quarantined} quarantined, ${pending} pending, ` +
          `$${spentUsd.toFixed(4)} spent`,
      };
    }
    // Deliberately free: it re-reads labels the graph already holds and never
    // calls a model, so it can run over the whole corpus in one go. Sources it
    // cannot fix are only counted — paying to re-extract them stays the owner's
    // explicit choice, made from the review page.
    case 'memory.graph_date_backfill': {
      if (!isCodeJobEnabled(job)) {
        return { done: true, summary: 'knowledge graph dates: disabled' };
      }
      await deps.heartbeat?.();
      const portable = deps.persistence?.graphDateBackfill;
      const r = portable
        ? await backfillGraphDates(portable, task.agentId)
        : await backfillKnowledgeGraphDates(deps.db, { agentId: task.agentId });
      const remaining = portable
        ? await portable.countRelativeDateSources(task.agentId)
        : await countRelativeDateSources(deps.db, task.agentId);
      return {
        done: true,
        summary:
          `knowledge graph dates: ${r.canonicalized} canonicalized, ${r.merged} merged, ` +
          `${r.unresolved} unresolved of ${r.scanned} scanned, ` +
          `${remaining} source(s) would need re-extraction`,
      };
    }
    case 'chat.segment': {
      await deps.heartbeat?.();
      const segments = deps.persistence?.conversationSegmentation;
      const r = await segmentConversations(
        { db: deps.db, router: deps.router, ...(segments ? { segments } : {}) },
        { taskId: task.id, agentId: task.agentId },
      );
      return {
        done: true,
        summary: `segmentation: ${r.segmentsCreated} new segment(s) across ${r.conversationsScanned} conversation(s)`,
      };
    }
    case 'import.run':
      return runImportJob(
        {
          ...deps,
          imports: deps.importJobRepository,
          ownerCards: deps.persistence?.ownerCardCompilation,
        },
        task,
      );
    case 'voice.ingest':
      return runVoiceIngest({ ...deps, imports: deps.importJobRepository }, task);
    case 'anomaly.scan': {
      await deps.heartbeat?.();
      const r = await runAnomalyScan(deps, { agentId: task.agentId, taskId: task.id });
      const kinds = Object.entries(r.byKind)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      return {
        done: true,
        summary: `anomaly scan: ${r.flagged} new anomal${r.flagged === 1 ? 'y' : 'ies'}${kinds ? ` (${kinds})` : ''}`,
      };
    }
    case 'skill.reflect': {
      await deps.heartbeat?.();
      const r = await runSkillReflection(deps, { taskId: task.id });
      return {
        done: true,
        summary: `skill reflection: ${r.skillsDrafted} skill(s) drafted from ${r.tasksReviewed} reviewed task(s)`,
      };
    }
    case 'self.improve': {
      await deps.heartbeat?.();
      const r = await runSelfImprove(deps, {
        agentId: task.agentId,
        taskId: task.id,
        // Read at commit: every heartbeat renewal rotates the lease token.
        lease: () => ({ taskId: task.id, leaseToken: task.leaseToken ?? '' }),
      });
      return {
        done: true,
        summary: `self-improve: ${r.proposalsDrafted} proposal(s) from ${r.patterns} failure pattern(s)${r.experienceSaved ? ', experience saved' : ''}`,
      };
    }
    case 'documents.extract': {
      const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload;
      const documentId = String(payload?.documentId ?? '');
      if (!documentId) throw new Error('document extract payload needs a documentId');
      const repository = deps.documentExtractionRepository;
      return runDocumentExtraction(
        {
          db: deps.db,
          router: deps.router,
          workspace: deps.workspace,
          heartbeat: deps.heartbeat,
          ...(repository
            ? {
                documentExtraction: {
                  repository,
                  fence: () => {
                    if (!task.leaseToken)
                      throw new Error('document extraction task has no active lease token');
                    return {
                      agentId: task.agentId,
                      documentId,
                      taskId: task.id,
                      queueGeneration: task.queueGeneration,
                      leaseToken: task.leaseToken,
                    };
                  },
                },
              }
            : {}),
        },
        task,
      );
    }
    case 'documents.process':
      return runDocumentProcessing(
        {
          db: deps.db,
          ...(deps.persistence?.documentProcessor
            ? { processorStore: deps.persistence.documentProcessor }
            : {}),
          documentProcessor: deps.documentProcessor,
          heartbeat: deps.heartbeat,
        },
        task,
      );
    case 'ambient.refresh': {
      await deps.heartbeat?.();
      const snapshots = deps.persistence?.ambientSnapshots;
      const r = await refreshAmbientSnapshot(
        {
          db: deps.db,
          heartbeat: deps.heartbeat,
          ...(snapshots && deps.persistence
            ? { portable: { ownerContext: deps.persistence.ownerContext, snapshots } }
            : {}),
        },
        { agentId: task.agentId },
      );
      return {
        done: true,
        summary: r.computed
          ? `ambient: refreshed (location${r.hasWeather ? ' + weather' : ', no weather'})`
          : 'ambient: no fresh location — snapshot cleared',
      };
    }
    case 'dream.run': {
      await deps.heartbeat?.();
      const r = await runDream(deps, {
        agentId: task.agentId,
        taskId: task.id,
        // Read at commit: every heartbeat renewal rotates the lease token.
        lease: () => ({ taskId: task.id, leaseToken: task.leaseToken ?? '' }),
      });
      return {
        done: true,
        summary: `dream: ${r.footnotes} footnote(s), ${r.hypotheses} hypothesis(es), ${r.anticipations} anticipation(s)`,
      };
    }
    case 'self.repair': {
      const config = loadConfig();
      if (!config.SELF_REPAIR_ENABLED) return { done: true, summary: 'self-repair: disabled' };
      const repository =
        deps.persistence?.selfRepair ?? createPostgresSelfRepairRepository(deps.db);
      const audit =
        deps.persistence?.selfRepairAudit ?? createPostgresAuditInvestigationRepository(deps.db);
      const legacyWorker =
        config.GITHUB_TOKEN && config.GITHUB_REPO
          ? createGitHubRepairWorker({
              token: config.GITHUB_TOKEN,
              repo: config.GITHUB_REPO,
              workerRepo: config.SELF_REPAIR_WORKER_REPO,
              workflow: config.SELF_REPAIR_WORKFLOW,
              ref: config.SELF_REPAIR_REF,
              deploymentUrl: config.SELF_REPAIR_DEPLOYMENT_URL,
            })
          : undefined;
      const hostedWorker =
        config.SELF_REPAIR_OPENAI_API_KEY && config.SELF_REPAIR_GITHUB_TOKEN && config.GITHUB_REPO
          ? createHostedRepairWorker({
              apiKey: config.SELF_REPAIR_OPENAI_API_KEY,
              publisherToken: config.SELF_REPAIR_GITHUB_TOKEN,
              repo: config.GITHUB_REPO,
              model: config.SELF_REPAIR_CODING_MODEL,
              effort: config.SELF_REPAIR_REASONING_EFFORT,
              allowExecutor: config.SELF_REPAIR_ALLOW_EXECUTOR,
              deploymentUrl: config.SELF_REPAIR_DEPLOYMENT_URL,
            })
          : undefined;
      const selectedWorker = config.SELF_REPAIR_PROVIDER === 'github' ? legacyWorker : hostedWorker;
      if (!selectedWorker)
        throw new Error(
          'Self-repair is enabled but its selected coding provider credentials are not configured',
        );
      const worker = {
        ...selectedWorker,
        cleanup: hostedWorker?.cleanup,
        // Reconcile each attempt through its original provider, including during rollback.
        inspect: (issue: Parameters<typeof selectedWorker.inspect>[0]) =>
          issue.data.workerProvider === 'openai_hosted'
            ? (hostedWorker?.inspect(issue) ?? Promise.resolve(null))
            : (legacyWorker?.inspect(issue) ?? Promise.resolve(null)),
      };
      const dispatched = await runRepairCycle(
        {
          repository,
          audit,
          router: deps.router,
          worker,
          enabled: config.SELF_REPAIR_ENABLED,
          allowExecutor: config.SELF_REPAIR_ALLOW_EXECUTOR,
          dailyLimit: config.SELF_REPAIR_DAILY_LIMIT,
          diagnostics: {
            persistenceDriver: config.PERSISTENCE_DRIVER,
            modules: config.ASSISTANT_MODULES,
            calendarReaderAvailable: Boolean(deps.calendarReader),
          },
          heartbeat: deps.heartbeat,
          notify: async (issue, text) => {
            const conversationId = deps.persistence
              ? await deps.persistence.notifications.getOrCreate(task.agentId)
              : await getOrCreateNotificationsConversation(deps.db, task.agentId);
            const messages = deps.persistence?.messages ?? createPostgresMessageRepository(deps.db);
            // Repair progress is a log, not a conversation: it lives in
            // Notifications and on the Improvements page. It is deliberately
            // not mirrored into the owner's chat or sent to their phone — a
            // single failing fix once produced a message every few minutes.
            await messages.append({
              conversationId,
              taskId: task.id,
              role: 'assistant',
              origin: 'assistant',
              parts: [{ type: 'text', text }],
              text,
              channelMessageId: `self-repair:${issue.id}:${issue.status}:${issue.data.history.at(-1)?.at ?? issue.updatedAt.toISOString()}`,
            });
          },
        },
        task.agentId,
        task.id,
      );
      return { done: true, summary: `self-repair: ${dispatched} coding run(s) dispatched` };
    }
    case 'self.maintain': {
      await deps.heartbeat?.();
      const r = await runSelfMaintenance(
        {
          ...deps,
          persistence: {
            ...deps.persistence,
            selfRepair: deps.persistence?.selfRepair ?? createPostgresSelfRepairRepository(deps.db),
          },
        },
        { agentId: task.agentId, taskId: task.id },
      );
      return {
        done: true,
        summary: `self-maintain: ${r.backlog} backlog item(s), ${r.blocked} blocked by the fence`,
      };
    }
    case 'health.monitor': {
      await deps.heartbeat?.();
      const health = deps.persistence?.assistantHealth;
      const r = await runAssistantHealthMonitor(
        {
          db: deps.db,
          heartbeat: deps.heartbeat,
          ...(health && deps.persistence ? { health, graphSync: deps.persistence.graphSync } : {}),
        },
        { agentId: task.agentId, taskId: task.id },
      );
      return {
        done: true,
        summary: r.notified
          ? `health monitor: notified owner about ${r.signals.length} signal(s)`
          : 'health monitor: no active signals',
      };
    }
    case 'watch.suggest': {
      await deps.heartbeat?.();
      const payload = (
        task.trigger as { payload?: { watchId?: unknown; triggerRef?: unknown } } | null
      )?.payload;
      if (typeof payload?.watchId !== 'string' || typeof payload?.triggerRef !== 'string') {
        return { done: true, summary: 'watch.suggest: malformed payload' };
      }
      const r = await runWatchSuggest(
        {
          db: deps.db,
          router: deps.router,
          persistence: deps.persistence,
          heartbeat: deps.heartbeat,
        },
        {
          agentId: task.agentId,
          taskId: task.id,
          watchId: payload.watchId,
          triggerRef: payload.triggerRef,
        },
      );
      return { done: true, summary: r.summary };
    }
  }
}
