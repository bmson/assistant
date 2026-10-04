import { randomUUID } from 'node:crypto';
import { type PulseRepository, pulseDailyCap, validatePulseNotice } from '@assistant/persistence';
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { postgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  agents,
  conversations,
  messages,
  notificationPrefs,
  proactiveMoments,
  suggestions,
  tasks,
} from './schema.js';

/**
 * Admission is its own transaction boundary: no durable claim may exist
 * without the owner-visible message it represents. The owner row also
 * serializes distinct candidates and the privacy-erasure transaction.
 */
export function createPostgresPulseAdmissionRepository(
  db: Db,
): Pick<PulseRepository, 'observationFence' | 'admitNotice'> {
  return {
    observationFence: (agentId) => postgresPrivacyObservationFence(db, agentId),
    async admitNotice(input) {
      validatePulseNotice(input);
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          // Admissions and erasure must serialize, while another notifier may
          // insert its fallback chat with an owner FK under the shared advisory
          // lock. KEY SHARE is compatible with this lock, avoiding the reverse
          // owner/advisory lock cycle without weakening erasure's UPDATE lock.
          .for('no key update');
        if (!owner) throw new Error('Pulse owner row gone');
        const fence = await postgresPrivacyObservationFence(tx as unknown as Db, input.agentId);
        if (fence !== input.observationFence)
          throw new Error('Privacy erasure changed during pulse observation');
        if (input.taskId) {
          const [task] = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)));
          if (!task) throw new Error('Pulse task belongs to another owner');
        }
        const [previous] = await tx
          .select({ id: proactiveMoments.id })
          .from(proactiveMoments)
          .where(
            and(
              eq(proactiveMoments.agentId, input.agentId),
              eq(proactiveMoments.momentKey, input.moment.key),
            ),
          );
        if (previous) return { status: 'already-said' as const };
        const [prefs] = await tx
          .select({ cap: notificationPrefs.ambientDailyCap })
          .from(notificationPrefs)
          .where(eq(notificationPrefs.agentId, input.agentId));
        const cap = pulseDailyCap(input.pacing.dailyCap, prefs?.cap ?? null);
        const [delivered] = await tx
          .select({ value: count() })
          .from(proactiveMoments)
          .where(
            and(
              eq(proactiveMoments.agentId, input.agentId),
              gte(proactiveMoments.deliveredAt, input.pacing.windowSince),
            ),
          );
        if (Number(delivered?.value ?? 0) >= cap) return { status: 'daily-cap' as const };

        const [recent] = await tx
          .select({ id: proactiveMoments.id })
          .from(proactiveMoments)
          .where(
            and(
              eq(proactiveMoments.agentId, input.agentId),
              gte(proactiveMoments.deliveredAt, input.pacing.gapSince),
            ),
          )
          .limit(1);
        if (recent) return { status: 'min-gap' as const };

        const [primary] = await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.agentId, input.agentId),
              eq(conversations.isPrimary, true),
              eq(conversations.channel, 'chat'),
              isNull(conversations.archivedAt),
            ),
          )
          .for('update');
        let destination = primary;
        if (!destination) {
          // This is the shared lock used by every Notifications creator.
          const key = `watch-notifications:${input.agentId}`;
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
          const matches = await tx
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.agentId, input.agentId),
                eq(conversations.title, 'Notifications'),
              ),
            )
            .limit(2)
            .for('update');
          if (matches.length > 1) throw new Error('Ambiguous Notifications conversation');
          destination = matches[0];
          if (destination && (destination.channel !== 'chat' || destination.isPrimary))
            throw new Error('Notifications conversation identity mismatch');
          if (!destination) {
            [destination] = await tx
              .insert(conversations)
              .values({
                agentId: input.agentId,
                channel: 'chat',
                trust: 'assistant',
                title: 'Notifications',
                createdAt: input.now,
                updatedAt: input.now,
              })
              .returning();
          }
        }
        if (!destination) throw new Error('Failed to create pulse destination');
        const parts: unknown[] = [
          { type: 'text', text: input.notice.text },
          ...input.notice.extraParts,
        ];
        let suggestionCreated = false;
        if (input.suggestion) {
          const [created] = await tx
            .insert(suggestions)
            .values({
              ...input.suggestion,
              agentId: input.agentId,
              conversationId: destination.id,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .onConflictDoNothing({ target: [suggestions.agentId, suggestions.sourceRef] })
            .returning();
          if (created) {
            parts.push({
              type: 'suggestion',
              suggestionId: created.id,
              summary: created.summary,
              proposedAction: created.proposedAction,
            });
            suggestionCreated = true;
          }
        }
        const messageId = randomUUID();
        const momentId = randomUUID();
        await tx.insert(messages).values({
          id: messageId,
          conversationId: destination.id,
          taskId: input.taskId,
          role: 'assistant',
          origin: 'assistant',
          text: input.notice.text,
          parts,
          createdAt: input.now,
        });
        await tx
          .update(conversations)
          .set({ updatedAt: input.now, archivedAt: null })
          .where(
            and(eq(conversations.id, destination.id), eq(conversations.agentId, input.agentId)),
          );
        await tx.insert(proactiveMoments).values({
          id: momentId,
          agentId: input.agentId,
          kind: input.moment.kind,
          momentKey: input.moment.key,
          summary: input.moment.summary,
          deliveredAt: input.now,
        });
        return {
          status: 'persisted' as const,
          momentId,
          messageId,
          conversationId: destination.id,
          suggestionCreated,
        };
      });
    },
  };
}
