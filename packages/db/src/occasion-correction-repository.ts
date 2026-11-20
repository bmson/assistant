import type {
  OccasionChatBinding,
  OccasionChatOperation,
  OccasionChatTool,
  OccasionCorrectionInput,
  OccasionCorrectionRepository,
  OccasionCorrectionResult,
  OccasionDeleteInput,
} from '@assistant/persistence';
import {
  isOccasionCorrectionDate,
  matchesSavedOccasion,
  occasionChatCallState,
  occasionChatResult,
  occasionCorrectionReadback,
  sameOccasionContactName,
} from '@assistant/persistence';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import {
  type PostgresPrivacyObservationTransaction,
  withPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { contacts, occasions, tasks, toolCalls } from './schema.js';

const CONTACT_SCAN_LIMIT = 5000;
const occasionVersion = sql<string>`xmin::text`;

async function prepareTarget(
  tx: PostgresPrivacyObservationTransaction,
  input: OccasionDeleteInput,
): Promise<OccasionChatBinding | OccasionCorrectionResult> {
  const people = await tx
    .select({ id: contacts.id, name: contacts.name })
    .from(contacts)
    .limit(CONTACT_SCAN_LIMIT + 1);
  if (people.length > CONTACT_SCAN_LIMIT) throw new Error('Occasion contact lookup exceeded bound');
  const matches = people.filter(({ name }) => sameOccasionContactName(name, input.subject));
  if (matches.length > 1) return { outcome: 'ambiguous_contact' } as const;
  const person = matches[0];
  if (!person) return { outcome: 'contact_not_found' } as const;

  const { expectedDate } = input;
  const [candidate] = await tx
    .select({ row: occasions, version: occasionVersion })
    .from(occasions)
    .where(
      and(
        eq(occasions.agentId, input.agentId),
        eq(occasions.contactId, person.id),
        eq(occasions.kind, input.kind),
        eq(occasions.month, expectedDate.month),
        eq(occasions.day, expectedDate.day),
      ),
    );
  if (!candidate || !matchesSavedOccasion(candidate.row, input))
    return { outcome: 'occasion_not_found' } as const;
  return {
    occasionId: candidate.row.id,
    contactId: person.id,
    expectedVersion: candidate.version,
  } satisfies OccasionChatBinding;
}

async function mutate(
  tx: PostgresPrivacyObservationTransaction,
  input: OccasionCorrectionInput | OccasionDeleteInput,
  binding: OccasionChatBinding,
): Promise<OccasionCorrectionResult> {
  const { expectedDate } = input;
  const eligible = and(
    eq(occasions.id, binding.occasionId),
    eq(occasions.agentId, input.agentId),
    eq(occasions.contactId, binding.contactId),
    eq(occasions.kind, input.kind),
    eq(occasions.month, expectedDate.month),
    eq(occasions.day, expectedDate.day),
    sql`${occasionVersion} = ${binding.expectedVersion}`,
  );
  const [old] = await tx.select().from(occasions).where(eligible).for('update');
  const [contact] = await tx
    .select({ name: contacts.name })
    .from(contacts)
    .where(eq(contacts.id, binding.contactId))
    .for('share');
  if (
    !old ||
    !matchesSavedOccasion(old, input) ||
    !contact ||
    !sameOccasionContactName(contact.name, input.subject)
  )
    return { outcome: 'stale_target' };

  if (!('date' in input)) {
    const [removed] = await tx.delete(occasions).where(eligible).returning();
    if (!removed) throw new Error('Occasion deletion lost its bound record');
    return { outcome: 'deleted', occasion: occasionCorrectionReadback(removed, contact.name) };
  }

  const date = { ...input.date, year: input.date.year === undefined ? old.year : input.date.year };
  if (!isOccasionCorrectionDate(date)) return { outcome: 'invalid_date' };
  const sameDay = old.month === date.month && old.day === date.day;
  if (sameDay && old.year === date.year)
    return { outcome: 'unchanged', occasion: occasionCorrectionReadback(old, contact.name) };
  if (!sameDay) {
    const [occupied] = await tx
      .select({ id: occasions.id })
      .from(occasions)
      .where(
        and(
          eq(occasions.agentId, input.agentId),
          eq(occasions.contactId, binding.contactId),
          eq(occasions.kind, old.kind),
          eq(occasions.month, date.month),
          eq(occasions.day, date.day),
        ),
      );
    if (occupied) return { outcome: 'date_conflict' };
  }
  const [saved] = await tx
    .update(occasions)
    .set({ ...date, updatedAt: sql`now()` })
    .where(eligible)
    .returning();
  if (!saved) throw new Error('Occasion correction lost its bound record');
  return { outcome: 'updated', occasion: occasionCorrectionReadback(saved, contact.name) };
}

export function createPostgresOccasionCorrectionRepository(db: Db): OccasionCorrectionRepository {
  async function execute(
    input: OccasionCorrectionInput | OccasionDeleteInput,
    operation: OccasionChatOperation,
    tool: OccasionChatTool,
  ) {
    async function transact(phase: 'prepare' | 'commit') {
      return withPostgresPrivacyObservationFence(db, input.agentId, async (tx) => {
        await assertPostgresInstallationOwner(tx, input.agentId);
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.id, operation.taskId),
              eq(tasks.agentId, input.agentId),
              eq(tasks.status, 'running'),
              eq(tasks.trust, 'owner'),
              eq(tasks.type, 'chat_turn'),
              sql`${tasks.conversationId} is not null and ${tasks.trigger}->>'source' = 'chat'`,
              eq(tasks.leaseToken, operation.taskLeaseToken),
              gt(tasks.lockedUntil, sql`clock_timestamp()`),
            ),
          )
          .for('update');
        if (!task) throw new Error('Occasion operation lost its owner chat lease');
        const executing = and(
          eq(toolCalls.id, operation.dbToolCallId),
          eq(toolCalls.taskId, operation.taskId),
          eq(toolCalls.status, 'executing'),
        );
        const [call] = await tx
          .select()
          .from(toolCalls)
          .where(
            and(eq(toolCalls.id, operation.dbToolCallId), eq(toolCalls.taskId, operation.taskId)),
          )
          .for('update');
        const state = occasionChatCallState(call, input, operation, tool);
        if (state.result) return state.result;

        const finish = async (result: OccasionCorrectionResult) => {
          const receipt = occasionChatResult(operation, result);
          const [saved] = await tx
            .update(toolCalls)
            .set({ status: 'succeeded', result: receipt, finishedAt: sql`now()` })
            .where(executing)
            .returning({ id: toolCalls.id });
          if (!saved) throw new Error('Occasion receipt lost its executing call');
          return receipt;
        };
        if (phase === 'prepare') {
          if (state.binding) return undefined;
          const target = await prepareTarget(tx, input);
          if ('outcome' in target) return finish(target);
          await tx
            .update(toolCalls)
            .set({ decision: { ...state.decision, occasionMutation: target } })
            .where(executing);
          return undefined;
        }
        if (!state.binding) throw new Error('Occasion operation has no bound target');
        return finish(await mutate(tx, input, state.binding));
      });
    }

    const prepared = await transact('prepare');
    if (prepared) return prepared;
    const committed = await transact('commit');
    if (!committed) throw new Error('Occasion transaction did not settle its call');
    return committed;
  }

  return {
    correct: (input, operation) => execute(input, operation, 'occasions.update'),
    delete: (input, operation) => execute(input, operation, 'occasions.delete'),
  };
}
