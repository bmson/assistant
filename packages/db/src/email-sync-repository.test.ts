import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresEmailSyncRepository } from './email-sync-repository.js';
import { createPostgresGeneratedCardRepository } from './generated-card-repository.js';
import {
  agents,
  channelBindings,
  conversations,
  emailBookingOccurrences,
  emailIngest,
  emailObserverBudgets,
  emailObserverSources,
  emailObserverWork,
  generatedCards,
  gmailSyncState,
  maintenanceCursors,
  messages,
  securityIncidents,
  suggestions,
} from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL Gmail sync fencing', () => {
  let db: Db;
  let agentId: string;
  let mailbox: string;

  beforeEach(async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    mailbox = `${agentId}@gmail-lease.invalid`;
    await db.insert(agents).values({
      id: agentId,
      name: 'gmail-lease-test',
      email: mailbox,
      workspacePrefix: `gmail-lease/${agentId}`,
    });
    const [selectedOwner] = await db
      .select({ id: agents.id, email: agents.email })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (selectedOwner?.id !== agentId || selectedOwner.email !== mailbox)
      throw new Error('Gmail sync test owner fixture was not persisted');
  });

  afterEach(async () => {
    await db.delete(suggestions).where(eq(suggestions.agentId, agentId));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    await db.delete(emailObserverWork).where(eq(emailObserverWork.agentId, agentId));
    await db.delete(emailObserverSources).where(eq(emailObserverSources.agentId, agentId));
    await db.delete(emailObserverBudgets).where(eq(emailObserverBudgets.agentId, agentId));
    await db.delete(emailBookingOccurrences).where(eq(emailBookingOccurrences.agentId, agentId));
    await db.delete(emailIngest).where(eq(emailIngest.agentId, agentId));
    await db.delete(gmailSyncState).where(eq(gmailSyncState.mailbox, mailbox));
    await db
      .delete(messages)
      .where(
        inArray(
          messages.conversationId,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.agentId, agentId)),
        ),
      );
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  it('finds enabled direct work after more than one page of disabled paid observers', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const now = new Date();
    await db.insert(emailObserverWork).values([
      ...Array.from({ length: 25 }, (_, index) => ({
        id: randomUUID(),
        agentId,
        sourceKey: `disabled-card-${index}`,
        channelMessageId: `gmail:disabled-card-${index}`,
        sourceKind: 'automated_source',
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'paid_ambiguous',
        status: 'pending',
        createdAt: new Date(now.getTime() + index),
        updatedAt: now,
      })),
      {
        id: randomUUID(),
        agentId,
        sourceKey: 'same-version-other-class',
        channelMessageId: 'gmail:same-version-other-class',
        sourceKind: 'automated_source',
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'idempotent_db',
        status: 'pending',
        createdAt: new Date(now.getTime() + 80),
        updatedAt: now,
      },
      {
        id: randomUUID(),
        agentId,
        sourceKey: 'newer-card-observer-version',
        channelMessageId: 'gmail:newer-card-observer-version',
        sourceKind: 'automated_source',
        observerKey: 'google.email-card',
        observerVersion: 2,
        workClass: 'paid_ambiguous',
        status: 'pending',
        createdAt: new Date(now.getTime() + 90),
        updatedAt: now,
      },
      {
        id: randomUUID(),
        agentId,
        sourceKey: 'fresh-direct-route',
        channelMessageId: 'gmail:fresh-direct-route',
        sourceKind: 'automated_source',
        observerKey: 'google.direct-email-routing',
        observerVersion: 1,
        workClass: 'idempotent_db',
        status: 'pending',
        createdAt: new Date(now.getTime() + 100),
        updatedAt: now,
      },
    ]);

    const due = await repository.listDueEmailObservers(agentId, now, 20, [
      { key: 'google.email-card', version: 1, workClass: 'paid_ambiguous' },
    ]);

    expect(due).toHaveLength(3);
    expect(due.map(({ observerKey, observerVersion }) => [observerKey, observerVersion])).toEqual(
      expect.arrayContaining([
        ['google.email-card', 2],
        ['google.email-card', 1],
        ['google.direct-email-routing', 1],
      ]),
    );
  });

  it('lists bounded direct recovery metadata and atomically moves a missing source to needs_attention', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const result = await repository.withLock(async (lease) => {
      const makeIngest = async (messageId: string) =>
        repository.beginDirectEmailIngest(
          {
            agentId,
            mailbox,
            providerMessageId: messageId,
            providerThreadId: 'thread-1',
            sourceMessageId: `<${messageId}@example.test>`,
            channelMessageId: `gmail:${messageId}`,
            conversationId: null,
            fromEmail: 'sender@example.test',
            fromName: null,
            subject: 'Recovery source',
            contentTrust: 'unknown',
            authenticated: true,
            ingestMode: 'direct',
            hasExternalOrUnknown: true,
            category: 'other',
            importance: 1,
            actionable: false,
            reason: '',
            dates: [],
          },
          { expectedPrivacyGeneration: null, lease },
        );
      for (let index = 0; index < 21; index++) await makeIngest(`recover-${index}`);
      const rows = await repository.listRecoverableDirectIngests({
        agentId,
        mailbox,
        expectedPrivacyGeneration: null,
        lease,
        limit: 99,
      });
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((row) => row.id)).size).toBe(20);
      expect(rows[0]).toMatchObject({
        authenticated: true,
        providerMessageId: expect.any(String),
        providerThreadId: 'thread-1',
        admittedSourceKind: null,
        admittedSourceId: null,
        messagePersisted: false,
        classificationStatus: 'pending',
        scoreStatus: 'pending',
      });
      expect(rows[0]).not.toHaveProperty('body');
      expect(rows[0]).not.toHaveProperty('rawHeaders');
      const target = rows[0]!;
      expect(
        await repository.markDirectIngestRecoveryUnavailable({
          agentId,
          mailbox,
          ingestId: target.id,
          expectedPrivacyGeneration: null,
          lease,
          reason: 'provider_message_missing',
        }),
      ).toBe(true);
      const nextPage = await repository.listRecoverableDirectIngests({
        agentId,
        mailbox,
        expectedPrivacyGeneration: null,
        lease,
        limit: 99,
      });
      expect(nextPage).toHaveLength(20);
      expect(nextPage.some((row) => row.id === target.id)).toBe(false);
      const [stored] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, target.id))
        .limit(1);
      expect(stored).toMatchObject({
        pipelineStage: 'needs_attention',
        directRouting: 'needs_attention',
        directRecoveryReason: 'provider_message_missing',
      });
      return true;
    });
    expect(result?.value).toBe(true);
  });

  it('fences expired and superseded cursor writes, and advances generation on takeover', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    let staleLease: import('@assistant/persistence').EmailSyncLease | undefined;

    await repository.withLock(async (lease) => {
      staleLease = lease;
      await repository.raiseBaseline(mailbox, 10n, lease);
      await repository.saveCursor(mailbox, { page: 'before-expiry' }, lease);
      await db
        .update(gmailSyncState)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(gmailSyncState.mailbox, mailbox));
      await expect(repository.saveCursor(mailbox, { page: 'expired' }, lease)).rejects.toThrow(
        'lease is no longer current',
      );
    });

    let nextGeneration = 0;
    await repository.withLock(async (lease) => {
      if (!staleLease) throw new Error('expired worker did not capture its lease');
      nextGeneration = lease.generation;
      expect(nextGeneration).toBeGreaterThan(staleLease?.generation ?? 0);
      await repository.saveCursor(mailbox, { page: 'current' }, lease);
      await expect(staleLease.assertCurrent()).rejects.toThrow('lease is no longer current');
      await expect(
        repository.saveCursor(mailbox, { page: 'late-stale' }, staleLease),
      ).rejects.toThrow('lease is no longer current');
      expect(await repository.syncState(mailbox)).toMatchObject({
        lastHistoryId: 10n,
        cursor: { page: 'current' },
      });
      await lease.renew();
      await lease.assertCurrent();
    });

    const [row] = await db
      .select({ holder: gmailSyncState.leaseHolder, generation: gmailSyncState.leaseGeneration })
      .from(gmailSyncState)
      .where(
        and(
          eq(gmailSyncState.mailbox, mailbox),
          eq(gmailSyncState.leaseGeneration, nextGeneration),
        ),
      );
    expect(row?.holder).toBeTruthy();
  });

  it('claims a scorer once and durably replays the prepared card/source/task stages', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const channelMessageId = `gmail:${randomUUID()}`;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', title: 'staged ingest' })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation fixture was not created');
    const stage = await repository.beginForwardedIngest({
      agentId,
      mailbox,
      providerMessageId: channelMessageId.slice('gmail:'.length),
      channelMessageId,
      conversationId: conversation.id,
      fromEmail: 'sender@example.test',
      fromName: 'Sender',
      subject: 'Ticket',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    });
    const token = randomUUID();

    expect(await repository.claimIngestScore(agentId, stage.id, token, null)).toBe(true);
    expect(await repository.claimIngestScore(agentId, stage.id, randomUUID(), null)).toBe(false);
    await repository.prepareIngestScore(
      agentId,
      stage.id,
      token,
      {
        category: 'travel',
        importance: 2,
        actionable: false,
        reason: 'A ticket to retain.',
        dates: [{ iso: '2026-10-20', what: 'show' }],
        cardCandidate: true,
        nextStep: null,
        securityEvidence: {
          providerIncidentRef: 'case-17',
          eventType: 'sign_in',
          evidenceQuote: 'A new sign-in was detected. Case case-17.',
        },
      },
      null,
    );
    await repository.markIngestMessagePersisted(stage.id, conversation.id);

    const replay = await repository.ingestRecord(channelMessageId);
    expect(replay).toMatchObject({
      pipelineStage: 'message_persisted',
      scoreStatus: 'prepared',
      messagePersisted: true,
      importance: 2,
      cardCandidate: true,
      category: 'travel',
      securityEvidence: {
        providerIncidentRef: 'case-17',
        eventType: 'sign_in',
        evidenceQuote: 'A new sign-in was detected. Case case-17.',
      },
    });
    await repository.completeForwardedIngest(stage.id, {
      triaged: true,
      taskId: randomUUID(),
      now: new Date(),
    });
    expect(await repository.ingestRecord(channelMessageId)).toMatchObject({
      pipelineStage: 'complete',
      triaged: true,
      cardCandidate: true,
      messagePersisted: true,
    });

    const uncertainMessage = `gmail:${randomUUID()}`;
    const uncertain = await repository.beginForwardedIngest({
      agentId,
      mailbox,
      providerMessageId: uncertainMessage.slice('gmail:'.length),
      channelMessageId: uncertainMessage,
      conversationId: conversation.id,
      fromEmail: 'sender@example.test',
      fromName: null,
      subject: 'Scoring interrupted',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    });
    const uncertainToken = randomUUID();
    expect(await repository.claimIngestScore(agentId, uncertain.id, uncertainToken, null)).toBe(
      true,
    );
    await repository.markIngestScoreUnknown(agentId, uncertain.id, uncertainToken, null);
    expect(await repository.claimIngestScore(agentId, uncertain.id, randomUUID(), null)).toBe(
      false,
    );
    expect(await repository.ingestRecord(uncertainMessage)).toMatchObject({
      pipelineStage: 'needs_attention',
      scoreStatus: 'unknown',
    });
  });

  it('uses the latest authenticated booking lifecycle and supersedes only that booking proposal', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', title: 'booking lifecycle' })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation fixture was not created');
    const key = (await import('@assistant/persistence')).emailBookingKey(agentId, 'R-314');

    const ingest = async (
      messageId: string,
      receivedAt: string,
      lifecycle: string,
      dateRole: string,
    ) => {
      const channelMessageId = `gmail:${messageId}`;
      const stage = await repository.beginForwardedIngest({
        agentId,
        mailbox,
        providerMessageId: messageId,
        providerThreadId: 'thread-314',
        providerReceivedAt: new Date(receivedAt),
        channelMessageId,
        conversationId: conversation.id,
        fromEmail: 'travel@example.test',
        fromName: 'Travel',
        subject: `Booking ${lifecycle}`,
        contentTrust: 'known',
        authenticated: true,
        category: 'travel',
        importance: 3,
        actionable: false,
        reason: '',
        dates: [],
      });
      const token = randomUUID();
      expect(await repository.claimIngestScore(agentId, stage.id, token, null)).toBe(true);
      await repository.prepareIngestScore(
        agentId,
        stage.id,
        token,
        {
          category: 'travel',
          importance: 3,
          actionable: false,
          reason: 'Explicit booking update.',
          dates: [
            {
              iso: receivedAt,
              what: 'Berlin spa booking',
              dateRole,
              lifecycle,
              bookingIdentity: 'R-314',
            },
          ],
          cardCandidate: true,
          nextStep: null,
          securityEvidence: null,
        },
        null,
      );
      return channelMessageId;
    };

    await ingest(randomUUID(), '2026-10-01T08:00:00.000Z', 'confirmed', 'event_start');
    const [confirmed] = await db
      .select()
      .from(emailBookingOccurrences)
      .where(eq(emailBookingOccurrences.bookingKey, key));
    expect(confirmed).toMatchObject({ lifecycle: 'confirmed', version: 1 });
    await db.insert(suggestions).values({
      agentId,
      bookingKey: key,
      bookingVersion: 1,
      summary: 'Add the Berlin spa booking?',
      proposedAction: 'Create a calendar event for the Berlin spa booking.',
      origin: 'briefing',
      sourceRef: `booking:${key}:1:event_start`,
      status: 'pending',
      expiresAt: new Date('2026-10-30T00:00:00.000Z'),
    });

    await ingest(randomUUID(), '2026-10-02T08:00:00.000Z', 'cancelled', 'event_start');
    const [cancelled] = await db
      .select()
      .from(emailBookingOccurrences)
      .where(eq(emailBookingOccurrences.bookingKey, key));
    expect(cancelled).toMatchObject({ lifecycle: 'cancelled', version: 2 });
    expect(
      await db
        .select({ status: suggestions.status })
        .from(suggestions)
        .where(eq(suggestions.bookingKey, key)),
    ).toEqual([{ status: 'superseded' }]);
    expect(
      await repository.isBookingOccurrenceCurrent({
        agentId,
        bookingKey: key,
        expectedVersion: 1,
        allowedLifecycle: ['confirmed', 'rescheduled'],
      }),
    ).toBe(false);

    await ingest(randomUUID(), '2026-10-03T08:00:00.000Z', 'confirmed', 'event_start');
    const [reinstated] = await db
      .select()
      .from(emailBookingOccurrences)
      .where(eq(emailBookingOccurrences.bookingKey, key));
    expect(reinstated).toMatchObject({ lifecycle: 'confirmed', version: 3 });
    expect(
      await repository.isBookingOccurrenceCurrent({
        agentId,
        bookingKey: key,
        expectedVersion: 3,
        allowedLifecycle: ['confirmed', 'rescheduled'],
      }),
    ).toBe(true);
  });

  it('fences source scoring and incident observation against a newer erasure generation', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const channelMessageId = `gmail:security-fence:${randomUUID()}`;
    const quote = `Sign-in to ${mailbox} from Pixel 9 at 2026-10-06T18:00:00Z.`;
    const source = {
      agentId,
      channelMessageId,
      conversationId: null,
      fromEmail: 'security@example.test',
      fromName: null,
      subject: 'New sign-in',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'security',
      importance: 3,
      actionable: false,
      reason: '',
      dates: [],
      securityEvidence: {
        eventType: 'sign-in',
        affectedAccount: mailbox,
        eventAt: '2026-10-06T18:00:00Z',
        device: 'Pixel 9',
        evidenceQuote: quote,
      },
    };
    await repository.recordIngest(source, null);
    const staleFence = await repository.privacyObservationFence?.(agentId);
    expect(staleFence).toBeNull();
    await db.insert(maintenanceCursors).values({
      name: `privacy-erasure-generation:${agentId}`,
      cursor: randomUUID(),
    });

    await expect(
      repository.recordIngest(
        {
          ...source,
          channelMessageId: `${channelMessageId}:late`,
        },
        staleFence,
      ),
    ).rejects.toThrow('Privacy erasure changed during email source commit');
    await expect(
      repository.observeSecurityIncident({
        agentId,
        channelMessageId,
        sourceMessageId: '<security@example.test>',
        mailbox,
        authenticated: true,
        evidence: source.securityEvidence,
        sourceText: quote,
        observedAt: new Date(),
        observationFence: staleFence,
      }),
    ).rejects.toThrow('Privacy erasure changed during observation');
    expect(
      await db.select().from(securityIncidents).where(eq(securityIncidents.agentId, agentId)),
    ).toEqual([]);
  });

  it('rejects stale forwarded conversation creation after erasure before writing conversation or binding', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const capturedGeneration = await repository.privacyObservationFence?.(agentId);
    expect(capturedGeneration).toBeNull();
    await db.insert(maintenanceCursors).values({
      name: `privacy-erasure-generation:${agentId}`,
      cursor: randomUUID(),
    });
    const threadId = `gmail-thread:erased:${randomUUID()}`;
    const beforeConversations = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.agentId, agentId));
    const beforeBindings = await db
      .select({ id: channelBindings.id })
      .from(channelBindings)
      .where(and(eq(channelBindings.channel, 'email'), eq(channelBindings.externalId, threadId)));
    await expect(
      repository.conversationForThread(agentId, threadId, 'unknown', 'Private subject', {
        expectedPrivacyGeneration: capturedGeneration ?? null,
      }),
    ).rejects.toThrow('Privacy erasure changed during email conversation admission');
    expect(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.agentId, agentId)),
    ).toEqual(beforeConversations);
    expect(
      await db
        .select({ id: channelBindings.id })
        .from(channelBindings)
        .where(and(eq(channelBindings.channel, 'email'), eq(channelBindings.externalId, threadId))),
    ).toEqual(beforeBindings);
  });

  it('rejects a forwarded checkpoint when erasure advanced during the provider fetch, before writing ingest metadata', async () => {
    const repository = createPostgresEmailSyncRepository(db, agentId);
    const channelMessageId = `gmail:forwarded-erased:${randomUUID()}`;
    const capturedGeneration = await repository.privacyObservationFence?.(agentId);
    expect(capturedGeneration).toBeNull();
    await db.insert(maintenanceCursors).values({
      name: `privacy-erasure-generation:${agentId}`,
      cursor: randomUUID(),
    });
    const row = {
      agentId,
      mailbox,
      providerMessageId: channelMessageId.slice('gmail:'.length),
      channelMessageId,
      conversationId: null,
      fromEmail: 'private-sender@example.test',
      fromName: 'Private Sender',
      subject: 'Private subject captured before erasure',
      contentTrust: 'unknown' as const,
      authenticated: true,
      category: 'other' as const,
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    };
    await expect(
      repository.beginForwardedIngest(row, {
        expectedPrivacyGeneration: capturedGeneration ?? null,
      }),
    ).rejects.toThrow('Privacy erasure changed during forwarded email admission');
    expect(
      await db
        .select({ id: emailIngest.id })
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId)),
    ).toEqual([]);
  });

  describe('PostgreSQL atomic email observer admission', () => {
    async function prepareDirect(messageId: string, automated: boolean) {
      const [conversation] = await db
        .insert(conversations)
        .values({
          agentId,
          channel: 'email',
          trust: 'unknown',
          title: 'Observer test',
        })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('conversation insert failed');
      const channelMessageId = `gmail:${messageId}`;
      const base = {
        agentId,
        mailbox,
        providerMessageId: messageId,
        channelMessageId,
        conversationId: conversation.id,
        fromEmail: 'sender@example.test',
        fromName: null,
        subject: 'Observer source',
        contentTrust: 'unknown',
        authenticated: true,
        ingestMode: 'direct' as const,
        hasExternalOrUnknown: false,
        category: 'other',
        importance: 1,
        actionable: false,
        reason: '',
        dates: [],
      };
      const repository = createPostgresEmailSyncRepository(db, agentId);
      const stage = await repository.beginDirectEmailIngest(base, {
        expectedPrivacyGeneration: null,
      });
      expect(
        await repository.claimIngestClassification(agentId, stage.id, 'classify-token', null),
      ).toBe(true);
      await repository.prepareIngestClassification(
        agentId,
        stage.id,
        'classify-token',
        { automated },
        null,
      );
      expect(await repository.claimIngestScore(agentId, stage.id, 'score-token', null)).toBe(true);
      await repository.prepareIngestScore(
        agentId,
        stage.id,
        'score-token',
        {
          category: 'travel',
          importance: 4,
          actionable: true,
          reason: 'Stored score',
          dates: [],
          cardCandidate: false,
          nextStep: null,
        },
        null,
      );
      return { repository, stage, base };
    }

    it('atomically freezes source identity and registry, ignoring caller trust and verdict overrides on replay', async () => {
      const { repository, stage, base } = await prepareDirect('observer-message', false);
      const first = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'assistant',
            origin: 'owner',
            parts: [{ type: 'text', text: 'Mail body' }],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.email-card', version: 1, workClass: 'paid_ambiguous' }],
        expectedPrivacyGeneration: null,
      });
      const storedMessage = await db
        .select()
        .from(messages)
        .where(eq(messages.id, first.messageId!))
        .limit(1);
      expect(storedMessage[0]).toMatchObject({
        role: 'user',
        origin: 'unknown',
        text: 'Mail body',
      });
      const replay = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: randomUUID(),
            channelMessageId: base.channelMessageId,
            role: 'assistant',
            origin: 'owner',
            parts: [{ type: 'text', text: 'changed payload' }],
            text: 'changed payload',
          },
        },
        finalizedIngest: {
          ...base,
          authenticated: false,
          contentTrust: 'owner',
          hasExternalOrUnknown: true,
          preparedClassification: { automated: true },
          category: 'spam',
          importance: 5,
        },
        observers: [{ key: 'google.email-card', version: 2, workClass: 'external_provider' }],
        expectedPrivacyGeneration: null,
      });
      expect(replay).toMatchObject({
        messageId: first.messageId,
        sourceId: first.messageId,
        duplicate: true,
      });
      expect(replay.observerIds).toHaveLength(1);
      expect(replay.observerIds[0]).toBe(first.observerIds[0]);
      const [storedIngest] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, stage.id))
        .limit(1);
      expect(storedIngest).toMatchObject({
        contentTrust: 'unknown',
        authenticated: true,
        hasExternalOrUnknown: false,
        category: 'travel',
        importance: 4,
        admittedSourceKind: 'message',
        admittedSourceId: first.messageId,
      });
      expect(storedIngest?.observerRegistrySnapshot).toEqual([
        { key: 'google.email-card', version: 1, workClass: 'paid_ambiguous' },
      ]);
    });

    it('freezes an empty registry on automated mail and rejects two canonical body stores', async () => {
      const { repository, stage, base } = await prepareDirect('automated-observer', true);
      const first = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: { kind: 'automated_source', body: 'Automated mail' },
        finalizedIngest: base,
        observers: [],
        expectedPrivacyGeneration: null,
      });
      const replay = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: { kind: 'automated_source', body: 'caller changed body' },
        finalizedIngest: { ...base, subject: 'changed caller subject' },
        observers: [{ key: 'google.email-card', version: 3, workClass: 'paid_ambiguous' }],
        expectedPrivacyGeneration: null,
      });
      expect(replay).toMatchObject({
        sourceId: first.sourceId,
        messageId: null,
        duplicate: true,
        observerIds: [],
      });
      const [ingest] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, stage.id))
        .limit(1);
      expect(ingest).toMatchObject({
        admittedSourceKind: 'automated_source',
        admittedSourceId: first.sourceId,
        observerRegistrySnapshot: [],
      });

      const conflict = await prepareDirect('dual-canonical', false);
      await db.insert(emailObserverSources).values({
        id: randomUUID(),
        agentId,
        sourceKey: conflict.base.channelMessageId,
        channelMessageId: conflict.base.channelMessageId,
        body: 'other copy',
        privacyGeneration: null,
      });
      await expect(
        conflict.repository.commitEmailAdmission({
          agentId,
          ingestId: conflict.stage.id,
          scoreClaimToken: 'score-token',
          source: {
            kind: 'message',
            message: {
              conversationId: conflict.base.conversationId,
              channelMessageId: conflict.base.channelMessageId,
              role: 'user',
              origin: 'unknown',
              parts: [{ type: 'text', text: 'Mail body' }],
              text: 'Mail body',
            },
          },
          finalizedIngest: conflict.base,
          observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
          expectedPrivacyGeneration: null,
        }),
      ).rejects.toThrow(
        /automated canonical store|both canonical body stores|already bound to another owner/,
      );
    });

    it('rejects another owner canonical source before creating a visible message or observer jobs', async () => {
      const { repository, stage, base } = await prepareDirect(
        'cross-owner-canonical-collision',
        false,
      );
      const foreignAgentId = randomUUID();
      await db.insert(agents).values({
        id: foreignAgentId,
        name: 'foreign-email-owner',
        email: `${foreignAgentId}@gmail-lease.invalid`,
        workspacePrefix: `gmail-lease/${foreignAgentId}`,
      });
      await db.insert(emailObserverSources).values({
        id: randomUUID(),
        agentId: foreignAgentId,
        sourceKey: base.channelMessageId,
        channelMessageId: base.channelMessageId,
        body: 'foreign canonical body',
        privacyGeneration: null,
      });
      try {
        await expect(
          repository.commitEmailAdmission({
            agentId,
            ingestId: stage.id,
            scoreClaimToken: 'score-token',
            source: {
              kind: 'message',
              message: {
                conversationId: base.conversationId,
                channelMessageId: base.channelMessageId,
                role: 'user',
                origin: 'unknown',
                parts: [{ type: 'text', text: 'visible body' }],
                text: 'visible body',
              },
            },
            finalizedIngest: base,
            observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
            expectedPrivacyGeneration: null,
          }),
        ).rejects.toThrow('Email automated source identity is already bound to another owner');
        expect(
          await db
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.channelMessageId, base.channelMessageId)),
        ).toEqual([]);
        expect(
          await db
            .select({ id: emailObserverWork.id })
            .from(emailObserverWork)
            .where(
              and(
                eq(emailObserverWork.agentId, agentId),
                eq(emailObserverWork.channelMessageId, base.channelMessageId),
              ),
            ),
        ).toEqual([]);
      } finally {
        await db
          .delete(emailObserverSources)
          .where(eq(emailObserverSources.agentId, foreignAgentId));
        await db.delete(agents).where(eq(agents.id, foreignAgentId));
      }
    });

    it('freezes deterministic no-model claims separately and releases only definite no-call budget blocks', async () => {
      const repository = createPostgresEmailSyncRepository(db, agentId);
      const [conversation] = await db
        .insert(conversations)
        .values({
          agentId,
          channel: 'email',
          trust: 'unknown',
          title: 'Score outcome test',
        })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('conversation insert failed');
      const base = {
        agentId,
        mailbox,
        providerMessageId: 'score-outcome-control',
        channelMessageId: 'gmail:score-outcome-control',
        conversationId: conversation.id,
        fromEmail: 'sender@example.test',
        fromName: null,
        subject: 'Outcome control',
        contentTrust: 'unknown',
        authenticated: true,
        ingestMode: 'direct' as const,
        hasExternalOrUnknown: false,
        category: 'other' as const,
        importance: 1,
        actionable: false,
        reason: '',
        dates: [],
      };
      const stage = await repository.beginDirectEmailIngest(base, {
        expectedPrivacyGeneration: null,
      });
      expect(
        await repository.claimIngestClassification(
          agentId,
          stage.id,
          'score-classifier-token',
          null,
        ),
      ).toBe(true);
      await repository.prepareIngestClassification(
        agentId,
        stage.id,
        'score-classifier-token',
        { automated: false },
        null,
      );
      expect(
        await repository.claimIngestScore(
          agentId,
          stage.id,
          'deterministic-score-token',
          null,
          undefined,
          'deterministic_no_model',
        ),
      ).toBe(true);
      const score = {
        category: 'bulk' as const,
        importance: 1,
        actionable: false,
        reason: 'Header-only rule',
        dates: [],
        cardCandidate: false,
        nextStep: null,
      };
      await expect(
        repository.prepareIngestScore(agentId, stage.id, 'deterministic-score-token', score, null),
      ).rejects.toThrow('email scoring claim is no longer current');
      await repository.prepareIngestScoreDeterministic(
        agentId,
        stage.id,
        'deterministic-score-token',
        score,
        null,
      );
      const [prepared] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, stage.id))
        .limit(1);
      expect(prepared).toMatchObject({
        scoreStatus: 'prepared',
        scoreOutcome: 'deterministic_no_model',
        pipelineStage: 'score_prepared',
      });

      const secondBase = {
        ...base,
        providerMessageId: 'score-budget-blocked',
        channelMessageId: 'gmail:score-budget-blocked',
      };
      const second = await repository.beginDirectEmailIngest(secondBase, {
        expectedPrivacyGeneration: null,
      });
      expect(
        await repository.claimIngestClassification(
          agentId,
          second.id,
          'budget-classifier-token',
          null,
        ),
      ).toBe(true);
      await repository.prepareIngestClassification(
        agentId,
        second.id,
        'budget-classifier-token',
        { automated: false },
        null,
      );
      expect(
        await repository.claimIngestScore(agentId, second.id, 'budget-blocked-score-token', null),
      ).toBe(true);
      await repository.markIngestScoreBudgetBlocked(
        agentId,
        second.id,
        'budget-blocked-score-token',
        null,
      );
      const [released] = await db
        .select()
        .from(emailIngest)
        .where(eq(emailIngest.id, second.id))
        .limit(1);
      expect(released).toMatchObject({
        scoreStatus: 'pending',
        scoreOutcome: 'budget_blocked',
        pipelineStage: 'pending_score',
        scoreClaimToken: null,
      });
      expect(await repository.claimIngestScore(agentId, second.id, 'retry-score-token', null)).toBe(
        true,
      );
    });

    it('keeps forwarded origin unverified even when the outer receiver is authenticated', async () => {
      const repository = createPostgresEmailSyncRepository(db, agentId);
      const messageId = 'forwarded-authenticated-receiver';
      const channelMessageId = `gmail:${messageId}`;
      const [conversation] = await db
        .insert(conversations)
        .values({
          agentId,
          channel: 'email',
          title: 'Forwarded verification test',
        })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('conversation insert failed');
      const source = {
        agentId,
        mailbox,
        providerMessageId: messageId,
        channelMessageId,
        conversationId: conversation.id,
        fromEmail: 'external@example.test',
        fromName: null,
        subject: 'Forwarded message',
        contentTrust: 'unknown' as const,
        authenticated: true,
        category: 'other' as const,
        importance: 1,
        actionable: false,
        reason: '',
        dates: [],
      };
      const ingest = await repository.beginForwardedIngest(source, {
        expectedPrivacyGeneration: null,
      });
      expect(
        await repository.claimIngestScore(agentId, ingest.id, 'forwarded-score-token', null),
      ).toBe(true);
      await repository.prepareIngestScore(
        agentId,
        ingest.id,
        'forwarded-score-token',
        {
          category: 'other',
          importance: 1,
          actionable: false,
          reason: 'Prepared',
          dates: [],
          cardCandidate: false,
          nextStep: null,
        },
        null,
      );
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: ingest.id,
        scoreClaimToken: 'forwarded-score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: conversation.id,
            channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'Forwarded body' }],
            text: 'Forwarded body',
          },
        },
        finalizedIngest: source,
        observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
        expectedPrivacyGeneration: null,
      });
      const claim = await repository.claimEmailObserver({
        id: admitted.observerIds[0]!,
        agentId,
        token: 'forwarded-source-claim',
        now: new Date(),
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
      });
      expect(claim.kind).toBe('claimed');
      if (claim.kind !== 'claimed') throw new Error('forwarded observer was not claimed');
      expect(await repository.loadEmailObserverSource(claim.claim)).toMatchObject({
        authenticated: true,
        ingestMode: 'forwarded',
        sourceVerification: 'forwarded_unverified',
      });
    });

    it('rejects a stale work privacy generation before claim or budget mutation', async () => {
      const { repository, stage, base } = await prepareDirect(
        'stale-work-privacy-generation',
        false,
      );
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'Mail body' }],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.owner-voice-sample', version: 9, workClass: 'paid_ambiguous' }],
        expectedPrivacyGeneration: null,
      });
      const id = admitted.observerIds[0]!;
      await db
        .update(emailObserverWork)
        .set({ privacyGeneration: 'stale-generation' })
        .where(eq(emailObserverWork.id, id));
      const before = await db
        .select()
        .from(emailObserverWork)
        .where(eq(emailObserverWork.id, id))
        .limit(1);
      const result = await repository.claimEmailObserver({
        id,
        agentId,
        token: 'stale-work-claim',
        now: new Date(),
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
        paidBudget: {
          budgetKey: 'google.owner-voice-sample',
          observerKey: 'google.owner-voice-sample',
          limit: 1,
          windowStart: new Date(
            Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth(),
              new Date().getUTCDate(),
            ),
          ),
          windowEnd: new Date(
            Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth(),
              new Date().getUTCDate(),
            ) + 86_400_000,
          ),
        },
      });
      expect(result).toEqual({ kind: 'none' });
      expect(
        await db.select().from(emailObserverWork).where(eq(emailObserverWork.id, id)).limit(1),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(emailObserverBudgets)
          .where(eq(emailObserverBudgets.agentId, agentId)),
      ).toEqual([]);
    });

    it('holds prepared paid work behind its active lease and does not spend budget on resume', async () => {
      const { repository, stage, base } = await prepareDirect('paid-observer', false);
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'Mail body' }],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.owner-voice-sample', version: 1, workClass: 'paid_ambiguous' }],
        expectedPrivacyGeneration: null,
      });
      const now = new Date();
      const windowStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const budget = {
        budgetKey: 'google.owner-voice-sample',
        observerKey: 'google.owner-voice-sample',
        limit: 1,
        windowStart,
        windowEnd: new Date(windowStart.getTime() + 86_400_000),
      };
      const first = await repository.claimEmailObserver({
        id: admitted.observerIds[0]!,
        agentId,
        token: 'claim-one',
        now,
        leaseMs: 600_000,
        expectedPrivacyGeneration: null,
        paidBudget: budget,
      });
      expect(first.kind).toBe('claimed');
      if (first.kind !== 'claimed') throw new Error('claim missing');
      expect(
        await repository.prepareEmailObserver({
          id: first.claim.id,
          agentId,
          claimToken: first.claim.claimToken,
          claimGeneration: first.claim.claimGeneration,
          expectedPrivacyGeneration: null,
          now: new Date(),
          result: {
            register: 'email_casual',
            context: 'inbound-email',
            observedGeneration: 'gen-1',
            embeddingSpaceKey: 'space:key',
            embedding: [0.1, -0.1],
          },
        }),
      ).toBe(true);
      expect(
        await repository.claimEmailObserver({
          id: first.claim.id,
          agentId,
          token: 'steal-active-lease',
          now: new Date(Date.now() + 2_000),
          leaseMs: 60_000,
          expectedPrivacyGeneration: null,
          paidBudget: budget,
        }),
      ).toEqual({ kind: 'none' });
      await db
        .update(emailObserverWork)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(emailObserverWork.id, first.claim.id));
      const resumed = await repository.claimEmailObserver({
        id: first.claim.id,
        agentId,
        token: 'claim-two',
        now: new Date(Date.now() + 3_000),
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
        paidBudget: budget,
      });
      expect(resumed.kind).toBe('claimed');
      if (resumed.kind !== 'claimed') throw new Error('prepared work not resumed');
      expect(resumed.claim.status).toBe('prepared');
      expect(resumed.claim.attemptCount).toBe(1);
      const [bucket] = await db
        .select()
        .from(emailObserverBudgets)
        .where(eq(emailObserverBudgets.agentId, agentId))
        .limit(1);
      expect(bucket?.reservedCount).toBe(1);
    });

    it('rejects a completion whose lease expires while waiting for the work-row lock', async () => {
      const { repository, stage, base } = await prepareDirect(
        'lease-expires-under-row-lock',
        false,
      );
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'Mail body' }],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
        expectedPrivacyGeneration: null,
      });
      const claimed = await repository.claimEmailObserver({
        id: admitted.observerIds[0]!,
        agentId,
        token: 'completion-expiry-test',
        now: new Date(),
        leaseMs: 100,
        expectedPrivacyGeneration: null,
      });
      expect(claimed.kind).toBe('claimed');
      if (claimed.kind !== 'claimed') throw new Error('observer claim missing');

      let signalLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = db.transaction(async (tx) => {
        await tx
          .select({ id: emailObserverWork.id })
          .from(emailObserverWork)
          .where(
            and(eq(emailObserverWork.id, claimed.claim.id), eq(emailObserverWork.agentId, agentId)),
          )
          .for('update');
        signalLocked();
        await release;
      });
      await locked;
      try {
        const completion = repository.completeEmailObserver({
          id: claimed.claim.id,
          agentId,
          claimToken: claimed.claim.claimToken,
          claimGeneration: claimed.claim.claimGeneration,
          expectedPrivacyGeneration: null,
          now: new Date(),
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        releaseLock();
        await blocker;
        expect(await completion).toBe(false);
        expect(
          await db
            .select({ status: emailObserverWork.status, claimToken: emailObserverWork.claimToken })
            .from(emailObserverWork)
            .where(eq(emailObserverWork.id, claimed.claim.id)),
        ).toEqual([{ status: 'claimed', claimToken: claimed.claim.claimToken }]);
      } finally {
        releaseLock();
        await blocker;
      }
    });

    it('refunds a known no-provider budget block and reserves against the new UTC day on retry', async () => {
      const { repository, stage, base } = await prepareDirect('budget-blocked-day-boundary', false);
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.owner-voice-sample', version: 6, workClass: 'paid_ambiguous' }],
        expectedPrivacyGeneration: null,
      });
      const dayOneStart = new Date('2026-10-06T00:00:00.000Z');
      const dayOneEnd = new Date('2026-10-07T00:00:00.000Z');
      const dayOneBudget = {
        budgetKey: 'google.owner-voice-sample',
        observerKey: 'google.owner-voice-sample',
        limit: 1,
        windowStart: dayOneStart,
        windowEnd: dayOneEnd,
      };
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
        const first = await repository.claimEmailObserver({
          id: admitted.observerIds[0]!,
          agentId,
          token: 'budget-blocked-day-one',
          now: new Date(),
          leaseMs: 60_000,
          expectedPrivacyGeneration: null,
          paidBudget: dayOneBudget,
        });
        expect(first.kind).toBe('claimed');
        if (first.kind !== 'claimed') throw new Error('day one reservation missing');
        expect(first.claim.budgetReserved).toBe(true);
        expect(
          await repository.failEmailObserver({
            id: first.claim.id,
            agentId,
            claimToken: first.claim.claimToken,
            claimGeneration: first.claim.claimGeneration,
            expectedPrivacyGeneration: null,
            now: new Date(),
            outcome: 'budget_blocked',
            errorCode: 'email_observer_budget_blocked',
          }),
        ).toBe(true);
        const [dayOneBucket] = await db
          .select()
          .from(emailObserverBudgets)
          .where(eq(emailObserverBudgets.agentId, agentId))
          .limit(1);
        expect(dayOneBucket).toMatchObject({ reservedCount: 0 });
        expect(
          await db
            .select()
            .from(emailObserverWork)
            .where(eq(emailObserverWork.id, first.claim.id))
            .limit(1),
        ).toMatchObject([
          { status: 'retryable_failed', budgetReserved: false, budgetWindowStart: null },
        ]);

        const dayTwoStart = new Date('2026-10-07T00:00:00.000Z');
        vi.setSystemTime(new Date('2026-10-07T00:01:00.000Z'));
        const retry = await repository.claimEmailObserver({
          id: first.claim.id,
          agentId,
          token: 'budget-blocked-day-two',
          now: new Date(),
          leaseMs: 60_000,
          expectedPrivacyGeneration: null,
          paidBudget: {
            budgetKey: 'google.owner-voice-sample',
            observerKey: 'google.owner-voice-sample',
            limit: 1,
            windowStart: dayTwoStart,
            windowEnd: new Date('2026-10-08T00:00:00.000Z'),
          },
        });
        expect(retry.kind).toBe('claimed');
        if (retry.kind !== 'claimed') throw new Error('day two reservation was not created');
        expect(retry.claim).toMatchObject({
          budgetReserved: true,
          budgetKey: 'google.owner-voice-sample',
          attemptCount: 2,
        });
        expect(retry.claim.budgetWindowStart).toEqual(dayTwoStart);
        const buckets = await db
          .select()
          .from(emailObserverBudgets)
          .where(eq(emailObserverBudgets.agentId, agentId));
        expect(buckets).toHaveLength(2);
        expect(
          buckets.find((bucket) => bucket.utcWindowStart.getTime() === dayOneStart.getTime())
            ?.reservedCount,
        ).toBe(0);
        expect(
          buckets.find((bucket) => bucket.utcWindowStart.getTime() === dayTwoStart.getTime())
            ?.reservedCount,
        ).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('replays the frozen prepared result after retryable apply failure without recomposition or a second charge', async () => {
      const { repository, stage, base } = await prepareDirect('observer-retry-prepared', false);
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'Mail body' }],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.owner-voice-sample', version: 2, workClass: 'paid_ambiguous' }],
        expectedPrivacyGeneration: null,
      });
      const now = new Date();
      const windowStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const budget = {
        budgetKey: 'google.owner-voice-sample',
        observerKey: 'google.owner-voice-sample',
        limit: 1,
        windowStart,
        windowEnd: new Date(windowStart.getTime() + 86_400_000),
      };
      const result = {
        register: 'email_casual',
        context: 'inbound-email',
        observedGeneration: 'gen-2',
        embeddingSpaceKey: 'space:key',
        embedding: [0.2, -0.2],
      };
      const first = await repository.claimEmailObserver({
        id: admitted.observerIds[0]!,
        agentId,
        token: 'retry-prepared-claim-1',
        now,
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
        paidBudget: budget,
      });
      expect(first.kind).toBe('claimed');
      if (first.kind !== 'claimed') throw new Error('claim missing');
      expect(
        await repository.prepareEmailObserver({
          id: first.claim.id,
          agentId,
          claimToken: first.claim.claimToken,
          claimGeneration: first.claim.claimGeneration,
          expectedPrivacyGeneration: null,
          now: new Date(),
          result,
        }),
      ).toBe(true);
      expect(
        await repository.failEmailObserver({
          id: first.claim.id,
          agentId,
          claimToken: first.claim.claimToken,
          claimGeneration: first.claim.claimGeneration,
          expectedPrivacyGeneration: null,
          now: new Date(),
          outcome: 'retryable_failed',
          errorCode: 'email_card_effect_unknown',
        }),
      ).toBe(true);
      const resumed = await repository.claimEmailObserver({
        id: first.claim.id,
        agentId,
        token: 'retry-prepared-claim-2',
        now: new Date(),
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
        paidBudget: budget,
      });
      expect(resumed.kind).toBe('claimed');
      if (resumed.kind !== 'claimed') throw new Error('prepared retry missing');
      expect(resumed.claim.status).toBe('prepared');
      expect(resumed.claim.preparedResult).toEqual(result);
      expect(resumed.claim.attemptCount).toBe(1);
      expect(
        await repository.prepareEmailObserver({
          id: resumed.claim.id,
          agentId,
          claimToken: resumed.claim.claimToken,
          claimGeneration: resumed.claim.claimGeneration,
          expectedPrivacyGeneration: null,
          now: new Date(),
          result: { ...result, observedGeneration: 'different' },
        }),
      ).toBe(false);
      const [bucket] = await db
        .select()
        .from(emailObserverBudgets)
        .where(eq(emailObserverBudgets.agentId, agentId))
        .limit(1);
      expect(bucket?.reservedCount).toBe(1);
    });

    it('commits a generated-card write only under its live prepared observer claim', async () => {
      const { repository, stage, base } = await prepareDirect('observer-card-fence', false);
      const admitted = await repository.commitEmailAdmission({
        agentId,
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: base.conversationId,
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'Mail body' }],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
        expectedPrivacyGeneration: null,
      });
      const claim = await repository.claimEmailObserver({
        id: admitted.observerIds[0]!,
        agentId,
        token: 'card-effect-token',
        now: new Date(),
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
      });
      expect(claim.kind).toBe('claimed');
      if (claim.kind !== 'claimed') throw new Error('card observer claim missing');
      const id = randomUUID();
      const revisionId = randomUUID();
      const sourceFingerprint = randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);
      const prepared = {
        kind: 'generated-card',
        id,
        revisionId,
        sourceFingerprint,
        grounding: 'evidence',
        spec: { title: 'Prepared from email', sourceLabel: 'Email', actions: [] },
      };
      expect(
        await repository.prepareEmailObserver({
          id: claim.claim.id,
          agentId,
          claimToken: claim.claim.claimToken,
          claimGeneration: claim.claim.claimGeneration,
          expectedPrivacyGeneration: null,
          now: new Date(),
          result: prepared,
        }),
      ).toBe(true);
      const cards = createPostgresGeneratedCardRepository(db);
      const baseCard = {
        agentId,
        id,
        revisionId,
        sourceFingerprint,
        sourceLabel: 'Email',
        spec: { ...prepared.spec, refreshable: false },
        expiresAt: new Date(Date.now() + 60_000),
        emailObserverEffectFence: {
          id: claim.claim.id,
          agentId,
          claimToken: claim.claim.claimToken,
          claimGeneration: claim.claim.claimGeneration,
          expectedPrivacyGeneration: null,
        },
      };
      await expect(
        cards.createOrRevise({
          ...baseCard,
          emailObserverEffectFence: {
            ...baseCard.emailObserverEffectFence,
            claimToken: 'stale-claim-token',
          },
        }),
      ).rejects.toThrow('Email observer card effect claim is no longer current');
      expect(
        await db.select().from(generatedCards).where(eq(generatedCards.agentId, agentId)),
      ).toHaveLength(0);
      const saved = await cards.createOrRevise(baseCard);
      expect(saved.card.id).toBe(id);
      expect(
        await db.select().from(generatedCards).where(eq(generatedCards.agentId, agentId)),
      ).toHaveLength(1);
    });
  });
});
