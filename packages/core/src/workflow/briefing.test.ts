import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  createPostgresEmailSyncRepository,
  type Db,
  emailBookingOccurrences,
  emailIngest,
  goals,
  maintenanceCursors,
  messages,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
  suggestions,
  tasks,
  watches,
  watchFires,
} from '@assistant/db';
import {
  emailBookingKey,
  notificationLeg,
  resolveBookingLocalDateTime,
} from '@assistant/persistence';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  getAgent,
  ownerNoticeObservationFence,
  postOwnerNoticeWithDecisionFence,
} from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import {
  briefingBody,
  briefingHasNews,
  briefingHeadline,
  briefingTaskSummary,
  findConflicts,
  runBriefing,
} from './briefing.js';
import { dismissSuggestion } from './suggestions.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-briefing-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const ingestIds: string[] = [];
const incidentIds: string[] = [];
const createdSuggestionIds: string[] = [];
let flightSuggestionId = '';

/** Records what the composer was given, and echoes a fixed digest back. */
function recordingRouter(text = `${MARKER} composed digest`) {
  const prompts: string[] = [];
  const router = {
    async object(_role: string, opts: { prompt?: string }) {
      prompts.push(opts.prompt ?? '');
      return {
        ok: true,
        modelId: 'fake',
        degraded: false,
        object: { lead: text },
      };
    },
  } as unknown as ModelRouter;
  return { router, prompts };
}

async function addMail(input: {
  id: string;
  importance: number;
  category: string;
  subject: string;
  createdAt?: Date;
  dates?: Array<{ iso: string; what: string; [key: string]: unknown }>;
}) {
  const [row] = await db
    .insert(emailIngest)
    .values({
      agentId,
      conversationId,
      channelMessageId: `gmail:${MARKER}-${input.id}`,
      fromEmail: 'bookings@airline.example',
      subject: input.subject,
      contentTrust: 'unknown',
      authenticated: true,
      category: input.category,
      importance: input.importance,
      actionable: true,
      reason: 'test reason',
      dates: input.dates ?? [],
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: emailIngest.id });
  if (row) ingestIds.push(row.id);
  return row?.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('briefing.test: database unreachable — skipping');
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
    .returning();
  conversationId = (conv as NonNullable<typeof conv>).id;
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(suggestions).where(like(suggestions.sourceRef, `%${MARKER}%`));
    if (createdSuggestionIds.length) {
      await db.delete(suggestions).where(inArray(suggestions.id, createdSuggestionIds));
    }
    await db.delete(emailBookingOccurrences).where(eq(emailBookingOccurrences.agentId, agentId));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    if (incidentIds.length) {
      await db
        .delete(securityIncidentSources)
        .where(inArray(securityIncidentSources.incidentId, incidentIds));
      await db
        .delete(securityIncidentAttention)
        .where(inArray(securityIncidentAttention.incidentId, incidentIds));
      await db.delete(securityIncidents).where(inArray(securityIncidents.id, incidentIds));
    }
    if (ingestIds.length) await db.delete(emailIngest).where(inArray(emailIngest.id, ingestIds));
    await db.delete(messages).where(like(messages.text, `%${MARKER}%`));
    if (conversationId) {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('runBriefing', () => {
  it('does not deliver a briefing for a routine importance-3 receipt alone', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date('2030-01-01T12:00:00.000Z');
    await addMail({
      id: 'routine-only',
      importance: 3,
      category: 'transactional',
      subject: `${MARKER} receipt for a completed purchase`,
      createdAt: now,
    });
    const { router, prompts } = recordingRouter();
    const result = await runBriefing(
      { db, router, calendarReader: async () => ({ events: [], complete: true }) },
      { now },
    );
    expect(result.highlights).toBe(0);
    expect(result.delivered).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('claims source-backed security evidence once even when the notice scores routine importance 3', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date('2030-02-01T12:00:00.000Z');
    const channelMessageId = `gmail:${MARKER}-security-incident`;
    const quote = `Security alert ${MARKER}-A77: A new sign-in to owner@example.test from Pixel 9 in Berlin.`;
    const [ingest] = await db
      .insert(emailIngest)
      .values({
        agentId,
        conversationId,
        channelMessageId,
        fromEmail: 'security@example.test',
        fromName: 'Account Security',
        subject: `${MARKER} New sign-in`,
        contentTrust: 'known',
        authenticated: true,
        category: 'security',
        importance: 3,
        actionable: false,
        reason: 'routine security notice',
        dates: [],
        createdAt: now,
        securityEvidence: {
          providerIncidentRef: `${MARKER}-A77`,
          eventType: 'sign_in',
          affectedAccount: 'owner@example.test',
          device: 'Pixel 9',
          location: 'Berlin',
          evidenceQuote: quote,
        },
      })
      .returning({ id: emailIngest.id });
    if (!ingest) throw new Error('security ingest fixture was not created');
    ingestIds.push(ingest.id);
    const emailSync = createPostgresEmailSyncRepository(db, agentId);
    const observed = await emailSync.observeSecurityIncident({
      agentId,
      channelMessageId,
      sourceMessageId: `<${MARKER}-security@provider.example>`,
      mailbox: 'owner@example.test',
      authenticated: true,
      evidence: {
        providerIncidentRef: `${MARKER}-A77`,
        eventType: 'sign_in',
        affectedAccount: 'owner@example.test',
        device: 'Pixel 9',
        location: 'Berlin',
        evidenceQuote: quote,
      },
      sourceText: quote,
      observedAt: now,
    });
    const { router } = recordingRouter(`${MARKER} security digest`);
    const first = await runBriefing(
      { db, router, calendarReader: async () => ({ events: [], complete: true }) },
      { now },
    );
    expect(first.securityIncidents).toBe(1);
    const [attention] = await db
      .select()
      .from(securityIncidentAttention)
      .where(eq(securityIncidentAttention.incidentId, observed.incident.id));
    expect(attention?.deliveryStatus).toBe('accepted');
    const replay = await runBriefing(
      { db, router, calendarReader: async () => ({ events: [], complete: true }) },
      { now },
    );
    expect(replay.securityIncidents).toBe(0);
    expect(replay.delivered).toBe(false);
  });

  it('handles a mixed day without receipt noise, duplicate incident alerts, or automatic calendar changes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const incidentOriginalChannel = `gmail:${MARKER}-incident-original`;
    const incidentRecoveryChannel = `gmail:${MARKER}-incident-recovery`;
    const originalSourceId = `<${MARKER}-original@provider.example>`;
    const recoverySourceId = `<${MARKER}-recovery@provider.example>`;
    const eventAt = now.toISOString();
    const eventFacts = {
      eventType: 'sign_in',
      affectedAccount: 'owner@example.test',
      eventAt,
      device: 'Pixel 9',
      location: 'Oslo',
    };
    const originalQuote = `Security alert: A sign-in to owner@example.test at ${eventAt} from Pixel 9 in Oslo.`;
    const recoveryQuote = `Recovery copy of ${originalSourceId}: A sign-in to owner@example.test at ${eventAt} from Pixel 9 in Oslo.`;
    const emailSync = createPostgresEmailSyncRepository(db, agentId);

    const originalIngest = await db
      .insert(emailIngest)
      .values({
        agentId,
        conversationId,
        channelMessageId: incidentOriginalChannel,
        fromEmail: 'security@example.test',
        fromName: 'Account Security',
        subject: `${MARKER} sign-in alert`,
        contentTrust: 'known',
        authenticated: true,
        category: 'security',
        importance: 3,
        actionable: false,
        reason: 'routine security score',
        dates: [],
        createdAt: now,
        securityEvidence: {
          ...eventFacts,
          evidenceQuote: originalQuote,
        },
      })
      .returning({ id: emailIngest.id });
    const recoveryIngest = await db
      .insert(emailIngest)
      .values({
        agentId,
        conversationId,
        channelMessageId: incidentRecoveryChannel,
        fromEmail: 'security@example.test',
        fromName: 'Account Security',
        subject: `${MARKER} sign-in alert recovery copy`,
        contentTrust: 'known',
        authenticated: true,
        category: 'security',
        importance: 3,
        actionable: false,
        reason: 'routine security score',
        dates: [],
        createdAt: now,
        securityEvidence: {
          ...eventFacts,
          recoveryCopyOf: originalSourceId,
          evidenceQuote: recoveryQuote,
        },
      })
      .returning({ id: emailIngest.id });
    if (!originalIngest[0] || !recoveryIngest[0])
      throw new Error('incident source fixtures missing');
    ingestIds.push(originalIngest[0].id, recoveryIngest[0].id);
    const original = await emailSync.observeSecurityIncident({
      agentId,
      channelMessageId: incidentOriginalChannel,
      sourceMessageId: originalSourceId,
      mailbox: 'owner@example.test',
      authenticated: true,
      evidence: { ...eventFacts, evidenceQuote: originalQuote },
      sourceText: originalQuote,
      observedAt: now,
    });
    incidentIds.push(original.incident.id);
    const recovery = await emailSync.observeSecurityIncident({
      agentId,
      channelMessageId: incidentRecoveryChannel,
      sourceMessageId: recoverySourceId,
      mailbox: 'owner@example.test',
      authenticated: true,
      evidence: {
        ...eventFacts,
        recoveryCopyOf: originalSourceId,
        evidenceQuote: recoveryQuote,
      },
      sourceText: recoveryQuote,
      observedAt: new Date(now.getTime() + 1000),
    });
    expect(recovery.incident.id).toBe(original.incident.id);
    expect(recovery.duplicateEvidence).toBe(true);

    const receiptId = await addMail({
      id: 'mixed-routine-receipt',
      importance: 3,
      category: 'transactional',
      subject: `${MARKER} receipt for a completed purchase`,
      createdAt: now,
    });
    const [practice] = await db
      .insert(emailIngest)
      .values({
        agentId,
        conversationId,
        channelMessageId: `gmail:${MARKER}-evening-practice`,
        fromEmail: 'studio@example.test',
        subject: `${MARKER} evening practice`,
        contentTrust: 'unknown',
        authenticated: true,
        category: 'personal',
        importance: 3,
        actionable: false,
        reason: 'scheduled practice',
        dates: [],
        createdAt: now,
      })
      .returning({ id: emailIngest.id });
    if (!practice) throw new Error('practice fixture missing');
    ingestIds.push(practice.id);

    const dueDate = new Date(now.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    const deadlineId = await addMail({
      id: 'mixed-deadline',
      importance: 5,
      category: 'financial',
      subject: `${MARKER} invoice payment deadline`,
      createdAt: now,
      dates: [
        { iso: dueDate, what: `${MARKER} invoice`, dateRole: 'payment_due', precision: 'date' },
      ],
    });

    const bookedDate = new Date(now.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
    const cancelledDate = new Date(now.getTime() + 8 * 86_400_000).toISOString().slice(0, 10);
    const confirmedIdentity = `${MARKER}-confirmed-booking`;
    const cancelledIdentity = `${MARKER}-cancelled-booking`;
    const confirmedKey = emailBookingKey(agentId, confirmedIdentity);
    const cancelledKey = emailBookingKey(agentId, cancelledIdentity);
    await db.insert(emailBookingOccurrences).values([
      {
        agentId,
        bookingKey: confirmedKey,
        lifecycle: 'confirmed',
        dates: [
          {
            iso: bookedDate,
            what: `${MARKER} existing appointment`,
            dateRole: 'event_start',
            precision: 'date',
            civilDate: bookedDate,
            lifecycle: 'confirmed',
            bookingIdentity: confirmedIdentity,
          },
        ],
        sourceChannelMessageId: `gmail:${MARKER}-confirmed-source`,
        sourceReceivedAt: now,
        sourceAuthenticated: true,
        version: 2,
      },
      {
        agentId,
        bookingKey: cancelledKey,
        lifecycle: 'cancelled',
        dates: [
          {
            iso: cancelledDate,
            what: `${MARKER} other appointment`,
            dateRole: 'event_start',
            precision: 'date',
            civilDate: cancelledDate,
            lifecycle: 'cancelled',
            bookingIdentity: cancelledIdentity,
          },
        ],
        sourceChannelMessageId: `gmail:${MARKER}-cancelled-source`,
        sourceReceivedAt: now,
        sourceAuthenticated: true,
        version: 4,
      },
    ]);

    const events = [
      {
        summary: `${MARKER} existing appointment`,
        description: `Booking reference ${confirmedIdentity}`,
        start: bookedDate,
        end: bookedDate,
        calendar: 'Primary',
        calendarId: 'primary',
        allDay: true,
        eventId: `${MARKER}-confirmed-event`,
      },
      {
        summary: `${MARKER} other appointment`,
        description: `Booking reference ${cancelledIdentity}`,
        start: cancelledDate,
        end: cancelledDate,
        calendar: 'Primary',
        calendarId: 'primary',
        allDay: true,
        eventId: `${MARKER}-cancel-event`,
      },
    ];
    let calendarReads = 0;
    const { router, prompts } = recordingRouter(`${MARKER} mixed day digest`);
    const first = await runBriefing(
      {
        db,
        router,
        calendarCancellationEnabled: true,
        calendarReader: async () => {
          calendarReads += 1;
          return { events, complete: true };
        },
      },
      { now },
    );
    expect(first.delivered).toBe(true);
    expect(first.securityIncidents).toBe(1);
    expect(first.highlights).toBe(1);
    expect(first.upcoming).toBe(1); // only the actionable deadline; confirmed event is already present
    expect(first.bookingCancellations).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Security notices requiring review:');
    expect(prompts[0]?.match(/Security notices requiring review:/gu)).toHaveLength(1);
    const securitySection = prompts[0]
      ?.split('Security notices requiring review:')[1]
      ?.split('\n\n')[0];
    expect(securitySection?.match(/^- /gmu)).toHaveLength(1);
    expect(prompts[0]).toContain(`${MARKER} existing appointment`);
    expect(prompts[0]).toContain(`${MARKER} invoice`);
    expect(prompts[0]).not.toContain(`${MARKER} receipt for a completed purchase`);
    expect(prompts[0]).not.toContain(`${MARKER} evening practice`);
    expect(calendarReads).toBeGreaterThan(0);
    const sourceRecords = await db
      .select()
      .from(securityIncidentSources)
      .where(eq(securityIncidentSources.incidentId, original.incident.id));
    expect(sourceRecords).toHaveLength(2);
    expect(new Set(sourceRecords.map((row) => row.sourceMessageId)).size).toBe(2);

    const sourceRows = await emailSync.listSecurityAttentionCandidates(agentId, 10);
    expect(sourceRows).toHaveLength(0); // the one current incident revision is already claimed by the briefing
    const [cancelSuggestion] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, cancelledKey));
    expect(cancelSuggestion).toMatchObject({
      status: 'pending',
      bookingVersion: 4,
      bookingCancellation: {
        calendarEventId: `${MARKER}-cancel-event`,
        bookingIdentity: cancelledIdentity,
      },
    });
    if (!cancelSuggestion) throw new Error('cancel proposal was not persisted');
    createdSuggestionIds.push(cancelSuggestion.id);
    const [alreadyBookedProposal] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, confirmedKey));
    expect(alreadyBookedProposal).toBeUndefined();
    expect(events).toHaveLength(2); // a proposal did not delete either calendar event

    const dismissed = await emailSync.decideSecurityIncident({
      agentId,
      incidentId: original.incident.id,
      expectedRevision: original.incident.revision,
      disposition: 'dismissed',
      reason: 'owner reviewed the original and recovery copy',
      now: new Date(now.getTime() + 60_000),
    });
    expect(dismissed).toBe(true);
    const candidatesAfterDismissal = await emailSync.listSecurityAttentionCandidates(agentId, 10);
    expect(candidatesAfterDismissal).toHaveLength(0);

    const replay = await runBriefing(
      {
        db,
        router,
        calendarCancellationEnabled: true,
        calendarReader: async () => ({ events, complete: true }),
      },
      { now: new Date(now.getTime() + 2 * 60_000) },
    );
    expect(replay.securityIncidents).toBe(0);
    expect(replay.delivered).toBe(true); // deadline/highlight content can still merit a refresh
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain('Security notices requiring review:');

    // Isolate this mixed-day fixture from later tests sharing the synthetic owner.
    await db.delete(suggestions).where(like(suggestions.sourceRef, `%${MARKER}-mixed-deadline%`));
    await db.delete(suggestions).where(eq(suggestions.bookingKey, cancelledKey));
    await db
      .delete(emailBookingOccurrences)
      .where(inArray(emailBookingOccurrences.bookingKey, [confirmedKey, cancelledKey]));
    await db
      .delete(securityIncidentSources)
      .where(eq(securityIncidentSources.incidentId, original.incident.id));
    await db
      .delete(securityIncidentAttention)
      .where(eq(securityIncidentAttention.incidentId, original.incident.id));
    await db.delete(securityIncidents).where(eq(securityIncidents.id, original.incident.id));
    await db
      .delete(emailIngest)
      .where(
        inArray(emailIngest.id, [
          originalIngest[0].id,
          recoveryIngest[0].id,
          practice.id,
          receiptId ?? '',
          deadlineId ?? '',
        ]),
      );
    await db.delete(messages).where(like(messages.text, `%${MARKER} mixed day digest%`));
  });

  it('says nothing when there is nothing to say', async () => {
    if (!dbUp)
      throw new Error('A live PostgreSQL test target is required for the quiet-briefing assertion');
    // Use a new owner so unrelated shared-database rows cannot turn this
    // required silence assertion into a skip.
    const quietAgentId = randomUUID();
    await db.insert(agents).values({
      id: quietAgentId,
      name: `Quiet briefing ${quietAgentId.slice(0, 8)}`,
      email: `${quietAgentId}@briefing-test.invalid`,
      workspacePrefix: `briefing-quiet/${quietAgentId}`,
    });
    try {
      const { router, prompts } = recordingRouter(`${MARKER} quiet probe`);
      const result = await runBriefing(
        {
          db,
          router,
          calendarReader: async () => ({ events: [], complete: true }),
        },
        { agentId: quietAgentId },
      );
      expect(result.highlights).toBe(0);
      expect(result.needsAttention).toBe(0);
      expect(result.pendingApprovals).toBe(0);
      expect(result.calendarConflicts).toBe(0);
      expect(result.goalDeltas).toBe(0);
      expect(result.watchHits).toBe(0);
      expect(result.delivered).toBe(false);
      expect(prompts).toHaveLength(0);
    } finally {
      await db.delete(agents).where(eq(agents.id, quietAgentId));
    }
  });

  it('delivers a digest built only from the structured rows', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    await addMail({
      id: 'flight',
      importance: 4,
      category: 'travel',
      subject: `${MARKER} Your itinerary`,
      dates: [{ iso: soon, what: 'flight departs', dateRole: 'event_start' }],
    });
    const bookingKey = emailBookingKey(agentId, `${MARKER}-R-314`);
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: soon,
          what: 'flight departs',
          dateRole: 'event_start',
          lifecycle: 'confirmed',
          bookingIdentity: `${MARKER}-R-314`,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-flight`,
      sourceReceivedAt: new Date(),
      sourceAuthenticated: true,
      version: 1,
    });
    await addMail({
      id: 'bulk',
      importance: 1,
      category: 'bulk',
      subject: `${MARKER} Summer sale`,
    });

    const { router, prompts } = recordingRouter();
    const result = await runBriefing({
      db,
      router,
      calendarReader: async () => ({ events: [], complete: true }),
    });

    expect(result.delivered).toBe(true);
    const prompt = prompts[0] ?? '';
    // Everything the model sees is a row we assembled — it is asked to write
    // notes up, never to decide what matters.
    expect(prompt).toContain(`${MARKER} Your itinerary`);
    expect(prompt).toContain('flight departs');
    // Routine mail is counted but not itemised.
    expect(prompt).not.toContain(`${MARKER} Summer sale`);
    // These notes are not only the model's input: they are delivered verbatim
    // whenever the phrasing step fails, so they must already be owner-ready.
    // Neither the scorer's internals nor a provider timestamp belongs in them.
    expect(prompt).not.toMatch(/importance \d/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    const [suggestion] = await db
      .select({
        id: suggestions.id,
        status: suggestions.status,
        acceptedTaskId: suggestions.acceptedTaskId,
      })
      .from(suggestions)
      .where(eq(suggestions.sourceRef, `booking:${bookingKey}:1:event_start:${soon}`));
    expect(suggestion?.status).toBe('pending');
    expect(suggestion?.acceptedTaskId).toBeNull();
    if (!suggestion) throw new Error('flight briefing did not create its suggestion');
    flightSuggestionId = suggestion.id;
    createdSuggestionIds.push(suggestion.id);

    const [posted] = await db
      .select({ parts: messages.parts })
      .from(messages)
      .where(like(messages.text, `${MARKER} composed digest%`));
    const parts = (posted?.parts ?? []) as Array<{ type?: string; suggestionId?: string }>;
    // The message leads with the model's one-line lead and lists the rows
    // under bold labels, so it stays scannable even where the card is unknown.
    const [text] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(like(messages.text, `${MARKER} composed digest%`));
    expect(text?.text).toMatch(/\*\*Mail worth reading[^*]*\*\*\n- .*Your itinerary/);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-card',
          data: expect.objectContaining({ kind: 'briefing' }),
        }),
      ]),
    );
    expect(
      parts.some((part) => part.type === 'suggestion' && part.suggestionId === suggestion.id),
    ).toBe(true);
  });

  it('proposes the obvious next step, once, as an inert card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    if (!flightSuggestionId) throw new Error('the preceding fixture did not create a suggestion');
    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, flightSuggestionId));
    expect(row?.status).toBe('pending');
    // Inert: nothing is queued until the owner says yes.
    expect(row?.acceptedTaskId).toBeNull();
    expect(row?.proposedAction).toContain('no attendees');
    const eventStart = /It starts at ([^ ]+)/
      .exec(row?.proposedAction ?? '')?.[1]
      ?.replace(/\.$/, '');
    expect(eventStart).toBeDefined();
    expect(row?.expiresAt.getTime()).toBe(Date.parse(eventStart as string));
    // A second run must not re-ask: the source ref is stable per date.
    const { router } = recordingRouter();
    const again = await runBriefing({
      db,
      router,
      calendarReader: async () => ({ events: [], complete: true }),
    });
    expect(again.suggested).toBe(0);
    await db
      .update(suggestions)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(eq(suggestions.id, flightSuggestionId));
  });

  it('does not repeat an exact confirmed owner-calendar booking as a proposal', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const civilDate = new Date(now.getTime() + 4 * 86_400_000).toISOString().slice(0, 10);
    const identity = `${MARKER}-R-916`;
    await addMail({
      id: 'already-on-calendar',
      importance: 3,
      category: 'travel',
      subject: `${MARKER} Berlin spa confirmation`,
    });
    const bookingKey = emailBookingKey(agentId, identity);
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: civilDate,
          what: 'Berlin spa',
          dateRole: 'event_start',
          precision: 'date',
          civilDate,
          lifecycle: 'confirmed',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-already-on-calendar`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 1,
    });
    const result = await runBriefing({
      db,
      router: recordingRouter().router,
      calendarReader: async ({ timeMin, timeMax }) => ({
        events:
          timeMax.getTime() - timeMin.getTime() > 2 * 86_400_000
            ? [
                {
                  summary: 'Berlin spa',
                  description: `Booking reference ${identity}`,
                  start: civilDate,
                  end: civilDate,
                  calendar: 'Primary',
                  calendarId: 'primary',
                  allDay: true,
                  eventId: 'existing-spa-event',
                },
              ]
            : [],
        complete: true,
      }),
    });
    expect(result.suggested).toBe(0);
    const repeated = await db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(eq(suggestions.bookingKey, bookingKey));
    expect(repeated).toHaveLength(0);
  });

  it('offers one bounded reconciliation for a cancelled booking with one exact calendar match', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const civilDate = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const identity = `${MARKER}-R-CANCEL-1`;
    const bookingKey = emailBookingKey(agentId, identity);
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'cancelled',
      dates: [
        {
          iso: civilDate,
          what: 'Berlin spa',
          dateRole: 'event_start',
          precision: 'date',
          civilDate,
          lifecycle: 'cancelled',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-cancelled-booking`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 3,
    });
    const result = await runBriefing({
      db,
      router: recordingRouter().router,
      calendarCancellationEnabled: true,
      calendarReader: async () => ({
        complete: true,
        events: [
          {
            summary: 'Berlin spa',
            description: `Booking reference ${identity}`,
            start: civilDate,
            end: civilDate,
            calendar: 'Primary',
            calendarId: 'primary',
            allDay: true,
            eventId: 'spa-cancel-event',
          },
        ],
      }),
    });
    expect(result.bookingCancellations).toBe(1);
    expect(result.suggested).toBeGreaterThanOrEqual(1);
    const [suggestion] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, bookingKey));
    expect(suggestion).toMatchObject({
      bookingVersion: 3,
      bookingCancellation: {
        calendarEventId: 'spa-cancel-event',
        bookingIdentity: identity,
      },
    });
    if (!suggestion) throw new Error('expected cancellation suggestion');
    createdSuggestionIds.push(suggestion.id);
    await db.delete(suggestions).where(eq(suggestions.id, suggestion.id));
    await db
      .delete(emailBookingOccurrences)
      .where(eq(emailBookingOccurrences.bookingKey, bookingKey));
  });

  it('does not publish a cancelled-booking proposal dismissed while the briefing is composing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const civilDate = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const identity = `${MARKER}-R-CANCEL-RACE`;
    const bookingKey = emailBookingKey(agentId, identity);
    const eventId = `${MARKER}-spa-cancel-event`;
    const sourceRef = `booking:${bookingKey}:3:cancel:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}:${createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`;
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'cancelled',
      dates: [
        {
          iso: civilDate,
          what: `${MARKER} cancelled spa`,
          dateRole: 'event_start',
          precision: 'date',
          civilDate,
          lifecycle: 'cancelled',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-cancelled-race`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 3,
    });
    const [proposal] = await db
      .insert(suggestions)
      .values({
        agentId,
        conversationId,
        summary: `${MARKER} cancellation proposal`,
        proposedAction: 'review the exact calendar cancellation',
        sourceRef,
        bookingKey,
        bookingVersion: 3,
        bookingCancellation: { calendarEventId: eventId, bookingIdentity: identity },
        expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      })
      .returning({ id: suggestions.id });
    if (!proposal) throw new Error('race suggestion fixture failed');
    createdSuggestionIds.push(proposal.id);
    const priorMessageIds = new Set(
      (
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
      ).map((message) => message.id),
    );

    let enterDraft!: () => void;
    const draftEntered = new Promise<void>((resolve) => {
      enterDraft = resolve;
    });
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    const router = {
      async object(_role: string, _opts: { prompt?: string }) {
        enterDraft();
        await draftGate;
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          object: { lead: `${MARKER} cancelled booking needs review` },
        };
      },
    } as unknown as ModelRouter;
    const running = runBriefing(
      {
        db,
        router,
        calendarCancellationEnabled: true,
        calendarReader: async () => ({
          complete: true,
          events: [
            {
              summary: `${MARKER} cancelled spa`,
              description: `Booking reference ${identity}`,
              start: civilDate,
              end: civilDate,
              calendar: 'Primary',
              calendarId: 'primary',
              allDay: true,
              eventId,
            },
          ],
        }),
      },
      { now },
    );
    await draftEntered;
    expect(await dismissSuggestion(db, proposal.id, { now: new Date(now.getTime() + 1_000) })).toBe(
      true,
    );
    releaseDraft();
    const result = await running;
    expect(result.bookingCancellations).toBe(0);
    expect(result.suggested).toBe(0);
    expect(result.composedFallback).toBe(true);
    const staleMessages = await db
      .select({ id: messages.id, text: messages.text })
      .from(messages)
      .where(like(messages.text, `%${MARKER} cancelled booking needs review%`));
    expect(staleMessages).toHaveLength(0);
    const newlyPublished = (
      await db
        .select({ id: messages.id, text: messages.text, parts: messages.parts })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
    ).filter((message) => !priorMessageIds.has(message.id));
    const publishedContent = JSON.stringify(newlyPublished).toLowerCase();
    expect(publishedContent).not.toContain(sourceRef.toLowerCase());
    expect(publishedContent).not.toContain(eventId.toLowerCase());
    expect(publishedContent).not.toContain(`${MARKER} cancelled spa`.toLowerCase());
    await db.delete(suggestions).where(eq(suggestions.id, proposal.id));
    await db
      .delete(emailBookingOccurrences)
      .where(eq(emailBookingOccurrences.bookingKey, bookingKey));
  });

  it('keeps the decision lock and notice append inside the caller transaction', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const sourceRef = `booking:${MARKER}-nested-fence`;
    const [proposal] = await db
      .insert(suggestions)
      .values({
        agentId,
        conversationId,
        summary: `${MARKER} transaction proposal`,
        proposedAction: 'review the transaction fence',
        sourceRef,
        expiresAt: new Date(now.getTime() + 86_400_000),
      })
      .returning({ id: suggestions.id });
    if (!proposal) throw new Error('nested fence suggestion fixture failed');
    createdSuggestionIds.push(proposal.id);
    const observationFence = await ownerNoticeObservationFence(db, agentId);

    let enteredOuter!: () => void;
    const outerEntered = new Promise<void>((resolve) => {
      enteredOuter = resolve;
    });
    let releaseOuter!: () => void;
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    const outer = db.transaction(async (tx) => {
      const posted = await postOwnerNoticeWithDecisionFence(tx as unknown as Db, {
        agentId,
        text: `${MARKER} transaction-fenced notice`,
        now,
        observationFence,
        suggestionSourceRefs: [sourceRef],
        requiredSuggestionSourceRefs: [sourceRef],
        securityIncidents: [],
      });
      expect(posted.status).toBe('posted');
      enteredOuter();
      await outerGate;
    });
    await outerEntered;
    let dismissed: boolean | undefined;
    const dismissal = dismissSuggestion(db, proposal.id, { now: new Date(now.getTime() + 1) }).then(
      (value) => {
        dismissed = value;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(dismissed).toBeUndefined();
    releaseOuter();
    await outer;
    await dismissal;
    expect(dismissed).toBe(true);
    const posted = await db
      .select({ id: messages.id })
      .from(messages)
      .where(like(messages.text, `%${MARKER} transaction-fenced notice%`));
    expect(posted).toHaveLength(1);
  });

  it('rejects a completed privacy generation change while the briefing is composing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    await addMail({
      id: 'privacy-generation-race',
      importance: 4,
      category: 'action',
      subject: `${MARKER} private source before erase`,
      createdAt: now,
    });
    let enterDraft!: () => void;
    const draftEntered = new Promise<void>((resolve) => {
      enterDraft = resolve;
    });
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    const router = {
      async object() {
        enterDraft();
        await draftGate;
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          object: { lead: `${MARKER} private content was summarized` },
        };
      },
    } as unknown as ModelRouter;
    const priorMessageIds = new Set(
      (
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
      ).map((message) => message.id),
    );
    const running = runBriefing({ db, router }, { now });
    await draftEntered;
    await db
      .insert(maintenanceCursors)
      .values({
        name: `privacy-erasure-generation:${agentId}`,
        cursor: `${MARKER}-completed-erasure-generation`,
      })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor: `${MARKER}-completed-erasure-generation`, updatedAt: new Date() },
      });
    releaseDraft();
    await expect(running).rejects.toThrow('Privacy erasure changed during owner notice');
    const after = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(after.every((message) => priorMessageIds.has(message.id))).toBe(true);
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
  });

  it('does not offer cancellation when calendar match is absent or duplicated', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const civilDate = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const identities = [`${MARKER}-R-CANCEL-MISSING`, `${MARKER}-R-CANCEL-DUPLICATE`];
    for (const [index, identity] of identities.entries()) {
      const bookingKey = emailBookingKey(agentId, identity);
      await db.insert(emailBookingOccurrences).values({
        agentId,
        bookingKey,
        lifecycle: 'cancelled',
        dates: [
          {
            iso: civilDate,
            what: `cancelled booking ${index}`,
            dateRole: 'event_start',
            precision: 'date',
            civilDate,
            lifecycle: 'cancelled',
            bookingIdentity: identity,
          },
        ],
        sourceChannelMessageId: `gmail:${MARKER}-cancel-${index}`,
        sourceReceivedAt: now,
        sourceAuthenticated: true,
        version: 1,
      });
      const matches =
        index === 0
          ? []
          : [1, 2].map((n) => ({
              summary: 'same booking',
              description: `Ref ${identity}`,
              start: civilDate,
              end: civilDate,
              calendar: 'Primary',
              calendarId: 'primary',
              allDay: true,
              eventId: `duplicate-event-${n}`,
            }));
      await runBriefing({
        db,
        router: recordingRouter().router,
        calendarCancellationEnabled: true,
        calendarReader: async () => ({ events: matches, complete: true }),
      });
    }
    const bookingKeys = identities.map((identity) => emailBookingKey(agentId, identity));
    expect(
      await db.select().from(suggestions).where(inArray(suggestions.bookingKey, bookingKeys)),
    ).toHaveLength(0);
    await db
      .delete(emailBookingOccurrences)
      .where(inArray(emailBookingOccurrences.bookingKey, bookingKeys));
  });

  it('does not claim a booking is absent from the calendar when coverage is missing or partial', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const civilDate = new Date(now.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
    const identity = `${MARKER}-R-918`;
    const bookingKey = emailBookingKey(agentId, identity);
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: civilDate,
          what: 'Meeting',
          dateRole: 'event_start',
          precision: 'date',
          civilDate,
          lifecycle: 'confirmed',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-partial-calendar`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 1,
    });
    await runBriefing({
      db,
      router: recordingRouter().router,
      calendarReader: async () => ({ events: [], complete: false }),
    });
    const [suggestion] = await db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(eq(suggestions.bookingKey, bookingKey));
    expect(suggestion).toBeUndefined();
  });

  it('keeps source date-only events all-day and expires them at the owner-local day end', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const civilDate = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const identity = `${MARKER}-R-917`;
    const bookingKey = emailBookingKey(agentId, identity);
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: civilDate,
          what: 'Berlin spa',
          dateRole: 'event_start',
          precision: 'date',
          civilDate,
          sourceTimeZone: 'Europe/Berlin',
          lifecycle: 'confirmed',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-all-day`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 1,
    });
    await runBriefing({
      db,
      router: recordingRouter().router,
      calendarReader: async () => ({ events: [], complete: true }),
    });
    const [suggestion] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, bookingKey));
    expect(suggestion).toBeDefined();
    if (suggestion) createdSuggestionIds.push(suggestion.id);
    expect(suggestion?.proposedAction).toContain('allDay true');
    expect(suggestion?.proposedAction).toContain(`start ${civilDate}`);
    const expectedEnd = resolveBookingLocalDateTime(`${civilDate}T23:59:59`, 'Europe/Berlin');
    expect(expectedEnd).not.toBeNull();
    expect(suggestion?.expiresAt.getTime()).toBe(Date.parse(expectedEnd as string));
    if (suggestion) {
      await db.delete(suggestions).where(eq(suggestions.id, suggestion.id));
      createdSuggestionIds.splice(createdSuggestionIds.indexOf(suggestion.id), 1);
    }
  });

  it('expires reminder proposals at the reminder time and skips past reminder times', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const due = new Date(now.getTime() + 3 * 86_400_000);
    await addMail({
      id: 'future-payment',
      importance: 4,
      category: 'financial',
      subject: `${MARKER} Payment due`,
      dates: [
        { iso: due.toISOString(), what: `${MARKER} future payment`, dateRole: 'payment_due' },
      ],
    });
    await addMail({
      id: 'near-payment',
      importance: 4,
      category: 'financial',
      subject: `${MARKER} Payment tomorrow`,
      dates: [
        {
          iso: new Date(now.getTime() + 86_400_000).toISOString(),
          what: `${MARKER} near payment`,
          dateRole: 'payment_due',
        },
      ],
    });
    await runBriefing({ db, router: recordingRouter().router }, { now });
    const proposed = await db
      .select()
      .from(suggestions)
      .where(like(suggestions.summary, `%${MARKER}%payment%`));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.expiresAt.getTime()).toBe(due.getTime() - 2 * 86_400_000);
    if (proposed.length) {
      await db.delete(suggestions).where(
        inArray(
          suggestions.id,
          proposed.map((row) => row.id),
        ),
      );
    }
  });

  it('omits old and archived stopped work and summarizes recent provider failures', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    const rows = await db
      .insert(tasks)
      .values([
        {
          agentId,
          type: 'adhoc',
          status: 'needs_attention',
          title: `${MARKER} old failure`,
          updatedAt: new Date(now.getTime() - 3 * 86_400_000),
        },
        {
          agentId,
          type: 'adhoc',
          status: 'needs_attention',
          title: `${MARKER} hidden failure`,
          updatedAt: now,
          archivedAt: now,
        },
        {
          agentId,
          type: 'adhoc',
          status: 'needs_attention',
          title: `${MARKER} recent failure`,
          updatedAt: now,
          progress: 'Attempt 8: AI_APICallError: provider/model unavailable',
        },
      ])
      .returning({ id: tasks.id });
    try {
      const { router, prompts } = recordingRouter();
      await runBriefing({ db, router }, { now });
      expect(prompts[0]).toContain(
        `${MARKER} recent failure: Paused because a service request failed.`,
      );
      expect(prompts[0]).not.toContain(`${MARKER} old failure`);
      expect(prompts[0]).not.toContain(`${MARKER} hidden failure`);
      expect(prompts[0]).not.toContain('AI_APICallError');
    } finally {
      await db.delete(tasks).where(
        inArray(
          tasks.id,
          rows.map((row) => row.id),
        ),
      );
    }
  });

  it('does not propose anything for a date that is only marketing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // "Sale ends Friday" is a date too. Proposing a calendar entry for it is
    // how a useful surface becomes noise, so the category gates the proposal.
    await addMail({
      id: 'sale',
      importance: 3,
      category: 'bulk',
      subject: `${MARKER} Last chance`,
      dates: [
        { iso: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(), what: 'sale ends' },
      ],
    });
    const { router } = recordingRouter();
    const result = await runBriefing({ db, router });
    expect(result.suggested).toBe(0);
  });

  it('still delivers the notes when the composer cannot structure a digest', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The assembled rows ARE the substance; a composer outage should cost
    // polish, not the briefing. The name matters — isUnparseableObjectError
    // matches the AI SDK's error, and only that one degrades rather than throws.
    const failing = {
      async object() {
        throw Object.assign(new Error('no object generated'), {
          name: 'AI_NoObjectGeneratedError',
        });
      },
    } as unknown as ModelRouter;

    const result = await runBriefing({ db, router: failing });
    expect(result.delivered).toBe(true);

    const posted = await db
      .select({ text: messages.text })
      .from(messages)
      .where(like(messages.text, `%${MARKER} Your itinerary%`));
    // The raw notes went out, carrying the same items the composed version had.
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runBriefing — richer inputs', () => {
  const watchIds: string[] = [];
  const goalIds: string[] = [];
  const flightIngestIds: string[] = [];
  const flightBookingKeys: string[] = [];

  afterEach(async () => {
    if (!dbUp) return;
    if (flightIngestIds.length) {
      await db.delete(emailIngest).where(inArray(emailIngest.id, flightIngestIds));
      flightIngestIds.length = 0;
    }
    if (flightBookingKeys.length) {
      await db.delete(suggestions).where(inArray(suggestions.bookingKey, flightBookingKeys));
      await db
        .delete(emailBookingOccurrences)
        .where(inArray(emailBookingOccurrences.bookingKey, flightBookingKeys));
      flightBookingKeys.length = 0;
    }
    if (watchIds.length) {
      await db.delete(watchFires).where(inArray(watchFires.watchId, watchIds));
      await db.delete(watches).where(inArray(watches.id, watchIds));
      watchIds.length = 0;
    }
    if (goalIds.length) {
      await db.delete(goals).where(inArray(goals.id, goalIds));
      goalIds.length = 0;
    }
  });

  async function addFlightMail(input: Parameters<typeof addMail>[0]) {
    const id = await addMail(input);
    if (!id) throw new Error('Flight mail fixture was not inserted');
    flightIngestIds.push(id);
  }

  function calendarReturning(events: Array<Record<string, unknown>>) {
    return (async () => ({
      events: events.map((event) => ({
        summary: '',
        start: '',
        end: '',
        calendar: 'primary',
        allDay: false,
        ...event,
      })),
      complete: true,
    })) as NonNullable<Parameters<typeof runBriefing>[0]['calendarReader']>;
  }

  it('surfaces a calendar conflict even on an otherwise quiet day', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const day = new Date(Date.now() + 24 * 3600 * 1000);
    const at = (h: number) => new Date(day.getTime() + h * 3600 * 1000).toISOString();
    const digest = `${MARKER} conflict digest`;
    const { router, prompts } = recordingRouter(digest);
    const result = await runBriefing({
      db,
      router,
      calendarReader: calendarReturning([
        { summary: `${MARKER} Dentist`, start: at(9), end: at(10) },
        { summary: `${MARKER} Interview`, start: at(9.5), end: at(11) },
      ]),
    });
    expect(result.calendarConflicts).toBe(1);
    expect(result.delivered).toBe(true);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain(`${MARKER} Dentist`);
    expect(prompt).toContain('overlaps');
    const [posted] = await db
      .select({ parts: messages.parts })
      .from(messages)
      .where(like(messages.text, `${digest}%`));
    expect(posted?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-card',
          data: expect.objectContaining({ kind: 'calendar-conflicts' }),
        }),
      ]),
    );
    // The briefing card leads, and its schedule marks both overlapping events.
    const briefing = ((posted?.parts ?? []) as Array<{ data?: Record<string, unknown> }>).find(
      (part) => part.data?.kind === 'briefing',
    )?.data as {
      lead: string;
      sections: Array<{ type: string; items?: Array<Record<string, unknown>> }>;
    };
    expect(briefing.lead).toBe(digest);
    const agenda = briefing.sections.find((section) => section.type === 'agenda');
    expect(
      agenda?.items
        ?.filter((item) => String(item.title).startsWith(MARKER))
        .map((item) => item.flag),
    ).toEqual(['conflict', 'conflict']);
  });

  it('preserves uncertain match listings from family and team calendars', () => {
    const conflicts = findConflicts(
      [
        {
          summary: 'Palo Alto v United (12:00)',
          start: '2026-08-29T18:15:00Z',
          end: '2026-08-29T20:30:00Z',
          calendar: 'Family',
          allDay: false,
          location: 'Mayfield Soccer Complex',
        },
        {
          summary: '26/27 U13B Azul @ Palo Alto SC 13/14B Gold',
          start: '2026-08-29T19:00:00Z',
          end: '2026-08-29T20:10:00Z',
          calendar: 'SF United Soccer',
          allDay: false,
          location: 'Mayfield Soccer Complex',
        },
      ],
      'America/Los_Angeles',
    );

    expect(conflicts).toHaveLength(1);
  });

  it('preserves conflicts for shared-UID moved occurrences and copy bridges', () => {
    const event = {
      calendarId: 'work',
      eventId: 'one',
      calendar: 'Work',
      iCalUID: 'series',
      recurringEventId: 'r',
      originalStartTime: '2026-10-07T09:00:00Z',
      summary: 'Standup',
      start: '2026-10-07T09:00:00Z',
      end: '2026-10-07T10:00:00Z',
      allDay: false,
    };
    expect(
      findConflicts([
        event,
        {
          ...event,
          eventId: 'two',
          originalStartTime: '2026-10-08T09:00:00Z',
          start: '2026-10-07T09:15:00Z',
        },
      ]),
    ).toHaveLength(1);
    expect(
      findConflicts([
        event,
        { ...event, calendarId: 'personal', calendar: 'Personal', eventId: 'copy' },
        { ...event, eventId: 'two', start: '2026-10-07T09:15:00Z' },
      ]),
    ).toHaveLength(1);
  });

  it('still reports two instances of one series that collide on the same calendar', () => {
    // A moved instance keeps its series id, so identity by recurringEventId
    // alone would merge a genuine double-booking out of the briefing.
    const conflicts = findConflicts(
      [
        {
          summary: 'Standup',
          start: '2026-08-29T16:00:00Z',
          end: '2026-08-29T16:30:00Z',
          calendar: 'Work',
          calendarId: 'work@example.com',
          recurringEventId: 'series-1',
          allDay: false,
        },
        {
          summary: 'Standup',
          start: '2026-08-29T16:15:00Z',
          end: '2026-08-29T16:45:00Z',
          calendar: 'Work',
          calendarId: 'work@example.com',
          recurringEventId: 'series-1',
          allDay: false,
        },
      ],
      'America/Los_Angeles',
    );

    expect(conflicts).toHaveLength(1);
  });

  it('still merges one series copied onto a second calendar', () => {
    expect(
      findConflicts(
        [
          {
            summary: 'Standup',
            start: '2026-08-29T16:00:00Z',
            end: '2026-08-29T16:30:00Z',
            calendar: 'Work',
            calendarId: 'work@example.com',
            recurringEventId: 'series-1',
            iCalUID: 'series@example.com',
            originalStartTime: '2026-08-29T16:00:00Z',
            allDay: false,
          },
          {
            summary: 'Standup',
            start: '2026-08-29T16:00:00Z',
            end: '2026-08-29T16:30:00Z',
            calendar: 'Personal',
            calendarId: 'me@example.com',
            recurringEventId: 'series-1',
            iCalUID: 'series@example.com',
            originalStartTime: '2026-08-29T16:00:00Z',
            allDay: false,
          },
        ],
        'America/Los_Angeles',
      ),
    ).toEqual([]);
  });

  it('counts a routine calendar as context, never as news', () => {
    // The silence rule, pinned without a database: events alone never deliver.
    expect(
      briefingHasNews({
        highlights: 0,
        upcoming: 0,
        needsAttention: 0,
        pendingApprovals: 0,
        calendarConflicts: 0,
        calendarSalient: 0,
        goalDeltas: 0,
        watchHits: 0,
      }),
    ).toBe(false);
    // ...but each genuine signal flips it on its own.
    const quiet = {
      highlights: 0,
      upcoming: 0,
      needsAttention: 0,
      pendingApprovals: 0,
      calendarConflicts: 0,
      calendarSalient: 0,
      goalDeltas: 0,
      watchHits: 0,
    };
    expect(briefingHasNews({ ...quiet, calendarConflicts: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, calendarSalient: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, goalDeltas: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, watchHits: 1 })).toBe(true);
    expect(briefingHasNews({ ...quiet, highlights: 1 })).toBe(true);
  });

  it('pings the phone once, ambient, when the briefing delivers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addMail({
      id: 'ping',
      importance: 5,
      category: 'financial',
      subject: `${MARKER} invoice due`,
    });
    const pings: Array<{ text: string; urgency?: string }> = [];
    const result = await runBriefing(
      {
        db,
        router: recordingRouter().router,
        notifyOwner: async (input) => {
          pings.push(input);
          return notificationLeg('push', 'delivered');
        },
      },
      { now: new Date() },
    );
    expect(result.delivered).toBe(true);
    expect(result.pinged).toBe(true);
    // Exactly one buzz, marked ambient so quiet hours and the daily cap govern
    // it — a briefing is something the owner did not just ask for.
    expect(pings).toHaveLength(1);
    expect(pings[0]?.urgency).toBe('ambient');
    expect(pings[0]?.text).toContain('mail highlight');
  });

  it('still delivers the dashboard copy when no phone channel is wired', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addMail({
      id: 'nophone',
      importance: 5,
      category: 'financial',
      subject: `${MARKER} second invoice`,
    });
    const result = await runBriefing({ db, router: recordingRouter().router }, { now: new Date() });
    expect(result.delivered).toBe(true);
    expect(result.pinged).toBe(false);
  });

  it('builds a push headline only from what the notes actually held', () => {
    const empty = {
      delivered: true,
      pinged: false,
      composedFallback: false,
      mailScanned: 40,
      highlights: 0,
      needsAttention: 0,
      pendingApprovals: 0,
      upcoming: 0,
      suggested: 0,
      calendarEvents: 9,
      calendarConflicts: 0,
      calendarSalient: 0,
      goalDeltas: 0,
      watchHits: 0,
    };
    // 40 messages scanned and 9 events seen, but nothing scored: the headline
    // must not manufacture an item out of the volume it looked at.
    expect(briefingHeadline(empty)).toBe('Your briefing is ready.');

    const busy = briefingHeadline({
      ...empty,
      calendarConflicts: 1,
      calendarSalient: 2,
      highlights: 3,
      pendingApprovals: 1,
    });
    expect(busy).toContain('1 calendar conflict');
    expect(busy).toContain('2 events worth a look');
    expect(busy).toContain('3 mail highlights');
    expect(busy).toContain('1 awaiting approval');
  });

  it('treats a salient event as news even with no conflict', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const start = new Date(Date.now() + 3 * 3600_000).toISOString();
    const end = new Date(Date.now() + 4 * 3600_000).toISOString();
    const { router, prompts } = recordingRouter();
    const result = await runBriefing({
      db,
      router,
      // One event, no overlap: before salience this was silence.
      calendarReader: async () => ({
        events: [
          {
            summary: `${MARKER} Consultant`,
            start,
            end,
            calendar: 'Personal',
            allDay: false,
            eventId: 'evt-salient',
            location: 'Skolavorduholt 1',
            organizer: 'clinic@hospital.example',
            attendees: ['bmson@bmson.com (needsAction)'],
          },
        ],
        complete: true,
      }),
    });
    expect(result.calendarConflicts).toBe(0);
    expect(result.calendarSalient).toBe(1);
    expect(result.delivered).toBe(true);
    expect(prompts[0] ?? '').toContain('Events worth a second look');
  });

  it('keeps a conflicting flight in the calendar agenda without treating its time as verified salience', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date('2026-10-08T16:00:00.000Z');
    const identity = `${MARKER}-KLM-1345`;
    const bookingKey = emailBookingKey(agentId, identity);
    flightBookingKeys.push(bookingKey);
    await addFlightMail({
      id: 'flight-time-conflict',
      importance: 4,
      category: 'travel',
      subject: `${MARKER} KLM itinerary`,
      createdAt: now,
    });
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: '2026-10-09T20:45:00.000Z',
          what: 'KLM flight SFO to AMS',
          dateRole: 'event_start',
          lifecycle: 'confirmed',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-flight-time-conflict`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 1,
    });
    await addFlightMail({
      id: 'flight-conflict-context',
      importance: 5,
      category: 'personal',
      subject: `${MARKER} please review this message`,
      createdAt: now,
    });

    const { router, prompts } = recordingRouter();
    const united = {
      summary: 'SFO → BER flight (United)',
      start: '2026-10-09T16:15:00.000Z',
      end: '2026-10-10T03:15:00.000Z',
      calendar: 'Personal',
      calendarId: 'primary',
      allDay: false,
      eventId: `${MARKER}-united`,
      location: 'San Francisco International Airport',
    };
    const result = await runBriefing(
      {
        db,
        router,
        calendarReader: async () => ({ events: [united], complete: true }),
      },
      { now },
    );

    expect(result.delivered).toBe(true);
    expect(result.calendarEvents).toBe(1);
    expect(result.calendarSalient).toBe(0);
    const prompt = prompts[0] ?? '';
    expect(prompt).not.toContain('Events worth a second look:');
    expect(prompt).toContain('On the calendar');
    expect(prompt).toContain('SFO → BER flight (United)');
    expect(prompt).toContain('KLM flight SFO to AMS');
  });

  it('keeps a flight time salient when a complete calendar row matches its confirmed booking', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date('2026-10-08T16:00:00.000Z');
    const identity = `${MARKER}-KLM-1345-MATCHED`;
    const bookingKey = emailBookingKey(agentId, identity);
    flightBookingKeys.push(bookingKey);
    await addFlightMail({
      id: 'flight-time-matched',
      importance: 4,
      category: 'travel',
      subject: `${MARKER} matching KLM itinerary`,
      createdAt: now,
    });
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: '2026-10-09T20:45:00.000Z',
          what: 'KLM flight SFO to AMS',
          dateRole: 'event_start',
          lifecycle: 'confirmed',
          bookingIdentity: identity,
        },
      ],
      sourceChannelMessageId: `gmail:${MARKER}-flight-time-matched`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 1,
    });
    const { router, prompts } = recordingRouter();
    const matched = {
      summary: `KLM flight SFO to AMS ${identity}`,
      start: '2026-10-09T20:45:00.000Z',
      end: '2026-10-10T03:15:00.000Z',
      calendar: 'Personal',
      calendarId: 'primary',
      allDay: false,
      eventId: `${MARKER}-klm-matched`,
      location: 'San Francisco International Airport',
    };
    const result = await runBriefing(
      {
        db,
        router,
        calendarReader: async () => ({ events: [matched], complete: true }),
      },
      { now },
    );

    expect(result.calendarSalient).toBe(1);
    expect(result.delivered).toBe(true);
    expect(prompts[0] ?? '').toContain('Events worth a second look:');
  });

  it('includes goal deltas, watch hits, and open suggestions in the notes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [goal] = await db
      .insert(goals)
      .values({ agentId, title: `${MARKER} learn Icelandic`, nextAction: 'book a class' })
      .returning({ id: goals.id });
    if (!goal) throw new Error('goal fixture failed');
    goalIds.push(goal.id);

    const [watch] = await db
      .insert(watches)
      .values({ agentId, name: `${MARKER} watch`, expiresAt: new Date(Date.now() + 86400e3) })
      .returning({ id: watches.id });
    if (!watch) throw new Error('watch fixture failed');
    watchIds.push(watch.id);
    await db.insert(watchFires).values({
      watchId: watch.id,
      agentId,
      triggerRef: `gmail:${MARKER}-fire`,
      summary: `${MARKER} the watched sender wrote in`,
    });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        agentId,
        conversationId,
        summary: `${MARKER} an earlier proposal`,
        proposedAction: 'do the thing',
        sourceRef: `gmail:${MARKER}-open:0`,
        expiresAt: new Date(Date.now() + 7 * 86400e3),
      })
      .returning({ id: suggestions.id });
    if (!suggestion) throw new Error('suggestion fixture failed');
    createdSuggestionIds.push(suggestion.id);

    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });
    expect(result.delivered).toBe(true);
    expect(result.goalDeltas).toBeGreaterThanOrEqual(1);
    expect(result.watchHits).toBeGreaterThanOrEqual(1);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain(`${MARKER} learn Icelandic`);
    expect(prompt).toContain(`${MARKER} the watched sender wrote in`);
    expect(prompt).toContain(`${MARKER} an earlier proposal`);
  });

  it('briefs without a calendar section when no reader is wired', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });
    expect(result.calendarEvents).toBe(0);
    expect(result.calendarConflicts).toBe(0);
    if (result.delivered) {
      expect(prompts[0] ?? '').not.toContain('On the calendar');
    }
  });
});

describe('briefing substance', () => {
  it.each(['', 'Here is your daily briefing in Assistant’s voice based on the provided notes:'])(
    'falls back to gathered facts for meta-only output',
    (draft) => {
      expect(briefingBody(draft, ['Today:', '- Practice at 5 PM'])).toBe(
        'Today:\n- Practice at 5 PM',
      );
    },
  );
  it('preserves a substantive digest', () => {
    expect(briefingBody('Practice starts at 5 PM.', ['notes'])).toBe('Practice starts at 5 PM.');
  });
});

describe('briefing task summaries', () => {
  it('keeps provider failures out of readable digest prose', () => {
    expect(
      briefingTaskSummary('Attempt 8: AI_APICallError: provider/model not found, raw request body'),
    ).toBe('Paused because a service request failed. Open the task for details.');
    expect(briefingTaskSummary('Which city should I use?')).toBe('Which city should I use?');
    expect(briefingTaskSummary('')).toBe('Open the task to review what is needed.');
  });
});

it('excludes explicit cancelled, nonblocking and owner-declined rows from hard overlap evidence', () => {
  const event = {
    eventId: 'one',
    calendarId: 'shared',
    summary: 'Work',
    calendar: 'Shared',
    start: '2026-10-07T12:00:00Z',
    end: '2026-10-07T13:00:00Z',
    allDay: false,
  };
  for (const patch of [
    { status: 'cancelled' },
    { blocksTime: false },
    { ownerResponse: 'declined' },
  ]) {
    expect(findConflicts([event, { ...event, eventId: 'two', ...patch }])).toEqual([]);
  }
  const unknown = findConflicts([event, { ...event, eventId: 'two' }]);
  expect(unknown[0]?.attendance).toBe('unresolved');
  const confirmed = findConflicts([
    { ...event, ownerResponse: 'accepted' },
    { ...event, eventId: 'two', ownerResponse: 'accepted' },
  ]);
  expect(confirmed[0]?.attendance).toBe('confirmed');
});
