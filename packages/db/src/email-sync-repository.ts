import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  EmailAdmissionCommitInput,
  EmailAdmissionCommitResult,
  EmailObligationDecision,
  EmailObserverClaim,
  EmailObserverClaimResult,
  EmailObserverIdentity,
  EmailObserverSource,
  EmailObserverWorkRecord,
  EmailSyncLease,
  EmailSyncRepository,
  PreparedEmailScore,
  RecoverableDirectIngest,
} from '@assistant/persistence';
import {
  emailBookingKey,
  emailBookingObservationIsNewer,
  emailBookingOccurrenceId,
  emailObserverBudgetId,
  emailObserverDeliveryKey,
  emailObserverSourceId,
  emailObserverWorkId,
  isValidEmailContentProvenanceSnapshot,
  isValidEmailObserverPreparedResult,
  notificationDashboardMessageId,
  safeEmailObserverErrorCode,
  sameEmailObserverPreparedResult,
} from '@assistant/persistence';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, not, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  channelBindings,
  contacts,
  conversations,
  emailBookingOccurrences,
  emailIngest,
  emailObserverBudgets,
  emailObserverSources,
  emailObserverWork,
  gmailSyncState,
  messages,
  notificationOutbox,
  suggestions,
  tasks,
} from './schema.js';
import { createPostgresSecurityIncidentRepository } from './security-incident-repository.js';

function observerRegistrySnapshot(
  observers: EmailAdmissionCommitInput['observers'],
): Array<{ key: string; version: number; workClass: string }> {
  const sorted = [...observers]
    .map(({ key, version, workClass }) => ({ key, version, workClass }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version);
  if (
    sorted.length > 40 ||
    sorted.some(
      (item, index) =>
        !item.key.trim() ||
        !Number.isInteger(item.version) ||
        item.version < 1 ||
        (index > 0 &&
          item.key === sorted[index - 1]?.key &&
          item.version === sorted[index - 1]?.version),
    )
  )
    throw new Error('Email observer registry contains an invalid or duplicate identity');
  return sorted;
}

function observerRegistryHash(
  snapshot: readonly { key: string; version: number; workClass: string }[],
) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function emailObserverRecord(row: typeof emailObserverWork.$inferSelect): EmailObserverWorkRecord {
  return {
    ...row,
    status: row.status as EmailObserverWorkRecord['status'],
    workClass: row.workClass as EmailObserverWorkRecord['workClass'],
    sourceKind: row.sourceKind as EmailObserverWorkRecord['sourceKind'],
  };
}

/** Gmail sync's PostgreSQL state, with the queries the sync loop has always run. */
export function createPostgresEmailSyncRepository(
  db: Db,
  ownerAgentId?: string,
): EmailSyncRepository {
  const securityIncidents = createPostgresSecurityIncidentRepository(db, ownerAgentId);
  const leaseDurationMs = 10 * 60_000;
  const requireFencedUpdate = async (rows: Array<{ mailbox: string }> | undefined) => {
    if (!rows?.length) throw new Error('Gmail sync lease is no longer current');
  };
  return {
    kind: 'email-sync-repository',
    privacyObservationFence: (agentId) => postgresPrivacyObservationFence(db, agentId),
    observeSecurityIncident: securityIncidents.observe,
    securityIncidentForMessage: securityIncidents.getForMessage,
    listSecurityAttentionCandidates: securityIncidents.listAttentionCandidates,
    claimSecurityAttention: securityIncidents.claimAttention,
    completeSecurityAttention: securityIncidents.completeAttention,
    decideSecurityIncident: securityIncidents.decide,
    async mailbox() {
      const [agent] = await db
        .select({ id: agents.id, name: agents.name, email: agents.email })
        .from(agents)
        .where(ownerAgentId ? eq(agents.id, ownerAgentId) : undefined)
        .limit(1);
      if (!agent) throw new Error('no agent row');
      return { agentId: agent.id, name: agent.name, email: agent.email };
    },
    async contactTrust() {
      const rows = await db
        .select({ emails: contacts.emails, trust: contacts.trust })
        .from(contacts);
      return rows.flatMap((contact) =>
        contact.trust === 'owner' || contact.trust === 'known'
          ? contact.emails.map((email) => ({
              email: email.toLowerCase(),
              trust: contact.trust as 'owner' | 'known',
            }))
          : [],
      );
    },
    async syncState(mailbox) {
      const [state] = await db
        .select()
        .from(gmailSyncState)
        .where(eq(gmailSyncState.mailbox, mailbox));
      return state ? { lastHistoryId: state.lastHistoryId, cursor: state.cursor } : null;
    },
    async raiseBaseline(mailbox, historyId, lease) {
      await lease.assertCurrent();
      const now = new Date();
      const rows = await db
        .insert(gmailSyncState)
        .values({
          mailbox,
          lastHistoryId: historyId,
          leaseHolder: lease.holder,
          leaseGeneration: lease.generation,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        })
        .onConflictDoUpdate({
          target: gmailSyncState.mailbox,
          set: {
            lastHistoryId: sql`GREATEST(${gmailSyncState.lastHistoryId}, ${historyId})`,
            updatedAt: now,
          },
          where: and(
            eq(gmailSyncState.leaseHolder, lease.holder),
            eq(gmailSyncState.leaseGeneration, lease.generation),
            gt(gmailSyncState.leaseExpiresAt, now),
          ),
        })
        .returning({ mailbox: gmailSyncState.mailbox });
      await requireFencedUpdate(rows);
    },
    async saveCursor(mailbox, cursor, lease) {
      await lease.assertCurrent();
      const now = new Date();
      const rows = await db
        .update(gmailSyncState)
        .set({ cursor, updatedAt: now })
        .where(
          and(
            eq(gmailSyncState.mailbox, mailbox),
            eq(gmailSyncState.leaseHolder, lease.holder),
            eq(gmailSyncState.leaseGeneration, lease.generation),
            gt(gmailSyncState.leaseExpiresAt, now),
          ),
        )
        .returning({ mailbox: gmailSyncState.mailbox });
      await requireFencedUpdate(rows);
    },
    async completeDrain(mailbox, targetHistoryId, lease) {
      await lease.assertCurrent();
      const now = new Date();
      const rows = await db
        .update(gmailSyncState)
        .set({
          lastHistoryId: sql`GREATEST(${gmailSyncState.lastHistoryId}, ${targetHistoryId})`,
          cursor: {},
          updatedAt: now,
        })
        .where(
          and(
            eq(gmailSyncState.mailbox, mailbox),
            eq(gmailSyncState.leaseHolder, lease.holder),
            eq(gmailSyncState.leaseGeneration, lease.generation),
            gt(gmailSyncState.leaseExpiresAt, now),
          ),
        )
        .returning({ mailbox: gmailSyncState.mailbox });
      await requireFencedUpdate(rows);
    },
    async setWatchExpiration(mailbox, expiration) {
      await db
        .insert(gmailSyncState)
        .values({ mailbox, watchExpiration: expiration })
        .onConflictDoUpdate({
          target: gmailSyncState.mailbox,
          set: { watchExpiration: expiration, updatedAt: new Date() },
        });
    },
    async withLock(run) {
      // A session advisory lock on one reserved connection: two scaled
      // instances never both pay to classify the same unpersisted message.
      const connection = await db.$client.reserve();
      let acquired = false;
      let lease: EmailSyncLease | undefined;
      let leaseActive = true;
      try {
        const [row] = await connection<[{ acquired: boolean; pid: string }]>`
          select pg_try_advisory_lock(hashtext('assistant:gmail-sync')) as acquired,
            pg_backend_pid()::text as pid
        `;
        acquired = row?.acquired === true;
        if (!acquired) return null;
        const lockBackendPid = row?.pid;
        const holder = randomUUID();
        const now = new Date();
        const [owner] = await db
          .select({ email: agents.email })
          .from(agents)
          .where(ownerAgentId ? eq(agents.id, ownerAgentId) : undefined)
          .limit(1);
        if (!owner?.email) throw new Error('Gmail sync owner has no email');
        const [state] = await db
          .insert(gmailSyncState)
          .values({
            mailbox: owner.email,
            leaseHolder: holder,
            leaseGeneration: 1,
            leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
          })
          .onConflictDoUpdate({
            target: gmailSyncState.mailbox,
            set: {
              leaseHolder: holder,
              leaseGeneration: sql`${gmailSyncState.leaseGeneration} + 1`,
              leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
              updatedAt: now,
            },
          })
          .returning({
            mailbox: gmailSyncState.mailbox,
            generation: gmailSyncState.leaseGeneration,
          });
        if (!state) throw new Error('Gmail sync lease could not be acquired');
        const assertSessionLock = async () => {
          if (!acquired || !leaseActive) throw new Error('Gmail sync lease is no longer current');
          // This reserved connection is the owner of the PostgreSQL session
          // lock. A dropped session releases it, and this probe must fail rather
          // than silently reconnecting through the shared pool.
          const [session] = await connection<[{ pid: string }]>`
            select pg_backend_pid()::text as pid
          `;
          if (!lockBackendPid || session?.pid !== lockBackendPid) {
            throw new Error('Gmail sync lease is no longer current');
          }
        };
        const assertCurrent = async () => {
          await assertSessionLock();
          const checkedAt = new Date();
          const [current] = await db
            .select({ holder: gmailSyncState.leaseHolder })
            .from(gmailSyncState)
            .where(
              and(
                eq(gmailSyncState.mailbox, state.mailbox),
                eq(gmailSyncState.leaseHolder, holder),
                eq(gmailSyncState.leaseGeneration, state.generation),
                gt(gmailSyncState.leaseExpiresAt, checkedAt),
              ),
            )
            .limit(1);
          if (!current) throw new Error('Gmail sync lease is no longer current');
        };
        lease = {
          holder,
          generation: state.generation,
          assertCurrent,
          renew: async () => {
            await assertSessionLock();
            const renewedAt = new Date();
            const [current] = await db
              .update(gmailSyncState)
              .set({ leaseExpiresAt: new Date(renewedAt.getTime() + leaseDurationMs) })
              .where(
                and(
                  eq(gmailSyncState.mailbox, state.mailbox),
                  eq(gmailSyncState.leaseHolder, holder),
                  eq(gmailSyncState.leaseGeneration, state.generation),
                  gt(gmailSyncState.leaseExpiresAt, renewedAt),
                ),
              )
              .returning({ mailbox: gmailSyncState.mailbox });
            await requireFencedUpdate(current ? [current] : undefined);
            await assertSessionLock();
          },
        };
        return { value: await run(lease) };
      } finally {
        if (lease) {
          leaseActive = false;
          await db
            .update(gmailSyncState)
            .set({ leaseExpiresAt: new Date() })
            .where(
              and(
                eq(gmailSyncState.leaseHolder, lease.holder),
                eq(gmailSyncState.leaseGeneration, lease.generation),
              ),
            )
            .catch((error) => console.error('email-sync: failed to expire mailbox lease', error));
        }
        if (acquired) {
          await connection`select pg_advisory_unlock(hashtext('assistant:gmail-sync'))`.catch(
            (error: unknown) => console.error('email-sync: failed to release advisory lock', error),
          );
        }
        connection.release();
      }
    },
    async inboundMessage(channelMessageId) {
      const [existing] = await db
        .select({ conversationId: messages.conversationId, origin: messages.origin })
        .from(messages)
        .where(eq(messages.channelMessageId, channelMessageId))
        .limit(1);
      return existing ?? null;
    },
    async hasTaskForEvent(externalEventId) {
      const [existing] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.externalEventId, externalEventId))
        .limit(1);
      return Boolean(existing);
    },
    async conversationForThread(agentId, threadId, trust, subject, options) {
      if (ownerAgentId && agentId !== ownerAgentId)
        throw new Error('Email thread is outside the configured owner');
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const generation = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (options && generation !== options.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during email conversation admission');
        const [binding] = await txDb
          .select()
          .from(channelBindings)
          .where(
            and(eq(channelBindings.channel, 'email'), eq(channelBindings.externalId, threadId)),
          )
          .for('update')
          .limit(1);
        if (binding) return binding.conversationId;
        const [conversation] = await txDb
          .insert(conversations)
          .values({
            agentId,
            channel: 'email',
            trust,
            title: subject.slice(0, 80) || '(no subject)',
          })
          .returning();
        if (!conversation) throw new Error('failed to create email conversation');
        await txDb
          .insert(channelBindings)
          .values({ conversationId: conversation.id, channel: 'email', externalId: threadId })
          .onConflictDoNothing();
        return conversation.id;
      });
    },
    async ingestRecord(channelMessageId) {
      const [recorded] = await db
        .select({
          id: emailIngest.id,
          agentId: emailIngest.agentId,
          providerMessageId: emailIngest.providerMessageId,
          conversationId: emailIngest.conversationId,
          importance: emailIngest.importance,
          category: emailIngest.category,
          contentTrust: emailIngest.contentTrust,
          triaged: emailIngest.triaged,
          actionable: emailIngest.actionable,
          reason: emailIngest.reason,
          dates: emailIngest.dates,
          cardCandidate: emailIngest.cardCandidate,
          nextStep: emailIngest.nextStep,
          pipelineStage: emailIngest.pipelineStage,
          scoreStatus: emailIngest.scoreStatus,
          scoreClaimToken: emailIngest.scoreClaimToken,
          messagePersisted: emailIngest.messagePersisted,
          triageTaskId: emailIngest.triageTaskId,
          providerThreadId: emailIngest.providerThreadId,
          providerReceivedAt: emailIngest.providerReceivedAt,
          sourceMessageId: emailIngest.sourceMessageId,
          obligationStatus: emailIngest.obligationStatus,
          obligationVersion: emailIngest.obligationVersion,
          obligationDecision: emailIngest.obligationDecision,
          obligationDecisionAt: emailIngest.obligationDecisionAt,
          obligationSnoozedUntil: emailIngest.obligationSnoozedUntil,
          securityEvidence: emailIngest.securityEvidence,
          securityIncidentId: emailIngest.securityIncidentId,
          classificationStatus: emailIngest.classificationStatus,
          classificationClaimToken: emailIngest.classificationClaimToken,
          preparedClassification: emailIngest.preparedClassification,
          scoreOutcome: emailIngest.scoreOutcome,
          ingestMode: emailIngest.ingestMode,
          hasExternalOrUnknown: emailIngest.hasExternalOrUnknown,
          observerRegistrySnapshot: emailIngest.observerRegistrySnapshot,
          observerRegistryHash: emailIngest.observerRegistryHash,
          admittedSourceKind: emailIngest.admittedSourceKind,
          admittedSourceId: emailIngest.admittedSourceId,
          directRouting: emailIngest.directRouting,
          directRecoveryReason: emailIngest.directRecoveryReason,
          emailContentProvenance: emailIngest.emailContentProvenance,
        })
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId))
        .limit(1);
      return recorded
        ? {
            ...recorded,
            ingestMode: recorded.ingestMode as 'direct' | 'forwarded',
            admittedSourceKind: recorded.admittedSourceKind as
              | 'message'
              | 'automated_source'
              | null,
          }
        : null;
    },
    async listRecoverableDirectIngests(input) {
      if (ownerAgentId && input.agentId !== ownerAgentId)
        throw new Error('Email ingest owner mismatch');
      const mailbox = input.mailbox.trim().toLowerCase();
      if (!mailbox || !Number.isFinite(input.limit))
        throw new Error('Invalid recovery scan bounds');
      await input.lease.assertCurrent();
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during direct recovery scan');
        const [owner] = await txDb
          .select({ email: agents.email })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .limit(1);
        if (!owner || owner.email.trim().toLowerCase() !== mailbox)
          throw new Error('Direct recovery mailbox is outside owner');
        const [leaseRow] = await txDb
          .select({ mailbox: gmailSyncState.mailbox })
          .from(gmailSyncState)
          .where(
            and(
              eq(gmailSyncState.mailbox, mailbox),
              eq(gmailSyncState.leaseHolder, input.lease.holder),
              eq(gmailSyncState.leaseGeneration, input.lease.generation),
              gt(gmailSyncState.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .for('update')
          .limit(1);
        if (!leaseRow) throw new Error('Gmail sync lease is no longer current');
        const cap = Math.max(1, Math.min(20, Math.floor(input.limit)));
        const rows = await txDb
          .select()
          .from(emailIngest)
          .where(
            and(
              eq(emailIngest.agentId, input.agentId),
              eq(emailIngest.mailbox, mailbox),
              eq(emailIngest.ingestMode, 'direct'),
              eq(emailIngest.authenticated, true),
              eq(emailIngest.messagePersisted, false),
              isNull(emailIngest.admittedSourceKind),
              isNull(emailIngest.admittedSourceId),
              inArray(emailIngest.pipelineStage, [
                'pending_classification',
                'classifying',
                'pending_score',
                'scoring',
                'score_prepared',
              ]),
              sql`(${emailIngest.classificationStatus} in ('pending','in_progress','prepared') OR (${emailIngest.classificationStatus} = 'unknown' AND ${emailIngest.preparedClassification} IS NOT NULL))`,
              sql`(${emailIngest.scoreStatus} in ('pending','in_progress','prepared') OR (${emailIngest.scoreStatus} = 'unknown' AND ${emailIngest.scoreOutcome} = 'fallback_committed_unknown'))`,
            ),
          )
          .orderBy(asc(emailIngest.updatedAt), asc(emailIngest.id))
          .limit(cap);
        return rows.map(
          (row): RecoverableDirectIngest => ({
            id: row.id,
            agentId: row.agentId,
            mailbox: row.mailbox,
            channelMessageId: row.channelMessageId,
            providerMessageId: row.providerMessageId,
            providerThreadId: row.providerThreadId ?? null,
            sourceMessageId: row.sourceMessageId ?? null,
            conversationId: row.conversationId ?? null,
            authenticated: true,
            fromEmail: row.fromEmail,
            fromName: row.fromName ?? null,
            subject: row.subject,
            contentTrust: row.contentTrust as RecoverableDirectIngest['contentTrust'],
            hasExternalOrUnknown: row.hasExternalOrUnknown,
            emailContentProvenance: isValidEmailContentProvenanceSnapshot(
              row.emailContentProvenance,
            )
              ? row.emailContentProvenance
              : null,
            directRouting: row.directRouting as RecoverableDirectIngest['directRouting'],
            directRecoveryReason:
              row.directRecoveryReason as RecoverableDirectIngest['directRecoveryReason'],
            classificationStatus:
              row.classificationStatus as RecoverableDirectIngest['classificationStatus'],
            classificationClaimToken: row.classificationClaimToken ?? null,
            preparedClassification: row.preparedClassification ?? null,
            scoreStatus: row.scoreStatus as RecoverableDirectIngest['scoreStatus'],
            scoreClaimToken: row.scoreClaimToken ?? null,
            scoreOutcome: row.scoreOutcome,
            score: {
              category: row.category,
              importance: row.importance,
              actionable: row.actionable,
              reason: row.reason,
              dates: row.dates,
              cardCandidate: row.cardCandidate,
              nextStep: row.nextStep,
            },
            pipelineStage: row.pipelineStage,
            admittedSourceKind: null,
            admittedSourceId: null,
            messagePersisted: false,
            updatedAt: row.updatedAt,
          }),
        );
      });
    },
    async markDirectIngestRecoveryUnavailable(input) {
      if (ownerAgentId && input.agentId !== ownerAgentId)
        throw new Error('Email ingest owner mismatch');
      if (
        ![
          'provider_message_missing',
          'provider_access_denied',
          'provider_temporarily_unavailable',
          'checkpoint_inconsistent',
        ].includes(input.reason)
      )
        throw new Error('Invalid direct recovery reason');
      await input.lease.assertCurrent();
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during direct recovery update');
        const mailbox = input.mailbox.trim().toLowerCase();
        const [owner] = await txDb
          .select({ email: agents.email })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .limit(1);
        if (!owner || owner.email.trim().toLowerCase() !== mailbox)
          throw new Error('Direct recovery mailbox is outside owner');
        const [leaseRow] = await txDb
          .select({ mailbox: gmailSyncState.mailbox })
          .from(gmailSyncState)
          .where(
            and(
              eq(gmailSyncState.mailbox, input.mailbox.trim().toLowerCase()),
              eq(gmailSyncState.leaseHolder, input.lease.holder),
              eq(gmailSyncState.leaseGeneration, input.lease.generation),
              gt(gmailSyncState.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .for('update')
          .limit(1);
        if (!leaseRow) throw new Error('Gmail sync lease is no longer current');
        const [row] = await txDb
          .select()
          .from(emailIngest)
          .where(
            and(
              eq(emailIngest.id, input.ingestId),
              eq(emailIngest.agentId, input.agentId),
              eq(emailIngest.mailbox, input.mailbox.trim().toLowerCase()),
              eq(emailIngest.ingestMode, 'direct'),
              eq(emailIngest.authenticated, true),
              eq(emailIngest.messagePersisted, false),
              isNull(emailIngest.admittedSourceKind),
              isNull(emailIngest.admittedSourceId),
            ),
          )
          .for('update')
          .limit(1);
        if (!row || row.pipelineStage === 'needs_attention') return false;
        await txDb
          .update(emailIngest)
          .set({
            pipelineStage: 'needs_attention',
            directRouting: 'needs_attention',
            directRecoveryReason: input.reason,
            classificationStatus:
              row.classificationStatus === 'in_progress' ? 'unknown' : row.classificationStatus,
            classificationClaimToken: null,
            scoreStatus: row.scoreStatus === 'in_progress' ? 'unknown' : row.scoreStatus,
            scoreOutcome:
              row.scoreStatus === 'in_progress' ? 'provider_outcome_unknown' : row.scoreOutcome,
            scoreClaimToken: null,
            updatedAt: new Date(),
          })
          .where(eq(emailIngest.id, row.id));
        return true;
      });
    },
    async listEmailObligations(_now) {
      const owner = await this.mailbox();
      return db
        .select({
          id: emailIngest.id,
          channelMessageId: emailIngest.channelMessageId,
          providerThreadId: emailIngest.providerThreadId,
          providerReceivedAt: emailIngest.providerReceivedAt,
          subject: emailIngest.subject,
          fromEmail: emailIngest.fromEmail,
          fromName: emailIngest.fromName,
          obligationStatus: emailIngest.obligationStatus,
          obligationVersion: emailIngest.obligationVersion,
          obligationDecision: emailIngest.obligationDecision,
          obligationDecisionAt: emailIngest.obligationDecisionAt,
          obligationSnoozedUntil: emailIngest.obligationSnoozedUntil,
        })
        .from(emailIngest)
        .where(sql`
          ${emailIngest.agentId} = ${owner.agentId}
          AND
          ${emailIngest.actionable} = true
          AND ${emailIngest.pipelineStage} = 'complete'
          AND ${emailIngest.providerThreadId} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${emailIngest} newer
            WHERE newer.agent_id = ${emailIngest.agentId}
              AND newer.provider_thread_id = ${emailIngest.providerThreadId}
              AND (COALESCE(newer.provider_received_at, newer.created_at), COALESCE(newer.provider_message_id, newer.channel_message_id))
                > (COALESCE(${emailIngest.providerReceivedAt}, ${emailIngest.createdAt}), COALESCE(${emailIngest.providerMessageId}, ${emailIngest.channelMessageId}))
          )
        `)
        .orderBy(desc(emailIngest.providerReceivedAt), desc(emailIngest.createdAt))
        .limit(100);
    },
    async decideEmailObligation(input: {
      channelMessageId: string;
      expectedVersion: number;
      decision: EmailObligationDecision;
      now: Date;
      snoozedUntil?: Date;
    }) {
      if (input.decision === 'snooze' && (!input.snoozedUntil || input.snoozedUntil <= input.now)) {
        throw new Error('A snooze must end in the future');
      }
      const owner = await this.mailbox();
      const status =
        input.decision === 'resolve'
          ? 'resolved'
          : input.decision === 'snooze'
            ? 'snoozed'
            : 'open';
      const allowedTransition =
        input.decision === 'reopen'
          ? sql`${emailIngest.obligationStatus} = 'resolved'`
          : sql`${emailIngest.obligationStatus} <> 'resolved'`;
      const [updated] = await db
        .update(emailIngest)
        .set({
          obligationStatus: status,
          obligationDecision: input.decision,
          obligationDecisionAt: input.now,
          obligationSnoozedUntil: input.decision === 'snooze' ? (input.snoozedUntil ?? null) : null,
          obligationVersion: sql`${emailIngest.obligationVersion} + 1`,
          updatedAt: input.now,
        })
        .where(sql`
          ${emailIngest.channelMessageId} = ${input.channelMessageId}
          AND ${emailIngest.agentId} = ${owner.agentId}
          AND ${emailIngest.obligationVersion} = ${input.expectedVersion}
          AND ${emailIngest.actionable} = true
          AND ${emailIngest.pipelineStage} = 'complete'
          AND ${allowedTransition}
          AND ${emailIngest.providerThreadId} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${emailIngest} newer
            WHERE newer.agent_id = ${emailIngest.agentId}
              AND newer.provider_thread_id = ${emailIngest.providerThreadId}
              AND (COALESCE(newer.provider_received_at, newer.created_at), COALESCE(newer.provider_message_id, newer.channel_message_id))
                > (COALESCE(${emailIngest.providerReceivedAt}, ${emailIngest.createdAt}), COALESCE(${emailIngest.providerMessageId}, ${emailIngest.channelMessageId}))
          )
        `)
        .returning({ id: emailIngest.id });
      return Boolean(updated);
    },
    async beginForwardedIngest(row, options = { expectedPrivacyGeneration: null }) {
      if (ownerAgentId && row.agentId !== ownerAgentId)
        throw new Error('Email ingest is outside the configured owner');
      if (row.ingestMode === 'direct')
        throw new Error('Forwarded email ingest cannot use direct mode');
      if (
        row.emailContentProvenance != null ||
        row.directRouting != null ||
        row.directRecoveryReason != null
      )
        throw new Error('Forwarded email cannot carry direct recovery metadata');
      await options.lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, row.agentId);
        if (fence !== options.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during forwarded email admission');
        if (options.lease) {
          const now = new Date();
          const [leaseRow] = await txDb
            .select({ mailbox: gmailSyncState.mailbox })
            .from(gmailSyncState)
            .where(
              and(
                eq(gmailSyncState.mailbox, row.mailbox),
                eq(gmailSyncState.leaseHolder, options.lease.holder),
                eq(gmailSyncState.leaseGeneration, options.lease.generation),
                gt(gmailSyncState.leaseExpiresAt, now),
              ),
            )
            .for('update')
            .limit(1);
          if (!leaseRow) throw new Error('Gmail sync lease is no longer current');
        }
        const [existing] = await txDb
          .select({ id: emailIngest.id, agentId: emailIngest.agentId })
          .from(emailIngest)
          .where(eq(emailIngest.channelMessageId, row.channelMessageId))
          .for('update')
          .limit(1);
        if (existing) {
          if (existing.agentId !== row.agentId)
            throw new Error('Email source belongs to another owner');
          return;
        }
        const [created] = await txDb
          .insert(emailIngest)
          .values({
            ...row,
            sourceMessageId: row.sourceMessageId ?? null,
            ingestMode: 'forwarded',
            hasExternalOrUnknown: row.hasExternalOrUnknown ?? true,
            observerRegistrySnapshot: null,
            observerRegistryHash: null,
            admittedSourceKind: null,
            admittedSourceId: null,
            classificationStatus: 'not_required',
            classificationClaimToken: null,
            preparedClassification: null,
            scoreOutcome: 'provider_outcome_unknown',
            securityEvidence: row.securityEvidence ?? null,
            securityIncidentId: row.securityIncidentId ?? null,
            obligationStatus: 'unknown',
            obligationVersion: 0,
            obligationDecision: null,
            obligationDecisionAt: null,
            obligationSnoozedUntil: null,
            pipelineStage: 'pending_score',
            scoreStatus: 'pending',
            scoreClaimToken: null,
            cardCandidate: false,
            nextStep: null,
            messagePersisted: false,
            triageTaskId: null,
            triaged: false,
          })
          .onConflictDoNothing({ target: emailIngest.channelMessageId })
          .returning({ id: emailIngest.id });
        if (!created) {
          const [winner] = await txDb
            .select({ agentId: emailIngest.agentId })
            .from(emailIngest)
            .where(eq(emailIngest.channelMessageId, row.channelMessageId))
            .limit(1);
          if (!winner || winner.agentId !== row.agentId)
            throw new Error('Email source belongs to another owner');
        }
      });
      const record = await this.ingestRecord(row.channelMessageId);
      if (!record) throw new Error('email ingest stage could not be created or loaded');
      return record;
    },
    async claimIngestScore(
      agentId,
      ingestId,
      token,
      expectedPrivacyGeneration,
      lease,
      claimOutcome = 'model_prepared',
    ) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (fence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed before email scoring');
        const [claimed] = await txDb
          .update(emailIngest)
          .set({
            pipelineStage: 'scoring',
            scoreStatus: 'in_progress',
            scoreClaimToken: token,
            scoreOutcome: claimOutcome,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.pipelineStage, 'pending_score'),
              eq(emailIngest.scoreStatus, 'pending'),
            ),
          )
          .returning({ id: emailIngest.id });
        return Boolean(claimed);
      });
    },
    async markIngestScoreBudgetBlocked(agentId, ingestId, token, expectedPrivacyGeneration, lease) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const currentFence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (currentFence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed before score budget release');
        await txDb
          .update(emailIngest)
          .set({
            pipelineStage: 'pending_score',
            scoreStatus: 'pending',
            scoreClaimToken: null,
            scoreOutcome: 'budget_blocked',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.pipelineStage, 'scoring'),
              eq(emailIngest.scoreStatus, 'in_progress'),
              eq(emailIngest.scoreClaimToken, token),
              eq(emailIngest.scoreOutcome, 'model_prepared'),
            ),
          );
      });
    },
    async markIngestScoreUnknown(agentId, ingestId, token, expectedPrivacyGeneration, lease) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (fence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed before score outcome recording');
        await txDb
          .update(emailIngest)
          .set({
            pipelineStage: 'needs_attention',
            scoreStatus: 'unknown',
            scoreOutcome: 'provider_outcome_unknown',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.pipelineStage, 'scoring'),
              eq(emailIngest.scoreStatus, 'in_progress'),
              eq(emailIngest.scoreClaimToken, token),
            ),
          );
      });
    },
    async prepareIngestScore(
      agentId,
      ingestId,
      token,
      score: PreparedEmailScore,
      expectedPrivacyGeneration,
      lease,
      expectedClaimOutcome = 'model_prepared',
    ) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [identity] = await txDb
          .select({ agentId: emailIngest.agentId })
          .from(emailIngest)
          .where(and(eq(emailIngest.id, ingestId), eq(emailIngest.agentId, agentId)))
          .limit(1);
        if (!identity) throw new Error('email scoring claim is no longer current');
        const currentFence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (currentFence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during email scoring');
        const [source] = await txDb
          .select({
            id: emailIngest.id,
            agentId: emailIngest.agentId,
            channelMessageId: emailIngest.channelMessageId,
            authenticated: emailIngest.authenticated,
            providerReceivedAt: emailIngest.providerReceivedAt,
            pipelineStage: emailIngest.pipelineStage,
            scoreClaimToken: emailIngest.scoreClaimToken,
            scoreOutcome: emailIngest.scoreOutcome,
          })
          .from(emailIngest)
          .where(and(eq(emailIngest.id, ingestId), eq(emailIngest.agentId, agentId)))
          .for('update')
          .limit(1);
        if (
          !source ||
          source.pipelineStage !== 'scoring' ||
          source.scoreClaimToken !== token ||
          source.scoreOutcome !== expectedClaimOutcome
        )
          throw new Error('email scoring claim is no longer current');

        const [prepared] = await txDb
          .update(emailIngest)
          .set({
            ...score,
            securityEvidence: score.securityEvidence ?? null,
            pipelineStage: 'score_prepared',
            scoreStatus: 'prepared',
            scoreOutcome: expectedClaimOutcome,
            scoreClaimToken: token,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.pipelineStage, 'scoring'),
              eq(emailIngest.scoreClaimToken, token),
            ),
          )
          .returning({ id: emailIngest.id });
        if (!prepared) throw new Error('email scoring claim is no longer current');

        if (!source.authenticated || !source.providerReceivedAt) return;
        const lifecycleDates = (Array.isArray(score.dates) ? score.dates : []).flatMap(
          (candidate: unknown) => {
            if (
              !candidate ||
              typeof candidate !== 'object' ||
              !('lifecycle' in candidate) ||
              !['confirmed', 'cancelled', 'rescheduled', 'tentative'].includes(
                String(candidate.lifecycle),
              ) ||
              !('bookingIdentity' in candidate) ||
              typeof candidate.bookingIdentity !== 'string'
            )
              return [];
            return [{ ...candidate, bookingIdentity: candidate.bookingIdentity }];
          },
        );
        const byBooking = new Map<string, typeof lifecycleDates>();
        for (const candidate of lifecycleDates) {
          const key = emailBookingKey(source.agentId, candidate.bookingIdentity);
          byBooking.set(key, [...(byBooking.get(key) ?? []), candidate]);
        }
        for (const [bookingKey, dates] of byBooking) {
          const id = emailBookingOccurrenceId(source.agentId, bookingKey);
          const ref = txDb
            .insert(emailBookingOccurrences)
            .values({
              id,
              agentId: source.agentId,
              bookingKey,
              lifecycle: String(dates[0]?.lifecycle ?? 'unknown'),
              dates,
              sourceChannelMessageId: source.channelMessageId,
              sourceReceivedAt: source.providerReceivedAt,
              sourceAuthenticated: true,
              version: 1,
            })
            .onConflictDoNothing({ target: emailBookingOccurrences.id });
          await ref;
          const [current] = await txDb
            .select()
            .from(emailBookingOccurrences)
            .where(
              and(
                eq(emailBookingOccurrences.agentId, source.agentId),
                eq(emailBookingOccurrences.bookingKey, bookingKey),
              ),
            )
            .for('update')
            .limit(1);
          if (
            !current ||
            !emailBookingObservationIsNewer(
              source.providerReceivedAt,
              source.channelMessageId,
              current,
            )
          )
            continue;
          await txDb
            .update(emailBookingOccurrences)
            .set({
              lifecycle: String(dates[0]?.lifecycle ?? 'unknown'),
              dates,
              sourceChannelMessageId: source.channelMessageId,
              sourceReceivedAt: source.providerReceivedAt,
              sourceAuthenticated: true,
              version: current.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(emailBookingOccurrences.id, current.id));
          if (['cancelled', 'rescheduled'].includes(String(dates[0]?.lifecycle))) {
            await txDb
              .update(suggestions)
              .set({ status: 'superseded', updatedAt: new Date() })
              .where(
                and(
                  eq(suggestions.agentId, source.agentId),
                  eq(suggestions.bookingKey, bookingKey),
                  or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
                ),
              );
          }
        }
      });
    },
    async prepareIngestScoreDeterministic(
      agentId,
      ingestId,
      token,
      score,
      expectedPrivacyGeneration,
      lease,
    ) {
      await this.prepareIngestScore(
        agentId,
        ingestId,
        token,
        score,
        expectedPrivacyGeneration,
        lease,
        'deterministic_no_model',
      );
    },
    async prepareIngestScoreFallbackUnknown(
      agentId,
      ingestId,
      token,
      score: PreparedEmailScore,
      expectedPrivacyGeneration,
      lease,
    ) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (fence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during fallback score admission');
        const [updated] = await txDb
          .update(emailIngest)
          .set({
            ...score,
            securityEvidence: score.securityEvidence ?? null,
            pipelineStage: 'score_prepared',
            scoreStatus: 'unknown',
            scoreOutcome: 'fallback_committed_unknown',
            scoreClaimToken: token,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.pipelineStage, 'scoring'),
              eq(emailIngest.scoreStatus, 'in_progress'),
              eq(emailIngest.scoreClaimToken, token),
            ),
          )
          .returning({ id: emailIngest.id });
        if (!updated) throw new Error('Email scoring claim is no longer current');
      });
    },
    async markIngestMessagePersisted(ingestId, conversationId, lease) {
      await lease?.assertCurrent();
      const [updated] = await db
        .update(emailIngest)
        .set({
          conversationId,
          messagePersisted: true,
          pipelineStage: 'message_persisted',
          updatedAt: new Date(),
        })
        .where(and(eq(emailIngest.id, ingestId), eq(emailIngest.scoreStatus, 'prepared')))
        .returning({ id: emailIngest.id });
      if (!updated) {
        const record = await db
          .select({
            pipelineStage: emailIngest.pipelineStage,
            messagePersisted: emailIngest.messagePersisted,
          })
          .from(emailIngest)
          .where(eq(emailIngest.id, ingestId))
          .limit(1);
        if (!record[0]?.messagePersisted && record[0]?.pipelineStage !== 'complete')
          throw new Error('email ingest score is not prepared for source checkpoint');
      }
    },
    async completeForwardedIngest(ingestId, input, lease) {
      await lease?.assertCurrent();
      const [updated] = await db
        .update(emailIngest)
        .set({
          pipelineStage: 'complete',
          triaged: input.triaged,
          triageTaskId: input.taskId ?? null,
          updatedAt: input.now,
        })
        .where(and(eq(emailIngest.id, ingestId), eq(emailIngest.messagePersisted, true)))
        .returning({ id: emailIngest.id });
      if (!updated) throw new Error('email ingest source is not ready to complete');
    },
    async beginDirectEmailIngest(input, options) {
      if (ownerAgentId && input.agentId !== ownerAgentId)
        throw new Error('Email ingest is outside the configured owner');
      if (input.ingestMode !== 'direct' || !input.authenticated)
        throw new Error('Direct email ingest requires receiver authentication before admission');
      if (
        input.emailContentProvenance != null &&
        (!isValidEmailContentProvenanceSnapshot(input.emailContentProvenance) ||
          input.emailContentProvenance.mode !== 'direct' ||
          input.emailContentProvenance.authenticated !== true ||
          input.emailContentProvenance.hasExternalOrUnknown !==
            (input.hasExternalOrUnknown ?? true))
      )
        throw new Error('Direct email provenance is invalid or inconsistent');
      if (input.directRouting === 'needs_attention' || input.directRecoveryReason != null)
        throw new Error('Direct recovery terminal state cannot be set during ingest creation');
      if (input.channelMessageId !== `gmail:${input.providerMessageId}`)
        throw new Error('Direct email source identity is malformed');
      const id = randomUUID();
      await options.lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const currentFence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (currentFence !== options.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during direct email admission');
        if (options.lease) {
          const now = new Date();
          const [leaseRow] = await txDb
            .select({ mailbox: gmailSyncState.mailbox })
            .from(gmailSyncState)
            .where(
              and(
                eq(gmailSyncState.mailbox, input.mailbox),
                eq(gmailSyncState.leaseHolder, options.lease.holder),
                eq(gmailSyncState.leaseGeneration, options.lease.generation),
                gt(gmailSyncState.leaseExpiresAt, now),
              ),
            )
            .for('update')
            .limit(1);
          if (!leaseRow) throw new Error('Gmail sync lease is no longer current');
        }
        const [existing] = await txDb
          .select({ id: emailIngest.id, agentId: emailIngest.agentId })
          .from(emailIngest)
          .where(eq(emailIngest.channelMessageId, input.channelMessageId))
          .for('update')
          .limit(1);
        if (existing) {
          if (existing.agentId !== input.agentId)
            throw new Error('Email source belongs to another owner');
          return;
        }
        await txDb.insert(emailIngest).values({
          ...input,
          id,
          ingestMode: 'direct',
          hasExternalOrUnknown: input.hasExternalOrUnknown ?? true,
          observerRegistrySnapshot: null,
          observerRegistryHash: null,
          admittedSourceKind: null,
          admittedSourceId: null,
          classificationStatus: input.classificationStatus ?? 'pending',
          classificationClaimToken: null,
          preparedClassification: null,
          scoreOutcome: 'provider_outcome_unknown',
          pipelineStage: 'pending_classification',
          scoreStatus: 'pending',
          scoreClaimToken: null,
          cardCandidate: false,
          nextStep: null,
          messagePersisted: false,
          triageTaskId: null,
          triaged: false,
          extractedAt: null,
          preparedExtraction: null,
          securityEvidence: input.securityEvidence ?? null,
          securityIncidentId: input.securityIncidentId ?? null,
          providerThreadId: input.providerThreadId ?? null,
          providerReceivedAt: input.providerReceivedAt ?? null,
          sourceMessageId: input.sourceMessageId ?? null,
          obligationStatus: 'unknown',
          obligationVersion: 0,
          obligationDecision: null,
          obligationDecisionAt: null,
          obligationSnoozedUntil: null,
        });
      });
      const record = await this.ingestRecord(input.channelMessageId);
      if (!record) throw new Error('direct email ingest stage could not be created or loaded');
      return record;
    },
    async claimIngestClassification(agentId, ingestId, token, expectedPrivacyGeneration, lease) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (fence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed before email classification');
        const [claimed] = await txDb
          .update(emailIngest)
          .set({
            pipelineStage: 'classifying',
            classificationStatus: 'in_progress',
            classificationClaimToken: token,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.ingestMode, 'direct'),
              eq(emailIngest.authenticated, true),
              eq(emailIngest.classificationStatus, 'pending'),
            ),
          )
          .returning({ id: emailIngest.id });
        return Boolean(claimed);
      });
    },
    async prepareIngestClassification(
      agentId,
      ingestId,
      token,
      result,
      expectedPrivacyGeneration,
      lease,
    ) {
      await lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (fence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during email classification');
        const [prepared] = await txDb
          .update(emailIngest)
          .set({
            classificationStatus: 'prepared',
            preparedClassification: result,
            pipelineStage: 'pending_score',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.classificationStatus, 'in_progress'),
              eq(emailIngest.classificationClaimToken, token),
            ),
          )
          .returning({ id: emailIngest.id });
        if (!prepared) throw new Error('Email classification claim is no longer current');
      });
    },
    async markIngestClassificationUnknown(
      agentId,
      ingestId,
      token,
      fallback,
      expectedPrivacyGeneration,
      lease,
    ) {
      if (ownerAgentId && agentId !== ownerAgentId) throw new Error('Email ingest owner mismatch');
      await lease?.assertCurrent();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, agentId);
        if (fence !== expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed before classification outcome recording');
        const [marked] = await txDb
          .update(emailIngest)
          .set({
            classificationStatus: 'unknown',
            preparedClassification: fallback,
            pipelineStage: fallback ? 'pending_score' : 'needs_attention',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailIngest.id, ingestId),
              eq(emailIngest.agentId, agentId),
              eq(emailIngest.classificationStatus, 'in_progress'),
              eq(emailIngest.classificationClaimToken, token),
            ),
          )
          .returning({ id: emailIngest.id });
        if (!marked) throw new Error('Email classification claim is no longer current');
      });
    },
    async listDueEmailObservers(agentId, now, limit, excludedObserverIdentities) {
      if (ownerAgentId && agentId !== ownerAgentId)
        throw new Error('Email observer owner mismatch');
      const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
      const excluded = excludedObserverIdentities ?? [];
      if (
        excluded.length > 10 ||
        excluded.some(
          ({ key, version, workClass }) =>
            !key.trim() ||
            !Number.isSafeInteger(version) ||
            version < 1 ||
            !['idempotent_db', 'paid_ambiguous', 'external_provider'].includes(workClass),
        ) ||
        new Set(excluded.map(({ key, version }) => `${key}\u0000${version}`)).size !==
          excluded.length
      )
        throw new Error('Email observer exclusions are invalid or exceed the registry bound');
      const exclusion = excluded.length
        ? not(
            or(
              ...excluded.map(
                (identity) =>
                  and(
                    eq(emailObserverWork.observerKey, identity.key),
                    eq(emailObserverWork.observerVersion, identity.version),
                    eq(emailObserverWork.workClass, identity.workClass),
                  )!,
              ),
            )!,
          )!
        : sql`true`;
      const rows = await db
        .select()
        .from(emailObserverWork)
        .where(
          and(
            eq(emailObserverWork.agentId, agentId),
            exclusion,
            or(
              inArray(emailObserverWork.status, ['pending', 'retryable_failed', 'prepared']),
              and(
                eq(emailObserverWork.status, 'claimed'),
                lte(emailObserverWork.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .orderBy(asc(emailObserverWork.createdAt), asc(emailObserverWork.id))
        .limit(bounded);
      return rows.map(emailObserverRecord);
    },
    async claimEmailObserver(input) {
      if (ownerAgentId && input.agentId !== ownerAgentId)
        throw new Error('Email observer owner mismatch');
      if (!input.token || input.leaseMs < 1 || input.leaseMs > 10 * 60_000)
        throw new Error('Email observer claim lease is invalid');
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed before email observer claim');
        const [row] = await txDb
          .select()
          .from(emailObserverWork)
          .where(
            and(eq(emailObserverWork.id, input.id), eq(emailObserverWork.agentId, input.agentId)),
          )
          .for('update')
          .limit(1);
        if (!row || row.privacyGeneration !== fence) return { kind: 'none' } as const;
        let now = new Date();
        const expired =
          ['claimed', 'prepared'].includes(row.status) &&
          (!row.leaseExpiresAt || row.leaseExpiresAt <= now);
        const preparedResume =
          row.preparedResult != null &&
          (row.status === 'prepared' || row.status === 'retryable_failed' || expired);
        if (['claimed', 'prepared'].includes(row.status) && !expired)
          return { kind: 'none' } as const;
        if (row.status === 'prepared' && row.preparedResult == null) {
          await txDb
            .update(emailObserverWork)
            .set({ status: 'unknown', claimToken: null, leaseExpiresAt: null, updatedAt: now })
            .where(
              and(eq(emailObserverWork.id, row.id), eq(emailObserverWork.agentId, input.agentId)),
            );
          return { kind: 'none' } as const;
        }
        if (
          preparedResume &&
          row.workClass === 'paid_ambiguous' &&
          (!row.budgetReserved || row.budgetKey !== row.observerKey || !row.budgetWindowStart)
        )
          throw new Error('Prepared paid observer is missing its original budget reservation');
        if (expired && !preparedResume && row.workClass !== 'idempotent_db') {
          await txDb
            .update(emailObserverWork)
            .set({ status: 'unknown', claimToken: null, leaseExpiresAt: null, updatedAt: now })
            .where(
              and(eq(emailObserverWork.id, row.id), eq(emailObserverWork.agentId, input.agentId)),
            );
          return { kind: 'none' } as const;
        }
        const eligible =
          row.status === 'pending' ||
          row.status === 'retryable_failed' ||
          row.status === 'prepared' ||
          (expired && row.workClass === 'idempotent_db');
        if (!eligible) return { kind: 'none' } as const;

        let budgetReserved = row.budgetReserved;
        let budgetKey = row.budgetKey;
        let budgetWindowStart = row.budgetWindowStart;
        if (row.workClass === 'paid_ambiguous' && !budgetReserved) {
          const budget = input.paidBudget;
          if (
            !budget ||
            budget.budgetKey !== row.observerKey ||
            budget.observerKey !== row.observerKey ||
            !Number.isInteger(budget.limit) ||
            budget.limit < 0 ||
            budget.limit > 1000 ||
            budget.windowStart.getUTCHours() !== 0 ||
            budget.windowStart.getUTCMinutes() !== 0 ||
            budget.windowStart.getUTCSeconds() !== 0 ||
            budget.windowStart.getUTCMilliseconds() !== 0 ||
            budget.windowEnd.getTime() - budget.windowStart.getTime() !== 86_400_000 ||
            now < budget.windowStart ||
            now >= budget.windowEnd
          )
            throw new Error('Paid email observer claim requires a matching UTC-day budget');
          const bucketId = emailObserverBudgetId(
            input.agentId,
            row.observerKey,
            budget.windowStart,
          );
          await txDb
            .insert(emailObserverBudgets)
            .values({
              id: bucketId,
              agentId: input.agentId,
              observerKey: row.observerKey,
              utcWindowStart: budget.windowStart,
              utcWindowEnd: budget.windowEnd,
              reservedCount: 0,
              limit: budget.limit,
            })
            .onConflictDoNothing({
              target: [
                emailObserverBudgets.agentId,
                emailObserverBudgets.observerKey,
                emailObserverBudgets.utcWindowStart,
              ],
            });
          const [bucket] = await txDb
            .select()
            .from(emailObserverBudgets)
            .where(
              and(
                eq(emailObserverBudgets.id, bucketId),
                eq(emailObserverBudgets.agentId, input.agentId),
              ),
            )
            .for('update')
            .limit(1);
          if (
            !bucket ||
            bucket.limit !== budget.limit ||
            bucket.utcWindowEnd.getTime() !== budget.windowEnd.getTime()
          )
            throw new Error(
              'Paid email observer budget configuration changed for an active window',
            );
          now = new Date();
          if (now < budget.windowStart || now >= budget.windowEnd)
            throw new Error('Paid email observer budget window expired while claiming');
          if (budget.limit === 0 || bucket.reservedCount >= budget.limit) {
            await txDb
              .update(emailObserverWork)
              .set({
                status: 'skipped_budget',
                claimToken: null,
                leaseExpiresAt: null,
                updatedAt: now,
              })
              .where(
                and(eq(emailObserverWork.id, row.id), eq(emailObserverWork.agentId, input.agentId)),
              );
            return { kind: 'skipped_budget', id: row.id } as const;
          }
          await txDb
            .update(emailObserverBudgets)
            .set({ reservedCount: bucket.reservedCount + 1, updatedAt: now })
            .where(
              and(
                eq(emailObserverBudgets.id, bucket.id),
                eq(emailObserverBudgets.agentId, input.agentId),
              ),
            );
          budgetReserved = true;
          budgetKey = row.observerKey;
          budgetWindowStart = budget.windowStart;
        }

        const nextStatus = preparedResume ? 'prepared' : 'claimed';
        const [claimed] = await txDb
          .update(emailObserverWork)
          .set({
            status: nextStatus,
            attemptCount: row.attemptCount + (preparedResume ? 0 : 1),
            claimToken: input.token,
            claimGeneration: row.claimGeneration + 1,
            leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
            claimedAt: now,
            budgetReserved,
            budgetKey,
            budgetWindowStart,
            updatedAt: now,
          })
          .where(
            and(eq(emailObserverWork.id, row.id), eq(emailObserverWork.agentId, input.agentId)),
          )
          .returning();
        if (!claimed) return { kind: 'none' } as const;
        return {
          kind: 'claimed',
          claim: emailObserverRecord(claimed) as EmailObserverClaim,
        } as const;
      });
    },
    async claimNextEmailObserver(input) {
      const rows = await this.listDueEmailObservers(input.agentId, input.now, input.limit ?? 32);
      for (const row of rows) {
        const result = await this.claimEmailObserver({
          id: row.id,
          agentId: input.agentId,
          token: input.token,
          now: input.now,
          leaseMs: input.leaseMs,
          expectedPrivacyGeneration: input.expectedPrivacyGeneration,
          ...(input.paidBudget ? { paidBudget: input.paidBudget } : {}),
        });
        if (result.kind !== 'none') return result;
      }
      return { kind: 'none' } as const;
    },
    async loadEmailObserverSource(claim) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, claim.agentId);
        if (fence !== claim.privacyGeneration) return null;
        const [work] = await txDb
          .select()
          .from(emailObserverWork)
          .where(
            and(
              eq(emailObserverWork.id, claim.id),
              eq(emailObserverWork.agentId, claim.agentId),
              eq(emailObserverWork.claimToken, claim.claimToken),
              eq(emailObserverWork.claimGeneration, claim.claimGeneration),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
            ),
          )
          .for('update')
          .limit(1);
        if (
          !work ||
          !work.leaseExpiresAt ||
          work.leaseExpiresAt <= new Date() ||
          work.privacyGeneration !== fence ||
          claim.sourceKey !== work.sourceKey ||
          claim.channelMessageId !== work.channelMessageId ||
          claim.sourceKind !== work.sourceKind
        )
          return null;
        const [ingest] = await txDb
          .select()
          .from(emailIngest)
          .where(
            and(
              eq(emailIngest.agentId, claim.agentId),
              eq(emailIngest.channelMessageId, work.channelMessageId),
            ),
          )
          .limit(1);
        if (!ingest || ingest.admittedSourceKind !== work.sourceKind || !ingest.admittedSourceId)
          return null;
        if (
          ingest.emailContentProvenance != null &&
          !isValidEmailContentProvenanceSnapshot(ingest.emailContentProvenance)
        )
          return null;
        if (ingest.ingestMode === 'direct' && ingest.authenticated !== true) return null;
        if (ingest.ingestMode !== 'direct' && ingest.ingestMode !== 'forwarded') return null;
        if (!['owner', 'known', 'unknown'].includes(ingest.contentTrust)) return null;
        let body: string;
        let messageId: string | null = null;
        let origin: EmailObserverSource['origin'] = null;
        let sourceId: string;
        if (work.sourceKind === 'message') {
          const [source] = await txDb
            .select({
              id: messages.id,
              conversationId: messages.conversationId,
              parts: messages.parts,
              origin: messages.origin,
            })
            .from(messages)
            .innerJoin(conversations, eq(messages.conversationId, conversations.id))
            .where(
              and(
                eq(messages.channelMessageId, work.channelMessageId),
                eq(conversations.agentId, claim.agentId),
              ),
            )
            .limit(1);
          if (!source || source.id !== ingest.admittedSourceId) return null;
          const parts = Array.isArray(source.parts) ? source.parts : [];
          const textPart = parts.find(
            (part): part is { type: string; text: string } =>
              !!part &&
              typeof part === 'object' &&
              'type' in part &&
              'text' in part &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string',
          );
          if (!textPart) return null;
          body = textPart.text;
          messageId = source.id;
          sourceId = source.id;
          origin = source.origin;
        } else {
          const [source] = await txDb
            .select()
            .from(emailObserverSources)
            .where(
              and(
                eq(emailObserverSources.agentId, claim.agentId),
                eq(emailObserverSources.sourceKey, work.sourceKey),
                eq(emailObserverSources.channelMessageId, work.channelMessageId),
                ...(fence === null
                  ? [isNull(emailObserverSources.privacyGeneration)]
                  : [eq(emailObserverSources.privacyGeneration, fence)]),
              ),
            )
            .limit(1);
          if (!source || source.id !== ingest.admittedSourceId) return null;
          body = source.body;
          sourceId = source.id;
        }
        return {
          agentId: ingest.agentId,
          messageId,
          sourceId,
          from: ingest.fromEmail,
          subject: ingest.subject,
          body,
          authenticated: ingest.authenticated,
          origin,
          contentTrust: ingest.contentTrust as 'owner' | 'known' | 'unknown',
          directRouting: ingest.directRouting as
            | 'application_confirmation'
            | 'email_triage'
            | 'needs_attention'
            | null,
          emailContentProvenance: ingest.emailContentProvenance,
          ingestMode: ingest.ingestMode as 'direct' | 'forwarded',
          sourceVerification:
            ingest.ingestMode === 'forwarded' ? 'forwarded_unverified' : 'authenticated',
          hasExternalOrUnknown: ingest.hasExternalOrUnknown,
        };
      });
    },
    async prepareEmailObserver(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration) return false;
        const [current] = await txDb
          .select()
          .from(emailObserverWork)
          .where(
            and(
              eq(emailObserverWork.id, input.id),
              eq(emailObserverWork.agentId, input.agentId),
              eq(emailObserverWork.claimToken, input.claimToken),
              eq(emailObserverWork.claimGeneration, input.claimGeneration),
              ...(input.expectedPrivacyGeneration === null
                ? [isNull(emailObserverWork.privacyGeneration)]
                : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
            ),
          )
          .for('update')
          .limit(1);
        const now = new Date();
        if (
          !current ||
          !current.leaseExpiresAt ||
          current.leaseExpiresAt <= now ||
          !isValidEmailObserverPreparedResult(current.observerKey, input.result)
        )
          return false;
        if (current.status === 'prepared')
          return sameEmailObserverPreparedResult(
            current.observerKey,
            current.preparedResult,
            input.result,
          );
        const [row] = await txDb
          .update(emailObserverWork)
          .set({
            status: 'prepared',
            preparedResult: input.result,
            deliveryKey: emailObserverDeliveryKey(
              input.agentId,
              current.sourceKey,
              current.observerKey,
              current.observerVersion,
            ),
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(emailObserverWork.id, input.id),
              eq(emailObserverWork.agentId, input.agentId),
              eq(emailObserverWork.claimToken, input.claimToken),
              eq(emailObserverWork.claimGeneration, input.claimGeneration),
              ...(input.expectedPrivacyGeneration === null
                ? [isNull(emailObserverWork.privacyGeneration)]
                : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
              gt(emailObserverWork.leaseExpiresAt, now),
            ),
          )
          .returning({ id: emailObserverWork.id });
        return Boolean(row);
      });
    },
    async completeEmailObserver(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration) return false;
        const [current] = await txDb
          .select()
          .from(emailObserverWork)
          .where(
            and(
              eq(emailObserverWork.id, input.id),
              eq(emailObserverWork.agentId, input.agentId),
              eq(emailObserverWork.claimToken, input.claimToken),
              eq(emailObserverWork.claimGeneration, input.claimGeneration),
              ...(input.expectedPrivacyGeneration === null
                ? [isNull(emailObserverWork.privacyGeneration)]
                : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
            ),
          )
          .for('update')
          .limit(1);
        const now = new Date();
        if (!current || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return false;
        const [row] = await txDb
          .update(emailObserverWork)
          .set({
            status: 'complete',
            preparedResult: null,
            deliveryKey: null,
            claimToken: null,
            leaseExpiresAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(emailObserverWork.id, input.id),
              eq(emailObserverWork.agentId, input.agentId),
              eq(emailObserverWork.claimToken, input.claimToken),
              eq(emailObserverWork.claimGeneration, input.claimGeneration),
              ...(input.expectedPrivacyGeneration === null
                ? [isNull(emailObserverWork.privacyGeneration)]
                : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
              gt(emailObserverWork.leaseExpiresAt, now),
            ),
          )
          .returning({ id: emailObserverWork.id });
        return Boolean(row);
      });
    },
    async failEmailObserver(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration) return false;
        if (input.outcome === 'budget_blocked') {
          const [current] = await txDb
            .select()
            .from(emailObserverWork)
            .where(
              and(
                eq(emailObserverWork.id, input.id),
                eq(emailObserverWork.agentId, input.agentId),
                eq(emailObserverWork.claimToken, input.claimToken),
                eq(emailObserverWork.claimGeneration, input.claimGeneration),
                ...(input.expectedPrivacyGeneration === null
                  ? [isNull(emailObserverWork.privacyGeneration)]
                  : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
                eq(emailObserverWork.status, 'claimed'),
              ),
            )
            .for('update')
            .limit(1);
          let now = new Date();
          if (
            !current ||
            !current.leaseExpiresAt ||
            current.leaseExpiresAt <= now ||
            current.workClass !== 'paid_ambiguous' ||
            current.preparedResult !== null ||
            !current.budgetReserved ||
            current.budgetKey !== current.observerKey ||
            !current.budgetWindowStart
          )
            return false;
          const bucketId = emailObserverBudgetId(
            input.agentId,
            current.observerKey,
            current.budgetWindowStart,
          );
          const [bucket] = await txDb
            .select()
            .from(emailObserverBudgets)
            .where(
              and(
                eq(emailObserverBudgets.id, bucketId),
                eq(emailObserverBudgets.agentId, input.agentId),
              ),
            )
            .for('update')
            .limit(1);
          now = new Date();
          if (
            !current.leaseExpiresAt ||
            current.leaseExpiresAt <= now ||
            !bucket ||
            bucket.reservedCount < 1
          )
            return false;
          await txDb
            .update(emailObserverBudgets)
            .set({ reservedCount: bucket.reservedCount - 1, updatedAt: now })
            .where(
              and(
                eq(emailObserverBudgets.id, bucket.id),
                eq(emailObserverBudgets.agentId, input.agentId),
              ),
            );
          const [released] = await txDb
            .update(emailObserverWork)
            .set({
              status: 'retryable_failed',
              budgetReserved: false,
              budgetKey: null,
              budgetWindowStart: null,
              claimToken: null,
              leaseExpiresAt: null,
              completedAt: null,
              lastErrorCode: safeEmailObserverErrorCode(
                input.errorCode ?? 'email_observer_budget_blocked',
              ),
              updatedAt: now,
            })
            .where(
              and(
                eq(emailObserverWork.id, input.id),
                eq(emailObserverWork.agentId, input.agentId),
                eq(emailObserverWork.claimToken, input.claimToken),
                eq(emailObserverWork.claimGeneration, input.claimGeneration),
                eq(emailObserverWork.status, 'claimed'),
                gt(emailObserverWork.leaseExpiresAt, now),
              ),
            )
            .returning({ id: emailObserverWork.id });
          return Boolean(released);
        }
        const [current] = await txDb
          .select()
          .from(emailObserverWork)
          .where(
            and(
              eq(emailObserverWork.id, input.id),
              eq(emailObserverWork.agentId, input.agentId),
              eq(emailObserverWork.claimToken, input.claimToken),
              eq(emailObserverWork.claimGeneration, input.claimGeneration),
              ...(input.expectedPrivacyGeneration === null
                ? [isNull(emailObserverWork.privacyGeneration)]
                : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
            ),
          )
          .for('update')
          .limit(1);
        const now = new Date();
        if (!current || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return false;
        const [row] = await txDb
          .update(emailObserverWork)
          .set({
            status: input.outcome,
            ...(input.outcome === 'no_op' ? { preparedResult: null, deliveryKey: null } : {}),
            lastErrorCode: safeEmailObserverErrorCode(input.errorCode),
            claimToken: null,
            leaseExpiresAt: null,
            completedAt: input.outcome === 'no_op' ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(emailObserverWork.id, input.id),
              eq(emailObserverWork.agentId, input.agentId),
              eq(emailObserverWork.claimToken, input.claimToken),
              eq(emailObserverWork.claimGeneration, input.claimGeneration),
              ...(input.expectedPrivacyGeneration === null
                ? [isNull(emailObserverWork.privacyGeneration)]
                : [eq(emailObserverWork.privacyGeneration, input.expectedPrivacyGeneration)]),
              inArray(emailObserverWork.status, ['claimed', 'prepared']),
              gt(emailObserverWork.leaseExpiresAt, now),
            ),
          )
          .returning({ id: emailObserverWork.id });
        return Boolean(row);
      });
    },
    async eraseEmailObserverData(agentId, newPrivacyGeneration, now) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockPostgresPrivacyObservationFence(txDb, agentId);
        const workRows = await txDb
          .update(emailObserverWork)
          .set({
            status: sql`case when ${emailObserverWork.status} in ('pending','retryable_failed') then 'skipped_erased' when ${emailObserverWork.status} in ('claimed','prepared') then 'unknown' else ${emailObserverWork.status} end`,
            privacyGeneration: newPrivacyGeneration,
            preparedResult: null,
            deliveryKey: null,
            claimToken: null,
            leaseExpiresAt: null,
            lastErrorCode: 'privacy_erased',
            updatedAt: now,
          })
          .where(eq(emailObserverWork.agentId, agentId))
          .returning({ id: emailObserverWork.id });
        const workIds = workRows.map(({ id }) => id);
        if (workIds.length > 0) {
          const legs = await txDb
            .select()
            .from(notificationOutbox)
            .where(
              and(
                eq(notificationOutbox.agentId, agentId),
                inArray(notificationOutbox.producerWorkId, workIds),
              ),
            )
            .for('update');
          const dashboardMessageIds = legs
            .filter((leg) => leg.adapter === 'dashboard')
            .map((leg) => notificationDashboardMessageId(agentId, leg.deliveryKey, leg.legKey));
          if (dashboardMessageIds.length > 0)
            await txDb
              .delete(messages)
              .where(inArray(messages.channelMessageId, dashboardMessageIds));
          for (const leg of legs) {
            await txDb
              .update(notificationOutbox)
              .set({
                status:
                  leg.status === 'sending'
                    ? 'unknown'
                    : leg.status === 'pending' || leg.status === 'failed'
                      ? 'skipped'
                      : leg.status,
                retryable: false,
                destination: null,
                payload: null,
                leaseToken: null,
                leaseUntil: null,
                result: { reason: 'privacy-erased' },
                finishedAt: now,
                updatedAt: now,
              })
              .where(
                and(eq(notificationOutbox.id, leg.id), eq(notificationOutbox.agentId, agentId)),
              );
          }
        }
        const sources = await txDb
          .delete(emailObserverSources)
          .where(eq(emailObserverSources.agentId, agentId))
          .returning({ id: emailObserverSources.id });
        return { workRows: workRows.length, sources: sources.length };
      });
    },
    async commitEmailAdmission(
      input: EmailAdmissionCommitInput,
    ): Promise<EmailAdmissionCommitResult> {
      if (ownerAgentId && input.agentId !== ownerAgentId)
        throw new Error('Email admission owner mismatch');
      if (input.finalizedIngest.agentId !== input.agentId)
        throw new Error('Email admission owner mismatch');
      const channelMessageId = input.finalizedIngest.channelMessageId;
      if (!channelMessageId.startsWith('gmail:'))
        throw new Error('Email channel message id is invalid');
      if (
        input.source.kind === 'message' &&
        input.source.message.channelMessageId !== channelMessageId
      )
        throw new Error('Email message source id does not match its ingest row');
      if (input.source.kind === 'automated_source' && input.source.body.length > 20_000)
        throw new Error('Automated email source body exceeds its durable bound');
      const snapshot = observerRegistrySnapshot(input.observers);
      const registryHash = observerRegistryHash(snapshot);
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const fence = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (fence !== input.expectedPrivacyGeneration)
          throw new Error('Privacy erasure changed during email admission');
        const [ingest] = await txDb
          .select()
          .from(emailIngest)
          .where(and(eq(emailIngest.id, input.ingestId), eq(emailIngest.agentId, input.agentId)))
          .for('update')
          .limit(1);
        if (!ingest || ingest.channelMessageId !== channelMessageId)
          throw new Error('Email admission checkpoint is unavailable');
        if (
          input.finalizedIngest.emailContentProvenance != null &&
          (!isValidEmailContentProvenanceSnapshot(input.finalizedIngest.emailContentProvenance) ||
            input.finalizedIngest.emailContentProvenance.mode !== 'direct' ||
            input.finalizedIngest.emailContentProvenance.authenticated !== ingest.authenticated ||
            input.finalizedIngest.emailContentProvenance.hasExternalOrUnknown !==
              ingest.hasExternalOrUnknown)
        )
          throw new Error('Direct email provenance is invalid or inconsistent');
        if (
          ingest.emailContentProvenance != null &&
          !isValidEmailContentProvenanceSnapshot(ingest.emailContentProvenance)
        )
          throw new Error('Stored direct email provenance is malformed');
        if (ingest.ingestMode === 'direct' && ingest.authenticated !== true)
          throw new Error('Unauthenticated direct email cannot be admitted');
        const requestedRoute = input.finalizedIngest.directRouting;
        if (
          requestedRoute !== undefined &&
          requestedRoute !== null &&
          !['application_confirmation', 'email_triage'].includes(requestedRoute)
        )
          throw new Error('Direct email admission route is invalid');
        if (ingest.ingestMode !== 'direct' && requestedRoute != null)
          throw new Error('Only direct email may carry a direct routing decision');
        if (
          ingest.directRouting != null &&
          requestedRoute != null &&
          ingest.directRouting !== requestedRoute
        )
          throw new Error('Direct email routing decision is immutable');
        if (
          ingest.emailContentProvenance != null &&
          input.finalizedIngest.emailContentProvenance != null &&
          !isDeepStrictEqual(
            ingest.emailContentProvenance,
            input.finalizedIngest.emailContentProvenance,
          )
        )
          throw new Error('Direct email provenance is immutable');
        const storedClassification = ingest.preparedClassification as {
          automated?: unknown;
        } | null;
        if (
          input.source.kind === 'automated_source' &&
          (ingest.ingestMode !== 'direct' ||
            ingest.authenticated !== true ||
            ingest.classificationStatus !== 'prepared' ||
            storedClassification?.automated !== true)
        )
          throw new Error(
            'Canonical automated source requires the stored authenticated direct automated verdict',
          );
        if (input.lease) {
          const [leaseRow] = await txDb
            .select({ mailbox: gmailSyncState.mailbox })
            .from(gmailSyncState)
            .where(
              and(
                eq(gmailSyncState.mailbox, ingest.mailbox),
                eq(gmailSyncState.leaseHolder, input.lease.holder),
                eq(gmailSyncState.leaseGeneration, input.lease.generation),
                gt(gmailSyncState.leaseExpiresAt, new Date()),
              ),
            )
            .for('update')
            .limit(1);
          if (!leaseRow) throw new Error('Gmail sync lease is no longer current');
        }

        if (ingest.observerRegistrySnapshot !== null) {
          const frozen = observerRegistrySnapshot(
            Array.isArray(ingest.observerRegistrySnapshot)
              ? (ingest.observerRegistrySnapshot as EmailAdmissionCommitInput['observers'])
              : [],
          );
          if (ingest.observerRegistryHash !== observerRegistryHash(frozen))
            throw new Error('Stored email observer registry snapshot is corrupt');
          const ids = frozen.map((item) =>
            emailObserverWorkId(input.agentId, channelMessageId, item.key, item.version),
          );
          const rows = ids.length
            ? await txDb
                .select({ id: emailObserverWork.id })
                .from(emailObserverWork)
                .where(
                  and(
                    eq(emailObserverWork.agentId, input.agentId),
                    inArray(emailObserverWork.id, ids),
                  ),
                )
            : [];
          if (rows.length !== ids.length)
            throw new Error(
              'Frozen email observer work rows are incomplete; explicit repair is required',
            );
          const [message] = await txDb
            .select({
              id: messages.id,
              conversationId: messages.conversationId,
              owner: conversations.agentId,
            })
            .from(messages)
            .innerJoin(conversations, eq(messages.conversationId, conversations.id))
            .where(eq(messages.channelMessageId, channelMessageId))
            .for('update')
            .limit(1);
          const [automated] = await txDb
            .select()
            .from(emailObserverSources)
            .where(eq(emailObserverSources.channelMessageId, channelMessageId))
            .for('update')
            .limit(1);
          if (message && automated)
            throw new Error('Email source exists in both canonical body stores');
          const kind = ingest.admittedSourceKind;
          const id = ingest.admittedSourceId;
          if (!kind || !id)
            throw new Error('Frozen email admission is missing its canonical source pointer');
          if (kind === 'message') {
            if (!message || message.id !== id || automated || message.owner !== input.agentId)
              throw new Error('Frozen visible email source is missing or mismatched');
            return {
              messageId: id,
              sourceId: id,
              ingestId: input.ingestId,
              observerIds: ids,
              duplicate: true,
            };
          }
          if (
            kind !== 'automated_source' ||
            !automated ||
            automated.id !== id ||
            message ||
            automated.agentId !== input.agentId ||
            automated.sourceKey !== channelMessageId ||
            automated.privacyGeneration !== fence ||
            automated.channelMessageId !== channelMessageId
          )
            throw new Error('Frozen automated email source is missing or mismatched');
          return {
            messageId: null,
            sourceId: id,
            ingestId: input.ingestId,
            observerIds: ids,
            duplicate: true,
          };
        }

        if (
          ingest.messagePersisted ||
          ingest.pipelineStage === 'message_persisted' ||
          ingest.admittedSourceKind !== null ||
          ingest.admittedSourceId !== null
        )
          throw new Error('Legacy persisted email requires explicit bounded observer reprocessing');
        const proposedIds = snapshot.map((item) =>
          emailObserverWorkId(input.agentId, channelMessageId, item.key, item.version),
        );
        const preexistingWork = proposedIds.length
          ? await txDb
              .select({ id: emailObserverWork.id })
              .from(emailObserverWork)
              .where(
                and(
                  eq(emailObserverWork.agentId, input.agentId),
                  inArray(emailObserverWork.id, proposedIds),
                ),
              )
          : [];
        if (preexistingWork.length)
          throw new Error('Email observer work exists without its frozen admission snapshot');
        const scorePrepared =
          ingest.scoreStatus === 'prepared' && ingest.scoreClaimToken === input.scoreClaimToken;
        const fallbackCommitted =
          ingest.scoreStatus === 'unknown' &&
          ingest.scoreOutcome === 'fallback_committed_unknown' &&
          ingest.scoreClaimToken === input.scoreClaimToken;
        if (!scorePrepared && !fallbackCommitted)
          throw new Error(
            'Email admission requires a durably prepared score or explicit stored fallback',
          );
        const [existingMessage] = await txDb
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            owner: conversations.agentId,
          })
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(eq(messages.channelMessageId, channelMessageId))
          .for('update')
          .limit(1);
        const [existingAutomated] = await txDb
          .select()
          .from(emailObserverSources)
          .where(eq(emailObserverSources.channelMessageId, channelMessageId))
          .for('update')
          .limit(1);
        if (
          existingAutomated &&
          (existingAutomated.agentId !== input.agentId ||
            existingAutomated.sourceKey !== channelMessageId ||
            existingAutomated.id !== emailObserverSourceId(input.agentId, channelMessageId))
        )
          throw new Error('Email automated source identity is already bound to another owner');
        if (existingMessage && existingAutomated)
          throw new Error('Email source exists in both canonical body stores');
        let messageId: string | null = null;
        let sourceId: string;
        const sourceKind = input.source.kind;
        if (sourceKind === 'message') {
          if (existingAutomated)
            throw new Error('Email source already exists in the automated canonical store');
          const conversationId = input.source.message.conversationId;
          const [conversation] = await txDb
            .select({ agentId: conversations.agentId })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('update')
            .limit(1);
          if (!conversation || conversation.agentId !== input.agentId)
            throw new Error('Email conversation belongs to another owner');
          if (existingMessage) {
            if (
              existingMessage.owner !== input.agentId ||
              existingMessage.conversationId !== conversationId
            )
              throw new Error('Email source cannot move between owners or conversations');
            messageId = existingMessage.id;
          } else {
            const [created] = await txDb
              .insert(messages)
              .values({
                ...input.source.message,
                role: 'user',
                origin:
                  ingest.contentTrust === 'owner'
                    ? 'owner'
                    : ingest.contentTrust === 'known'
                      ? 'known_contact'
                      : 'unknown',
              })
              .onConflictDoNothing({
                target: messages.channelMessageId,
                where: sql`${messages.channelMessageId} IS NOT NULL`,
              })
              .returning({ id: messages.id });
            if (created) messageId = created.id;
            else {
              const [winner] = await txDb
                .select({
                  id: messages.id,
                  conversationId: messages.conversationId,
                  owner: conversations.agentId,
                })
                .from(messages)
                .innerJoin(conversations, eq(messages.conversationId, conversations.id))
                .where(eq(messages.channelMessageId, channelMessageId))
                .limit(1);
              if (
                !winner ||
                winner.owner !== input.agentId ||
                winner.conversationId !== conversationId
              )
                throw new Error(
                  'Concurrent email message admission has a mismatched owner or conversation',
                );
              messageId = winner.id;
            }
          }
          sourceId = messageId;
        } else {
          if (existingMessage) throw new Error('Email source already exists as a visible message');
          const id = emailObserverSourceId(input.agentId, channelMessageId);
          if (existingAutomated) {
            if (
              existingAutomated.channelMessageId !== channelMessageId ||
              existingAutomated.privacyGeneration !== fence ||
              existingAutomated.body !== input.source.body
            )
              throw new Error(
                'Canonical automated source conflicts with an existing owner, fence, or body',
              );
            sourceId = existingAutomated.id;
          } else {
            const [created] = await txDb
              .insert(emailObserverSources)
              .values({
                id,
                agentId: input.agentId,
                sourceKey: channelMessageId,
                channelMessageId,
                body: input.source.body,
                privacyGeneration: fence,
              })
              .returning({ id: emailObserverSources.id });
            sourceId = created!.id;
          }
        }
        const observerIds: string[] = [];
        for (const observer of snapshot) {
          const id = emailObserverWorkId(
            input.agentId,
            channelMessageId,
            observer.key,
            observer.version,
          );
          observerIds.push(id);
          await txDb
            .insert(emailObserverWork)
            .values({
              id,
              agentId: input.agentId,
              sourceKey: channelMessageId,
              channelMessageId,
              sourceKind,
              observerKey: observer.key,
              observerVersion: observer.version,
              workClass: observer.workClass,
              status: 'pending',
              attemptCount: 0,
              claimToken: null,
              claimGeneration: 0,
              leaseExpiresAt: null,
              privacyGeneration: fence,
              budgetKey: null,
              budgetWindowStart: null,
              budgetReserved: false,
              preparedResult: null,
              deliveryKey: null,
              lastErrorCode: null,
              claimedAt: null,
              completedAt: null,
            })
            .onConflictDoNothing({
              target: [
                emailObserverWork.agentId,
                emailObserverWork.sourceKey,
                emailObserverWork.observerKey,
                emailObserverWork.observerVersion,
              ],
            });
        }
        await txDb
          .update(emailIngest)
          .set({
            conversationId: sourceKind === 'message' ? input.source.message.conversationId : null,
            messagePersisted: sourceKind === 'message',
            pipelineStage: 'message_persisted',
            observerRegistrySnapshot: snapshot,
            observerRegistryHash: registryHash,
            admittedSourceKind: sourceKind,
            admittedSourceId: sourceId,
            directRouting: input.finalizedIngest.directRouting ?? ingest.directRouting,
            emailContentProvenance:
              input.finalizedIngest.emailContentProvenance ?? ingest.emailContentProvenance,
            updatedAt: new Date(),
          })
          .where(and(eq(emailIngest.id, input.ingestId), eq(emailIngest.agentId, input.agentId)));
        return { messageId, sourceId, ingestId: input.ingestId, observerIds, duplicate: false };
      });
    },
    async isBookingOccurrenceCurrent(input) {
      const [row] = await db
        .select({
          version: emailBookingOccurrences.version,
          lifecycle: emailBookingOccurrences.lifecycle,
        })
        .from(emailBookingOccurrences)
        .where(
          and(
            eq(emailBookingOccurrences.agentId, input.agentId),
            eq(emailBookingOccurrences.bookingKey, input.bookingKey),
            eq(emailBookingOccurrences.version, input.expectedVersion),
            eq(emailBookingOccurrences.sourceAuthenticated, true),
          ),
        )
        .limit(1);
      return Boolean(
        row &&
          (input.allowedLifecycle === undefined || input.allowedLifecycle.includes(row.lifecycle)),
      );
    },
    async recordIngest(row, observationFence) {
      return db.transaction(async (tx) => {
        if (observationFence !== undefined) {
          const currentFence = await lockPostgresPrivacyObservationFence(
            tx as unknown as Db,
            row.agentId,
          );
          if (currentFence !== observationFence)
            throw new Error('Privacy erasure changed during email source commit');
        }
        const insertRow = {
          ...row,
          securityEvidence: row.securityEvidence ?? null,
          securityIncidentId: row.securityIncidentId ?? null,
          obligationStatus: 'unknown',
          obligationVersion: 0,
          obligationDecision: null,
          obligationDecisionAt: null,
          obligationSnoozedUntil: null,
        } as typeof emailIngest.$inferInsert;
        const [ingested] = await tx
          .insert(emailIngest)
          .values(insertRow)
          .onConflictDoNothing({ target: emailIngest.channelMessageId })
          .returning({ id: emailIngest.id });
        return ingested?.id ?? null;
      });
    },
    async triagedSince(since) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(emailIngest)
        .where(and(eq(emailIngest.triaged, true), gte(emailIngest.createdAt, since)));
      return Number(row?.n ?? 0);
    },
    async markTriaged(ingestId, now) {
      await db
        .update(emailIngest)
        .set({ triaged: true, updatedAt: now })
        .where(eq(emailIngest.id, ingestId));
    },
    async replyThread(conversationId) {
      const [conversation] = await db
        .select({ channel: conversations.channel })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (!conversation) return null;
      const [binding] = await db
        .select({ externalId: channelBindings.externalId })
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.conversationId, conversationId),
            eq(channelBindings.channel, 'email'),
          ),
        )
        .limit(1);
      const [origin] = await db
        .select({ trigger: tasks.trigger })
        .from(tasks)
        .where(
          and(
            eq(tasks.conversationId, conversationId),
            eq(tasks.type, 'email_triage'),
            eq(tasks.trust, 'owner'),
          ),
        )
        .orderBy(asc(tasks.createdAt))
        .limit(1);
      return {
        channel: conversation.channel,
        threadId: binding?.externalId ?? null,
        ownerOriginTrigger: origin?.trigger ?? null,
      };
    },
  };
}
