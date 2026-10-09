import { randomUUID } from 'node:crypto';
import { decideSuggestion } from '@assistant/application/suggestions';
import type { ModelRouter } from '@assistant/core';
import { getAgent } from '@assistant/core/chat';
import {
  calendarEventSnapshots,
  channelBindings,
  conversations,
  createDb,
  createPostgresEmailSyncRepository,
  createPostgresExecutionPersistence,
  emailBookingOccurrences,
  emailIngest,
  messages,
  proactiveMoments,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
  suggestions,
  tasks,
} from '@assistant/db';
import { emailBookingKey, finalChannelDelivery } from '@assistant/persistence';
import { eq, inArray, like } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { runPulse } from '../../../packages/core/src/proactive/pulse.js';
import { runBriefing } from '../../../packages/core/src/workflow/briefing.js';
import type { DispatcherPort } from '../../../packages/core/src/workflow/executor/types.js';
import { executeTask } from '../../../packages/core/src/workflow/executor.js';
import type { EmailImportance } from '../../../packages/modules/src/google/email-importance.js';
import {
  type EmailSyncDeps,
  processForwardedIngest,
} from '../../../packages/modules/src/google/email-sync.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing synthetic-day fixture');
  return value;
}

it('keeps one useful mixed-day incident across arrival, completion, briefing, pulse, dismissal and refresh', async () => {
  const db = createDb(required(process.env.DATABASE_URL), { max: 2 });
  const marker = `mixed-day-${randomUUID()}`;
  const agentId = (await getAgent(db)).id;
  const persistence = createPostgresExecutionPersistence(db);
  const sync = createPostgresEmailSyncRepository(db, agentId);
  const now = new Date();
  const later = new Date(now.getTime() + 4 * 3600_000);
  const channels: string[] = [];
  const conversationIds: string[] = [];
  const arrival: string[] = [];
  const prompts: string[] = [];
  const finalAttempts: string[] = [];
  const day = (offset: number) =>
    new Date(now.getTime() + offset * 86400_000).toISOString().slice(0, 10);
  const bookedDate = day(6);
  const cancelledDate = day(8);
  const confirmedIdentity = `${marker}-confirmed`;
  const cancelledIdentity = `${marker}-cancelled`;
  const keys = [
    emailBookingKey(agentId, confirmedIdentity),
    emailBookingKey(agentId, cancelledIdentity),
  ];
  const originalId = `<${marker}-original@provider.example>`;
  const facts = {
    eventType: 'sign_in' as const,
    affectedAccount: 'owner@example.test',
    eventAt: now.toISOString(),
    device: 'Pixel 9',
    location: 'Oslo',
  };
  const originalQuote = `A sign-in to owner@example.test at ${facts.eventAt} from Pixel 9 in Oslo.`;
  const recoveryQuote = `Recovery copy of ${originalId}: ${originalQuote}`;
  const routine: EmailImportance = {
    category: 'transactional',
    importance: 3,
    actionable: false,
    dates: [],
    reason: 'routine',
    cardCandidate: false,
  };
  const scores = [
    {
      ...routine,
      category: 'security',
      securityEvidence: { ...facts, evidenceQuote: originalQuote },
    },
    {
      ...routine,
      category: 'security',
      securityEvidence: { ...facts, recoveryCopyOf: originalId, evidenceQuote: recoveryQuote },
    },
    routine,
    { ...routine, category: 'appointment' },
    { ...routine, category: 'appointment' },
    {
      ...routine,
      category: 'financial',
      importance: 5,
      actionable: true,
      nextStep: 'Review the payment deadline',
      dates: [
        {
          iso: day(3),
          what: `${marker} invoice`,
          dateRole: 'payment_due',
          precision: 'date',
          lifecycle: 'unknown',
          civilDate: day(3),
          dateEvidence: `Payment due on ${day(3)}.`,
        },
      ],
    },
    { ...routine, category: 'personal' },
  ] as EmailImportance[];
  const bodies = [
    originalQuote,
    recoveryQuote,
    'Receipt for a completed purchase.',
    `Booking ${confirmedIdentity} confirmed on ${bookedDate}.`,
    `Booking ${cancelledIdentity} cancelled for ${cancelledDate}.`,
    `Payment due on ${day(3)}.`,
    'Routine evening practice.',
  ];
  const names = [
    'security-original',
    'security-recovery',
    'receipt',
    'confirmed',
    'cancelled',
    'deadline',
    'practice',
  ];
  const latestByThread = new Map<string, string>();
  let scoreIndex = 0;
  const deps = {
    db,
    persistence,
    config: {
      ASSISTANT_MODULES: ['google'],
      GMAIL_SYNC_ENABLED: 'true',
      EMAIL_INGEST_IMPORTANCE_THRESHOLD: 4,
      EMAIL_INGEST_NOTIFY_THRESHOLD: 4,
      EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
      PROACTIVE_CARDS_ENABLED: false,
    },
    router: {
      object: async () => ({
        ok: true,
        modelId: 'fixture',
        degraded: false,
        object: scores[scoreIndex++],
      }),
    },
    workspace: {},
    googleClient: { configured: () => false, api: async () => ({}) },
    notifyOwner: async ({ text }: { text: string }) => {
      arrival.push(text);
    },
    observeInboundEmail: async () => {},
  } as unknown as EmailSyncDeps;
  try {
    for (const [index, name] of names.entries()) {
      const channelMessageId = `gmail:${marker}-${name}`;
      channels.push(channelMessageId);
      const providerId = `${marker}-${name}`;
      const thread = `${marker}-thread-${name}`;
      latestByThread.set(thread, providerId);
      await processForwardedIngest(deps, {
        agentId,
        message: { id: providerId, threadId: thread, internalDate: String(now.getTime()) },
        from: `${name}@example.test`,
        subject: `${marker} ${name}`,
        text: required(bodies[index]),
        rfcMessageId: index === 0 ? originalId : `<${marker}-${name}@provider.example>`,
        authenticated: true,
        contactTrustByEmail: new Map(),
        channelMessageId,
      });
    }
    const ingests = await db
      .select()
      .from(emailIngest)
      .where(inArray(emailIngest.channelMessageId, channels));
    conversationIds.push(
      ...new Set(ingests.flatMap((row) => (row.conversationId ? [row.conversationId] : []))),
    );
    expect(ingests).toHaveLength(7);
    expect(ingests.every((row) => row.pipelineStage === 'complete')).toBe(true);
    const original = required(ingests.find((row) => row.channelMessageId === channels[0]));
    const recovery = required(ingests.find((row) => row.channelMessageId === channels[1]));
    expect(original.securityIncidentId).toBeTruthy();
    expect(recovery.securityIncidentId).toBe(original.securityIncidentId);
    expect(arrival.filter((text) => text.includes('security-'))).toHaveLength(1);
    expect(arrival.some((text) => /receipt|practice/u.test(text))).toBe(false);
    const [incident] = await db
      .select()
      .from(securityIncidents)
      .where(eq(securityIncidents.id, required(original.securityIncidentId)));
    if (!incident) throw new Error('Security incident fixture was not persisted');
    const sourceRows = await db
      .select()
      .from(securityIncidentSources)
      .where(eq(securityIncidentSources.incidentId, incident.id));
    expect(sourceRows).toHaveLength(2);
    const attention = await db
      .select()
      .from(securityIncidentAttention)
      .where(eq(securityIncidentAttention.incidentId, incident.id));
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ producer: 'arrival', deliveryStatus: 'accepted' });

    // Calendar lifecycle is durable input to all later producers, not a model's claim.
    await db.insert(emailBookingOccurrences).values([
      {
        agentId,
        bookingKey: required(keys[0]),
        lifecycle: 'confirmed',
        dates: [
          {
            iso: bookedDate,
            civilDate: bookedDate,
            what: `${marker} existing appointment`,
            dateRole: 'event_start',
            precision: 'date',
            lifecycle: 'confirmed',
            bookingIdentity: confirmedIdentity,
          },
        ],
        sourceChannelMessageId: required(channels[3]),
        sourceReceivedAt: now,
        sourceAuthenticated: true,
        version: 2,
      },
      {
        agentId,
        bookingKey: required(keys[1]),
        lifecycle: 'cancelled',
        dates: [
          {
            iso: cancelledDate,
            civilDate: cancelledDate,
            what: `${marker} other appointment`,
            dateRole: 'event_start',
            precision: 'date',
            lifecycle: 'cancelled',
            bookingIdentity: cancelledIdentity,
          },
        ],
        sourceChannelMessageId: required(channels[4]),
        sourceReceivedAt: now,
        sourceAuthenticated: true,
        version: 4,
      },
    ]);
    const events = [
      {
        summary: `${marker} existing appointment`,
        description: `Booking reference ${confirmedIdentity}`,
        start: bookedDate,
        end: bookedDate,
        calendar: 'Primary',
        calendarId: 'primary',
        eventId: `${marker}-confirmed-event`,
        allDay: true,
      },
      {
        summary: `${marker} other appointment`,
        description: `Booking reference ${cancelledIdentity}`,
        start: cancelledDate,
        end: cancelledDate,
        calendar: 'Primary',
        calendarId: 'primary',
        eventId: `${marker}-cancel-event`,
        allDay: true,
      },
    ];
    const router = {
      async object(role: string, options: { prompt?: string }) {
        if (role === 'draft') {
          prompts.push(options.prompt ?? '');
          return {
            ok: true,
            modelId: 'fixture',
            degraded: false,
            object: { lead: `${marker} useful digest` },
          };
        }
        return {
          ok: true,
          modelId: 'fixture',
          degraded: false,
          object: {
            action: 'reply',
            reasoning:
              'Summarize the already-triaged deadline for owner review; no action is being performed.',
            steps: [],
            missingInfo: [],
          },
        };
      },
      async step() {
        return {
          ok: true,
          modelId: 'fixture',
          degraded: false,
          text: 'The payment deadline still needs your review.',
          toolCalls: [],
        };
      },
      async embed(texts: string[]) {
        return texts.map(() => Array(1536).fill(0.01));
      },
    } as unknown as ModelRouter;
    const dispatcher: DispatcherPort = {
      toolDefs: () => [],
      resultIsUntrusted: () => false,
      dispatch: async () => ({ kind: 'rejected', reason: 'no mutation tools' }),
      executeApproved: async () => ({ kind: 'failed', error: 'no approvals' }),
    };
    const deadline = required(ingests.find((row) => row.channelMessageId === channels[5]));
    expect(deadline.triageTaskId).toBeTruthy();
    const completion = await executeTask(
      {
        db,
        persistence,
        router,
        dispatcher,
        deliverFinal: async (_task, _text, attemptId) => {
          finalAttempts.push(attemptId);
          return finalChannelDelivery('email', 'accepted', attemptId, 'fixture-only');
        },
      },
      required(deadline.triageTaskId),
    );
    expect(completion.outcome).toBe('done');
    expect(finalAttempts).toHaveLength(1);
    const afterCompletion = await sync.ingestRecord(required(channels[5]));
    expect(afterCompletion?.obligationStatus).not.toBe('resolved');
    const briefing = await runBriefing(
      {
        db,
        router,
        calendarCancellationEnabled: true,
        calendarReader: async () => ({ events, complete: true }),
      },
      { now: later },
    );
    expect(briefing.securityIncidents).toBe(0); // arrival already admitted this revision
    expect(briefing.bookingCancellations).toBe(1);
    expect(briefing.upcoming).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Security notices requiring review:');
    expect(prompts[0]).not.toContain(`${marker} receipt`);
    expect(prompts[0]).not.toContain(`${marker} practice`);
    const cancellations = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, required(keys[1])));
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({
      status: 'pending',
      bookingVersion: 4,
      bookingCancellation: { calendarEventId: `${marker}-cancel-event` },
    });
    expect(
      await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.bookingKey, required(keys[0]))),
    ).toHaveLength(0);
    const pulse = await runPulse(
      {
        db,
        calendarReader: async () => ({ events, complete: true }),
        emailThreadReader: async ({ threadId }) => ({
          threadId,
          latestMessageId: required(latestByThread.get(threadId)),
          latestReceivedAt: now,
        }),
      },
      { now: later, agentId },
    );
    expect(pulse.candidates).toBe(1);
    expect(pulse.delivered).toBe('mail-action');
    expect(await decideSuggestion(db, required(cancellations[0]).id, 'dismissed')).toEqual({
      ok: true,
    });
    const pulseRows = await db
      .select()
      .from(proactiveMoments)
      .where(eq(proactiveMoments.agentId, agentId));
    expect(
      pulseRows.some((row) => row.momentKey.startsWith(`security-incident:${incident.id}:`)),
    ).toBe(false);
    expect(JSON.stringify(pulse)).not.toMatch(/receipt|practice/u);
    expect(
      await sync.decideSecurityIncident({
        agentId,
        incidentId: incident.id,
        expectedRevision: incident.revision,
        disposition: 'dismissed',
        reason: 'owner reviewed this incident',
        now: later,
      }),
    ).toBe(true);
    await processForwardedIngest(deps, {
      agentId,
      message: {
        id: `${marker}-security-recovery`,
        threadId: `${marker}-thread-security-recovery`,
      },
      from: 'security-recovery@example.test',
      subject: `${marker} security-recovery`,
      text: recoveryQuote,
      rfcMessageId: `<${marker}-security-recovery@provider.example>`,
      authenticated: true,
      contactTrustByEmail: new Map(),
      channelMessageId: required(channels[1]),
    });
    expect(arrival.filter((text) => text.includes('security-'))).toHaveLength(1);
    const refresh = await runBriefing(
      {
        db,
        router,
        calendarCancellationEnabled: true,
        calendarReader: async () => ({ events, complete: true }),
      },
      { now: new Date(later.getTime() + 60_000) },
    );
    expect(refresh.securityIncidents).toBe(0);
    expect(refresh.bookingCancellations).toBe(0);
    const refreshedCancellations = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, required(keys[1])));
    expect(refreshedCancellations).toHaveLength(1);
    expect(refreshedCancellations[0]?.status).toBe('dismissed');
    expect(await sync.listSecurityAttentionCandidates(agentId, 10)).toHaveLength(0);
    // A materially changed provider occurrence gets its own revision and decision.
    const changedDate = day(9);
    await db
      .update(emailBookingOccurrences)
      .set({
        version: 5,
        sourceReceivedAt: later,
        dates: [
          {
            iso: changedDate,
            civilDate: changedDate,
            what: `${marker} other appointment`,
            dateRole: 'event_start',
            precision: 'date',
            lifecycle: 'cancelled',
            bookingIdentity: cancelledIdentity,
          },
        ],
      })
      .where(eq(emailBookingOccurrences.bookingKey, required(keys[1])));
    const changedEvents = events.map((event) =>
      event.eventId === `${marker}-cancel-event`
        ? { ...event, start: changedDate, end: changedDate }
        : event,
    );
    const changed = await runBriefing(
      {
        db,
        router,
        calendarCancellationEnabled: true,
        calendarReader: async () => ({ events: changedEvents, complete: true }),
      },
      { now: new Date(later.getTime() + 2 * 60_000) },
    );
    expect(changed.bookingCancellations).toBe(1);
    const changedSuggestions = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.bookingKey, required(keys[1])));
    expect(changedSuggestions).toHaveLength(2);
    expect(changedSuggestions.find((row) => row.bookingVersion === 4)?.status).toBe('dismissed');
    expect(changedSuggestions.find((row) => row.bookingVersion === 5)?.status).toBe('pending');
    expect(events).toHaveLength(2); // no calendar mutation interface was supplied
    expect(
      await db
        .select()
        .from(securityIncidentAttention)
        .where(eq(securityIncidentAttention.incidentId, incident.id)),
    ).toHaveLength(1);
  } finally {
    const ingests = await db
      .select()
      .from(emailIngest)
      .where(inArray(emailIngest.channelMessageId, channels));
    const incidentIds = [
      ...new Set(
        ingests.flatMap((row) => (row.securityIncidentId ? [row.securityIncidentId] : [])),
      ),
    ];
    const taskIds = ingests.flatMap((row) => (row.triageTaskId ? [row.triageTaskId] : []));
    const ownedConversations = [
      ...new Set([
        ...conversationIds,
        ...ingests.flatMap((row) => (row.conversationId ? [row.conversationId] : [])),
      ]),
    ];
    await db.delete(suggestions).where(like(suggestions.sourceRef, `%${marker}%`));
    await db.delete(suggestions).where(inArray(suggestions.bookingKey, keys));
    await db
      .delete(emailBookingOccurrences)
      .where(inArray(emailBookingOccurrences.bookingKey, keys));
    await db
      .delete(calendarEventSnapshots)
      .where(like(calendarEventSnapshots.eventId, `${marker}%`));
    await db.delete(proactiveMoments).where(like(proactiveMoments.momentKey, `%${marker}%`));
    await db.delete(messages).where(like(messages.text, `%${marker}%`));
    if (taskIds.length) {
      await db.delete(messages).where(inArray(messages.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    await db.delete(emailIngest).where(inArray(emailIngest.channelMessageId, channels));
    if (incidentIds.length) {
      await db
        .delete(securityIncidentAttention)
        .where(inArray(securityIncidentAttention.incidentId, incidentIds));
      await db
        .delete(securityIncidentSources)
        .where(inArray(securityIncidentSources.incidentId, incidentIds));
      await db.delete(securityIncidents).where(inArray(securityIncidents.id, incidentIds));
    }
    if (ownedConversations.length) {
      await db
        .delete(channelBindings)
        .where(inArray(channelBindings.conversationId, ownedConversations));
      await db.delete(messages).where(inArray(messages.conversationId, ownedConversations));
      await db.delete(conversations).where(inArray(conversations.id, ownedConversations));
    }
    await db.$client.end({ timeout: 5 });
  }
}, 60_000);
