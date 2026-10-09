import {
  emailObserverMessageBody,
  emailObserverPreparedVoiceMatches,
  type VoiceContextRepository,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  assertPostgresPrivacyObservationFence,
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  conversations,
  emailIngest,
  emailObserverWork,
  messages,
  voiceProfile,
  writingSamples,
} from './schema.js';

/** The singleton voice profile and pgvector sample search, as outbound rewrites always read them. */
export function createPostgresVoiceContextRepository(db: Db): VoiceContextRepository {
  return {
    kind: 'voice-context-repository',
    async profile() {
      const [profile] = await db.select().from(voiceProfile).where(eq(voiceProfile.id, 1));
      if (!profile) return null;
      return {
        description: profile.description,
        dos: (profile.dos ?? []) as string[],
        donts: (profile.donts ?? []) as string[],
        signature: profile.signature,
      };
    },
    async hasSamples(register, embeddingSpaceKey) {
      const [count] = await db
        .select({ n: sql<number>`count(*)` })
        .from(writingSamples)
        .where(
          and(
            eq(writingSamples.register, register),
            eq(writingSamples.embeddingSpaceKey, embeddingSpaceKey),
          ),
        );
      return Number(count?.n ?? 0) > 0;
    },
    async nearestSamples(register, embedding, embeddingSpaceKey, limit) {
      const rows = await db
        .select({ text: writingSamples.text })
        .from(writingSamples)
        .where(
          and(
            eq(writingSamples.register, register),
            eq(writingSamples.embeddingSpaceKey, embeddingSpaceKey),
          ),
        )
        .orderBy(sql`${writingSamples.embedding} <=> ${JSON.stringify(embedding)}::vector`)
        .limit(limit);
      return rows.map((row) => row.text);
    },
    async hasSampleText(text, embeddingSpaceKey) {
      const [duplicate] = await db
        .select({ id: writingSamples.id })
        .from(writingSamples)
        .where(
          and(
            eq(writingSamples.text, text),
            eq(writingSamples.embeddingSpaceKey, embeddingSpaceKey),
          ),
        )
        .limit(1);
      return Boolean(duplicate);
    },
    async countSamplesWithContextPrefix(prefix) {
      const [count] = await db
        .select({ n: sql<number>`count(*)` })
        .from(writingSamples)
        .where(sql`${writingSamples.context} LIKE ${`${prefix}%`}`);
      return Number(count?.n ?? 0);
    },
    async observationGeneration() {
      const owners = await db.select({ id: agents.id }).from(agents).limit(2);
      if (owners.length !== 1 || !owners[0])
        throw new Error('Voice sample capture requires exactly one configured owner');
      return postgresPrivacyObservationFence(db, owners[0].id);
    },
    async addSample(input, observedGeneration, options) {
      await db.transaction(async (tx) => {
        const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
        if (owners.length !== 1 || !owners[0])
          throw new Error('Voice sample capture requires exactly one configured owner');
        const txDb = tx as unknown as Db;
        await lockPostgresPrivacyObservationFence(txDb, owners[0].id);
        await assertPostgresPrivacyObservationFence(txDb, owners[0].id, observedGeneration);
        const fence = options?.emailObserverEffectFence;
        if (fence) {
          if (owners[0].id !== fence.agentId) throw new Error('Email voice effect owner mismatch');
          const [work] = await tx
            .select()
            .from(emailObserverWork)
            .where(
              and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
            )
            .for('update')
            .limit(1);
          const [source] = work
            ? await tx
                .select({
                  parts: messages.parts,
                  hiddenAt: messages.hiddenAt,
                  messageId: messages.id,
                  sourceId: emailIngest.admittedSourceId,
                  authenticated: emailIngest.authenticated,
                  trust: emailIngest.contentTrust,
                  external: emailIngest.hasExternalOrUnknown,
                  mode: emailIngest.ingestMode,
                })
                .from(emailIngest)
                .innerJoin(messages, eq(messages.channelMessageId, emailIngest.channelMessageId))
                .innerJoin(conversations, eq(conversations.id, messages.conversationId))
                .where(
                  and(
                    eq(emailIngest.agentId, fence.agentId),
                    eq(emailIngest.channelMessageId, work.channelMessageId),
                    eq(conversations.agentId, fence.agentId),
                  ),
                )
                .limit(1)
            : [];
          const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
          if (
            !work ||
            !clock ||
            !emailObserverPreparedVoiceMatches(
              work,
              fence,
              input,
              observedGeneration,
              new Date(clock.now),
            ) ||
            !source ||
            source.hiddenAt ||
            source.messageId !== source.sourceId ||
            emailObserverMessageBody(source.parts)?.trim() !== input.text ||
            source.mode !== 'direct' ||
            !source.authenticated ||
            source.trust !== 'owner' ||
            source.external
          )
            throw new Error('Email voice effect claim or source is no longer current');
          const [duplicate] = await tx
            .select({ id: writingSamples.id })
            .from(writingSamples)
            .where(
              and(
                eq(writingSamples.text, input.text),
                eq(writingSamples.embeddingSpaceKey, input.embeddingSpaceKey),
              ),
            )
            .limit(1);
          // The owner privacy lock serializes concurrent samples and erasure.
          if (duplicate) return;
          const [finalClock] = await tx.execute<{ now: string }>(
            sql`select clock_timestamp() as now`,
          );
          if (
            !finalClock ||
            !emailObserverPreparedVoiceMatches(
              work,
              fence,
              input,
              observedGeneration,
              new Date(finalClock.now),
            )
          )
            throw new Error('Email voice effect expired before sample write');
        }
        await tx.insert(writingSamples).values(input);
      });
    },
  };
}
