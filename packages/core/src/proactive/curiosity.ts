import { type Db, postgresPrivacyObservationFence } from '@assistant/db';
import {
  type ExecutionPersistence,
  type NotificationDeliveryResult,
  notificationLeg,
} from '@assistant/persistence';
import { getAgent } from '../chat.js';
import { findGraphGaps, nextUnaskedGap } from '../memory/graph-gaps.js';
import { withSpan } from '../otel.js';
import { admitPostgresCuriosityQuestion } from './curiosity-admission.js';

/**
 * One question a day, at most, about something the assistant does not know.
 *
 * The knowledge graph is written entirely by extraction — it records what the
 * owner happened to mention and never goes looking. This is the other half:
 * the assistant noticing a structural hole (`memory/graph-gaps.ts` computes
 * them from rows, never from a model's imagination) and simply asking.
 *
 * The answer needs no machinery. It arrives as an ordinary reply in the
 * owner's thread, where `memory.extract` and then `memory.graph_sync` already
 * pick it up. That is why a question is a notice and not a suggestion: a
 * suggestion's "yes" enqueues a task, and there is no task here — the reply
 * *is* the outcome.
 *
 * Bounded hard, because a curious assistant becomes a tiresome one fast: one
 * question per run, one run a day, and a gap that has been asked once is never
 * asked again even if the owner ignored it.
 */

export interface CuriosityResult {
  gapsFound: number;
  asked: string | null;
  pinged: boolean;
  notification?: NotificationDeliveryResult;
  pushAdmission?: import('@assistant/persistence').CuriosityPushAdmission;
  status: 'skipped' | 'posted' | 'already-posted' | 'legacy-unknown';
}

export async function runCuriosity(
  deps: {
    db: Db;
    heartbeat?: () => Promise<void>;
    /** The portable graph reads and atomic question admission; PostgreSQL without them. */
    persistence?: Pick<ExecutionPersistence, 'graphCuriosity'>;
  },
  opts: { agentId?: string; taskId?: string; now?: Date } = {},
): Promise<CuriosityResult> {
  const { db } = deps;
  const now = opts.now ?? new Date();
  const graph = deps.persistence?.graphCuriosity;
  const portable = graph ? { graph } : null;

  return withSpan('proactive.curiosity', {}, async () => {
    const agentId = opts.agentId ?? (await getAgent(db)).id;
    if (portable && !opts.agentId)
      throw new Error('Portable curiosity requires its configured owner');
    const observationFence = portable
      ? await portable.graph.observationFence(agentId)
      : await postgresPrivacyObservationFence(db, agentId);
    const result: CuriosityResult = { gapsFound: 0, asked: null, pinged: false, status: 'skipped' };

    const gaps = await findGraphGaps(portable?.graph ?? db, agentId, now);
    result.gapsFound = gaps.length;
    await deps.heartbeat?.();

    const gap = await nextUnaskedGap(portable?.graph ?? db, agentId, gaps);
    // Nothing worth asking is the normal case, and it produces silence — the
    // same self-silence rule the briefing and the pulse follow.
    if (!gap) return result;

    const input = {
      agentId,
      key: gap.key,
      question: gap.question,
      now,
      observationFence,
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    };
    const admitted = portable
      ? await portable.graph.admitQuestion(input)
      : await admitPostgresCuriosityQuestion(db, input);
    result.status = admitted.status;
    if (admitted.status !== 'posted') return result;
    result.asked = gap.kind;
    result.pushAdmission = admitted.pushAdmission;
    // The dashboard copy and all eligible push destinations were committed
    // atomically above. Do not call the generic notifier after commit: it also
    // fans out to SMS, whose target cannot be captured by this repository
    // transaction. The push outbox drain owns delivery and records its receipt.
    const pushStatus = admitted.pushAdmission;
    result.notification =
      pushStatus.status === 'queued'
        ? notificationLeg('push', 'pending', 'durable-outbox-intent')
        : notificationLeg('push', pushStatus.status, pushStatus.reason);
    result.pinged = false;
    return result;
  });
}

/** The job registry's summary line. */
export function curiositySummary(result: CuriosityResult): string {
  if (result.status === 'legacy-unknown')
    return 'curiosity: legacy asked marker lacks a verified notice receipt; review required';
  if (result.status === 'already-posted') return 'curiosity: question already posted';
  if (!result.asked) return `curiosity: nothing to ask (${result.gapsFound} gap(s) known)`;
  return `curiosity: asked about a ${result.asked} gap${result.pinged ? ' + pinged' : ''}, ${result.gapsFound} known`;
}
