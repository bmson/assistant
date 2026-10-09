import { randomUUID } from 'node:crypto';
import type {
  SecurityIncidentObservation,
  SecurityIncidentRepository,
} from '@assistant/persistence';
import {
  securityIncidentId,
  securityIncidentIdentity,
  securityIncidentMailboxHash,
} from '@assistant/persistence';
import { and, desc, eq, ne, notExists, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  assertPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  emailIngest,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
} from './schema.js';

const boundedReason = (reason: string) => reason.trim().slice(0, 500);

/** PostgreSQL owner-scoped security incident identity and attention admission. */
export function createPostgresSecurityIncidentRepository(
  db: Db,
  ownerAgentId?: string,
): SecurityIncidentRepository {
  const ownerWhere = (agentId: string) => {
    if (ownerAgentId && ownerAgentId !== agentId)
      throw new Error('Security incident is outside the configured owner');
    return eq(agents.id, agentId);
  };
  return {
    kind: 'security-incident-repository',
    async observe(input: SecurityIncidentObservation) {
      if (
        !input.agentId ||
        !input.channelMessageId ||
        input.channelMessageId.length > 500 ||
        input.mailbox.length > 320 ||
        input.sourceText.length > 20_000
      )
        throw new Error('Invalid security incident source identity');
      if (!(input.observedAt instanceof Date) || !Number.isFinite(input.observedAt.getTime()))
        throw new Error('Invalid security incident observation time');
      const identity = securityIncidentIdentity({
        agentId: input.agentId,
        channelMessageId: input.channelMessageId,
        sourceMessageId: input.sourceMessageId,
        authenticated: input.authenticated,
        evidence: input.evidence,
        sourceText: input.sourceText,
      });
      const id = securityIncidentId(input.agentId, identity.incidentKey);
      const sourceId = securityIncidentId(input.agentId, `source:${input.channelMessageId}`);
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(ownerWhere(input.agentId))
          .for('no key update');
        if (!owner) throw new Error('Security incident owner is unavailable');
        if (Object.hasOwn(input, 'observationFence')) {
          await assertPostgresPrivacyObservationFence(
            tx as unknown as Db,
            input.agentId,
            input.observationFence ?? null,
          );
        } else {
          await postgresPrivacyObservationFence(tx as unknown as Db, input.agentId);
        }
        await tx
          .insert(securityIncidents)
          .values({
            id,
            agentId: input.agentId,
            incidentKey: identity.incidentKey,
            confidence: identity.confidence,
          })
          .onConflictDoNothing({
            target: [securityIncidents.agentId, securityIncidents.incidentKey],
          });
        const [incident] = await tx
          .select()
          .from(securityIncidents)
          .where(
            and(
              eq(securityIncidents.agentId, input.agentId),
              eq(securityIncidents.incidentKey, identity.incidentKey),
            ),
          )
          .for('update');
        if (!incident || incident.id !== id)
          throw new Error('Security incident identity collision');
        const [priorSource] = await tx
          .select()
          .from(securityIncidentSources)
          .where(
            and(
              eq(securityIncidentSources.agentId, input.agentId),
              eq(securityIncidentSources.channelMessageId, input.channelMessageId),
            ),
          )
          .for('update');
        if (priorSource && priorSource.incidentId !== id)
          throw new Error('Security incident source was already attached elsewhere');
        if (priorSource?.evidenceFingerprint === identity.evidenceFingerprint) {
          await tx
            .update(emailIngest)
            .set({ securityIncidentId: id, securityEvidence: input.evidence })
            .where(
              and(
                eq(emailIngest.agentId, input.agentId),
                eq(emailIngest.channelMessageId, input.channelMessageId),
              ),
            );
          return {
            incident,
            source: priorSource,
            duplicateEvidence: true,
            reassessmentReason: null,
          };
        }
        const [source] = priorSource
          ? await tx
              .update(securityIncidentSources)
              .set({
                sourceMessageId: input.sourceMessageId,
                mailboxHash: securityIncidentMailboxHash(input.mailbox),
                evidenceFingerprint: identity.evidenceFingerprint,
                observedAt: input.observedAt,
              })
              .where(eq(securityIncidentSources.id, priorSource.id))
              .returning()
          : await tx
              .insert(securityIncidentSources)
              .values({
                id: sourceId,
                agentId: input.agentId,
                incidentId: id,
                channelMessageId: input.channelMessageId,
                sourceMessageId: input.sourceMessageId,
                mailboxHash: securityIncidentMailboxHash(input.mailbox),
                evidenceFingerprint: identity.evidenceFingerprint,
                observedAt: input.observedAt,
              })
              .onConflictDoNothing({
                target: [securityIncidentSources.agentId, securityIncidentSources.channelMessageId],
              })
              .returning();
        if (!source) throw new Error('Security incident source could not be retained');
        const [priorEvidence] = await tx
          .select({ id: securityIncidentSources.id })
          .from(securityIncidentSources)
          .where(
            and(
              eq(securityIncidentSources.agentId, input.agentId),
              eq(securityIncidentSources.incidentId, id),
              eq(securityIncidentSources.evidenceFingerprint, identity.evidenceFingerprint),
              ne(securityIncidentSources.id, source.id),
            ),
          )
          .limit(2);
        const duplicateEvidence = Boolean(priorEvidence);
        const changed = !duplicateEvidence;
        const reassessmentReason =
          changed && incident.revision > 0
            ? 'New source-quoted security evidence changed the incident evidence fingerprint.'
            : null;
        const [updated] = await tx
          .update(securityIncidents)
          .set({
            confidence: identity.confidence,
            ...(changed
              ? {
                  revision: incident.revision + 1,
                  materialChangeReason: reassessmentReason,
                  updatedAt: input.observedAt,
                }
              : {}),
          })
          .where(and(eq(securityIncidents.agentId, input.agentId), eq(securityIncidents.id, id)))
          .returning();
        await tx
          .update(emailIngest)
          .set({ securityIncidentId: id, securityEvidence: input.evidence })
          .where(
            and(
              eq(emailIngest.agentId, input.agentId),
              eq(emailIngest.channelMessageId, input.channelMessageId),
            ),
          );
        if (!updated) throw new Error('Security incident update lost');
        return { incident: updated, source, duplicateEvidence, reassessmentReason };
      });
    },
    async getForMessage(agentId, channelMessageId) {
      const [owner] = await db.select({ id: agents.id }).from(agents).where(ownerWhere(agentId));
      if (!owner) return null;
      const [source] = await db
        .select({ incidentId: securityIncidentSources.incidentId })
        .from(securityIncidentSources)
        .where(
          and(
            eq(securityIncidentSources.agentId, agentId),
            eq(securityIncidentSources.channelMessageId, channelMessageId),
          ),
        );
      if (!source) return null;
      const [incident] = await db
        .select()
        .from(securityIncidents)
        .where(
          and(eq(securityIncidents.agentId, agentId), eq(securityIncidents.id, source.incidentId)),
        );
      return incident ?? null;
    },
    async listAttentionCandidates(agentId, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Security incident candidate limit must be from one to one hundred');
      return db.transaction(async (tx) => {
        const [owner] = await tx.select({ id: agents.id }).from(agents).where(ownerWhere(agentId));
        if (!owner) return [];
        await postgresPrivacyObservationFence(tx as unknown as Db, agentId);
        const rows = await tx
          .selectDistinctOn([securityIncidents.id], {
            channelMessageId: securityIncidentSources.channelMessageId,
            incidentId: securityIncidents.id,
            revision: securityIncidents.revision,
            confidence: securityIncidents.confidence,
            disposition: securityIncidents.disposition,
            decisionRevision: securityIncidents.decisionRevision,
            materialChangeReason: securityIncidents.materialChangeReason,
            observedAt: securityIncidentSources.observedAt,
            category: emailIngest.category,
            importance: emailIngest.importance,
            subject: emailIngest.subject,
            fromName: emailIngest.fromName,
            evidence: emailIngest.securityEvidence,
          })
          .from(securityIncidentSources)
          .innerJoin(
            securityIncidents,
            and(
              eq(securityIncidents.id, securityIncidentSources.incidentId),
              eq(securityIncidents.agentId, securityIncidentSources.agentId),
            ),
          )
          .innerJoin(
            emailIngest,
            and(
              eq(emailIngest.agentId, securityIncidentSources.agentId),
              eq(emailIngest.channelMessageId, securityIncidentSources.channelMessageId),
            ),
          )
          .where(
            and(
              eq(securityIncidentSources.agentId, agentId),
              eq(emailIngest.category, 'security'),
              sql`${securityIncidents.revision} > 0`,
              or(
                eq(securityIncidents.disposition, 'unreviewed'),
                ne(securityIncidents.decisionRevision, securityIncidents.revision),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(securityIncidentAttention)
                  .where(
                    and(
                      eq(securityIncidentAttention.agentId, agentId),
                      eq(securityIncidentAttention.incidentId, securityIncidents.id),
                      eq(securityIncidentAttention.revision, securityIncidents.revision),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(securityIncidents.id, desc(securityIncidentSources.observedAt))
          .limit(limit);
        return rows
          .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())
          .map((row) => ({
            ...row,
            confidence: row.confidence as
              | 'provider-reference'
              | 'recovery-reference'
              | 'source-message'
              | 'separate-source',
            disposition: row.disposition as 'unreviewed' | 'expected' | 'dismissed',
            subject: row.subject ?? '',
            fromName: row.fromName ?? null,
            evidence: row.evidence as
              | import('@assistant/persistence').SecurityIncidentEvidence
              | null,
          }));
      });
    },
    async decide(input) {
      if (!input.reason.trim() || input.reason.length > 500)
        throw new Error('Invalid incident decision reason');
      const [owner] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(ownerWhere(input.agentId));
      if (!owner) return false;
      const rows = await db
        .update(securityIncidents)
        .set({
          disposition: input.disposition,
          decisionRevision: input.expectedRevision,
          decisionReason: boundedReason(input.reason),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(securityIncidents.agentId, input.agentId),
            eq(securityIncidents.id, input.incidentId),
            eq(securityIncidents.revision, input.expectedRevision),
          ),
        )
        .returning({ id: securityIncidents.id });
      return rows.length === 1;
    },
    async claimAttention(input) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(ownerWhere(input.agentId))
          .for('no key update');
        if (!owner) return false;
        const [incident] = await tx
          .select()
          .from(securityIncidents)
          .where(
            and(
              eq(securityIncidents.agentId, input.agentId),
              eq(securityIncidents.id, input.incidentId),
            ),
          )
          .for('update');
        if (!incident || incident.revision !== input.revision) return false;
        if (
          incident.decisionRevision === incident.revision &&
          (incident.disposition === 'expected' || incident.disposition === 'dismissed')
        )
          return false;
        const rows = await tx
          .insert(securityIncidentAttention)
          .values({
            id: randomUUID(),
            agentId: input.agentId,
            incidentId: input.incidentId,
            revision: input.revision,
            producer: input.producer,
            deliveryStatus: 'claimed',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing({
            target: [
              securityIncidentAttention.agentId,
              securityIncidentAttention.incidentId,
              securityIncidentAttention.revision,
            ],
          })
          .returning({ id: securityIncidentAttention.id });
        return rows.length === 1;
      });
    },
    async completeAttention(input) {
      const [owner] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(ownerWhere(input.agentId));
      if (!owner) return false;
      const rows = await db
        .update(securityIncidentAttention)
        .set({ deliveryStatus: input.deliveryStatus, updatedAt: input.now })
        .where(
          and(
            eq(securityIncidentAttention.agentId, input.agentId),
            eq(securityIncidentAttention.incidentId, input.incidentId),
            eq(securityIncidentAttention.revision, input.revision),
            eq(securityIncidentAttention.deliveryStatus, 'claimed'),
          ),
        )
        .returning({ id: securityIncidentAttention.id });
      return rows.length === 1;
    },
  };
}
