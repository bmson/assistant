import {
  type BriefingRunOutcome,
  briefingCursorName,
  createBriefingWatchdogRecord,
  readBriefingWatchdogRecord,
  savedBriefingMatches,
  shouldReplaceBriefingWatchdog,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, maintenanceCursors, messages, type TaskRow } from './schema.js';

export async function savePostgresBriefingWatchdog(
  tx: Pick<Db, 'select' | 'insert' | 'execute'>,
  task: Pick<TaskRow, 'id' | 'agentId' | 'trigger' | 'createdAt'>,
  outcome: BriefingRunOutcome,
) {
  const next = createBriefingWatchdogRecord('postgres', task, outcome, new Date());
  if (!next) return;
  const name = briefingCursorName(next.agentId, next.scheduleId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
  const [current] = await tx
    .select()
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, name));
  if (!shouldReplaceBriefingWatchdog(readBriefingWatchdogRecord(current?.cursor), next)) return;
  const cursor = JSON.stringify(next);
  await tx
    .insert(maintenanceCursors)
    .values({ name, cursor })
    .onConflictDoUpdate({
      target: maintenanceCursors.name,
      set: { cursor, updatedAt: sql`now()` },
    });
}

export async function readPostgresSavedBriefing(
  db: Pick<Db, 'select'>,
  agentId: string,
  taskId: string,
  expectedMessageId?: string,
): Promise<{ messageId: string; conversationId: string; createdAt: Date } | null> {
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.agentId, agentId),
        eq(messages.taskId, taskId),
        expectedMessageId ? eq(messages.id, expectedMessageId) : undefined,
      ),
    )
    .limit(51);
  if (rows.length > 50) throw new Error('Too many messages to verify one briefing publication');
  const matching = rows.filter(({ message }) => savedBriefingMatches(message, taskId));
  if (matching.length > 1) throw new Error('Multiple saved messages for one briefing task');
  const message = matching[0]?.message;
  return message
    ? {
        messageId: message.id,
        conversationId: message.conversationId,
        createdAt: message.createdAt,
      }
    : null;
}
