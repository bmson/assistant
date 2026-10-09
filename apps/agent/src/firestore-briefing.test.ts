import { createHash, randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask, runBriefing } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence, suggestionIdFor } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { emailBookingKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const HOUR = 3_600_000;
const SPACE = { provider: 'synthetic', model: 'briefing-fixture', dimensions: 1536, revision: '1' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore daily briefing job', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let deps: ExecutorDeps;
  let prompts: string[];
  const now = Date.now();
  const hoursAgo = (hours: number) => new Date(now - hours * HOUR);

  beforeEach(async () => {
    store = emulatorStore();
    prompts = [];
    const unavailable = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            throw new Error(`Unexpected ${name} access: ${String(property)}`);
          },
        },
      );
    persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    const router = {
      async object(_role: string, input: { prompt: string }) {
        prompts.push(input.prompt);
        return {
          ok: true,
          modelId: 'fixture',
          degraded: false,
          object: { lead: 'A dentist visit is coming up and one approval is waiting.' },
        };
      },
    };
    deps = {
      db: unavailable('db') as Db,
      router: router as unknown as ExecutorDeps['router'],
      dispatcher: {
        toolDefs: () => [],
      } as unknown as ExecutorDeps['dispatcher'],
      calendarReader: async () => ({ complete: true, events: [] }),
      persistence,
    };
    await store.doc('agents', agentId).set(
      encodeRecord({
        id: agentId,
        name: 'Ada',
        email: 'ada@assistant.test',
        timezone: 'UTC',
        createdAt: hoursAgo(1000),
        updatedAt: hoursAgo(1000),
      }),
    );
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function put(collection: string, row: Record<string, unknown> & { id: string }) {
    await store.doc(collection, row.id).set(encodeRecord(row));
    return row.id;
  }

  async function task(input: {
    status: string;
    hours: number;
    archived?: boolean;
    agent?: string;
    title?: string;
  }) {
    return put('tasks', {
      id: randomUUID(),
      agentId: input.agent ?? agentId,
      type: 'adhoc',
      trust: 'owner',
      status: input.status,
      title: input.title ?? null,
      progress: `Stopped: ${input.title ?? 'work'} needs a decision`,
      archivedAt: input.archived ? hoursAgo(1) : null,
      createdAt: hoursAgo(input.hours + 1),
      updatedAt: hoursAgo(input.hours),
    });
  }

  async function seedDay() {
    const inTwoDays = new Date(now + 48 * HOUR).toISOString();
    const bookingIdentity = 'dentist-cleaning-appointment';
    const bookingKey = emailBookingKey(agentId, bookingIdentity);
    const bookingSource = 'gmail:mail-dentist';
    await put('emailIngest', {
      id: randomUUID(),
      agentId,
      channelMessageId: 'mail-dentist',
      category: 'appointment',
      importance: 4,
      fromEmail: 'front-desk@dentist.test',
      fromName: 'Dentist',
      subject: 'Your cleaning appointment',
      dates: [{ iso: inTwoDays, what: 'Dental cleaning' }],
      createdAt: hoursAgo(3),
      updatedAt: hoursAgo(3),
    });
    await put('emailBookingOccurrences', {
      id: bookingKey,
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [
        {
          iso: inTwoDays,
          what: 'Dental cleaning',
          dateRole: 'event_start',
          precision: 'date',
          civilDate: inTwoDays.slice(0, 10),
          lifecycle: 'confirmed',
          bookingIdentity,
        },
      ],
      sourceChannelMessageId: bookingSource,
      sourceReceivedAt: hoursAgo(3),
      sourceAuthenticated: true,
      version: 1,
      createdAt: hoursAgo(3),
      updatedAt: hoursAgo(3),
    });
    await put('emailIngest', {
      id: randomUUID(),
      agentId,
      channelMessageId: 'mail-newsletter',
      category: 'newsletter',
      importance: 1,
      fromEmail: 'news@example.test',
      fromName: null,
      subject: 'Weekly digest',
      dates: [],
      createdAt: hoursAgo(2),
      updatedAt: hoursAgo(2),
    });
    await put('emailIngest', {
      id: randomUUID(),
      agentId,
      channelMessageId: 'mail-old',
      category: 'personal',
      importance: 5,
      fromEmail: 'old@example.test',
      fromName: 'Old',
      subject: 'Outside the window',
      dates: [],
      createdAt: hoursAgo(30),
      updatedAt: hoursAgo(30),
    });

    await task({ status: 'needs_attention', hours: 4, title: 'Book flights' });
    await task({ status: 'needs_attention', hours: 4, title: 'Archived stall', archived: true });
    await task({ status: 'needs_attention', hours: 40, title: 'Stale stall' });
    await task({
      status: 'needs_attention',
      hours: 2,
      title: 'Foreign stall',
      agent: randomUUID(),
    });

    const ownTask = await task({ status: 'waiting_approval', hours: 1, title: 'Send the RSVP' });
    const foreignTask = await task({ status: 'waiting_approval', hours: 1, agent: randomUUID() });
    const approval = (taskId: string, shortCode: string, expiresInHours: number) =>
      put('approvals', {
        id: randomUUID(),
        taskId,
        status: 'pending',
        shortCode,
        summary: `Approve ${shortCode}`,
        expiresAt: new Date(now + expiresInHours * HOUR),
        requestedAt: hoursAgo(1),
      });
    await approval(ownTask, 'A7', 10);
    await approval(ownTask, 'B2', -1);
    await approval(foreignTask, 'C3', 10);

    await put('goals', {
      id: randomUUID(),
      agentId,
      title: 'Learn to sail',
      status: 'active',
      nextAction: 'Book a lesson',
      createdAt: hoursAgo(200),
      updatedAt: hoursAgo(5),
    });
    const watchId = await put('watches', {
      id: randomUUID(),
      agentId,
      name: 'Concert tickets',
      status: 'active',
      createdAt: hoursAgo(100),
      updatedAt: hoursAgo(100),
    });
    await put('watchFires', {
      id: randomUUID(),
      agentId,
      watchId,
      summary: 'Tickets went on sale',
      createdAt: hoursAgo(6),
    });
    await put('suggestions', {
      id: randomUUID(),
      agentId,
      status: 'pending',
      origin: 'watch',
      summary: 'Buy two tickets?',
      proposedAction: 'Buy two tickets',
      sourceRef: 'watch:tickets',
      conversationId: null,
      snoozedUntil: null,
      acceptedTaskId: null,
      expiresAt: new Date(now + 48 * HOUR),
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(6),
    });
    await put('suggestions', {
      id: randomUUID(),
      agentId,
      status: 'dismissed',
      origin: 'watch',
      summary: 'Dismissed idea',
      proposedAction: 'Nothing',
      sourceRef: 'watch:dismissed',
      conversationId: null,
      snoozedUntil: null,
      acceptedTaskId: null,
      expiresAt: new Date(now + 48 * HOUR),
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(6),
    });
  }

  async function runJob(): Promise<string | undefined> {
    const { task: created } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'briefing.compose' } },
    });
    const result = await executeTask(deps, created.id);
    expect(result.outcome, result.detail).toBe('done');
    return result.detail;
  }

  async function notices() {
    const marker = await store.doc('notificationConversations', agentId).get();
    if (!marker.exists) return [];
    const rows = await store
      .collection('messages')
      .where('conversationId', '==', marker.get('conversationId'))
      .get();
    return rows.docs.map((doc) => doc.data());
  }

  it('posts the digest from the same inputs as PostgreSQL and proposes each upcoming date once', async () => {
    await seedDay();

    // The task detail is truncated, so only its start is compared.
    expect(await runJob()).toContain(
      'briefing: delivered — 1 mail highlight(s) of 2, 1 upcoming date(s), 1 suggestion(s), ' +
        '1 needing attention, 1 awaiting approval, 0 calendar event(s) (0 conflict(s), 0 salient), ' +
        '1 goal delta(s)',
    );
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('Dentist: "Your cleaning appointment"');
    expect(prompt).toContain('- Learn to sail (active) — next: Book a lesson');
    expect(prompt).toContain('- Concert tickets: Tickets went on sale');
    expect(prompt).toContain('- Book flights: Stopped: Book flights needs a decision');
    expect(prompt).toContain('- A7: Approve A7');
    expect(prompt).toContain('- Buy two tickets?');
    for (const excluded of [
      'Outside the window',
      'Archived stall',
      'Stale stall',
      'Foreign',
      'B2',
      'C3',
      'Dismissed idea',
    ])
      expect(prompt).not.toContain(excluded);

    const [notice] = await notices();
    expect(notice?.text).toContain('A dentist visit is coming up and one approval is waiting.');
    const parts = (notice?.parts ?? []) as Array<{ type: string; suggestionId?: string }>;
    const suggestionPart = parts.find((part) => part.type === 'suggestion');
    const bookingSourceRef = `booking:${emailBookingKey(agentId, 'dentist-cleaning-appointment')}:1:event_start:${new Date(now + 48 * HOUR).toISOString().slice(0, 10)}`;
    const suggestionId = suggestionIdFor(agentId, bookingSourceRef);
    expect(suggestionPart?.suggestionId).toBe(suggestionId);
    expect(suggestionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const suggestion = (await store.doc('suggestions', suggestionId).get()).data();
    expect(suggestion).toMatchObject({
      agentId,
      status: 'pending',
      origin: 'briefing',
      sourceRef: bookingSourceRef,
    });

    // The next day's run sees the same mail: the digest repeats, the question does not.
    expect(await runJob()).toContain('0 suggestion(s)');
    const suggestions = await store
      .collection('suggestions')
      .where('sourceRef', '==', bookingSourceRef)
      .get();
    expect(suggestions.size).toBe(1);
  });

  it('says nothing on a quiet day', async () => {
    expect(await runJob()).toBe('briefing: nothing to report');
    expect(await notices()).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it('never re-proposes a source an imported suggestion already answered', async () => {
    const repository = persistence.suggestions;
    if (!repository) throw new Error('missing suggestion repository');
    await put('suggestions', {
      id: randomUUID(),
      agentId,
      status: 'dismissed',
      origin: 'briefing',
      summary: 'Imported',
      proposedAction: 'Imported',
      sourceRef: 'mail-imported:0',
      conversationId: null,
      snoozedUntil: null,
      acceptedTaskId: null,
      expiresAt: new Date(now + HOUR),
      createdAt: hoursAgo(10),
      updatedAt: hoursAgo(10),
    });
    const input = {
      agentId,
      summary: 'Proposal',
      proposedAction: 'Do it',
      sourceRef: 'mail-imported:0',
      origin: 'briefing',
      expiresAt: new Date(now + HOUR),
    };
    expect(await repository.create(input)).toBeNull();
    const fresh = { ...input, sourceRef: 'mail-fresh:0' };
    const raced = await Promise.all([repository.create(fresh), repository.create(fresh)]);
    expect(raced.filter(Boolean)).toHaveLength(1);
  }, 30_000);

  it('refreshes a cancelled booking only when its authenticated source version changes', async () => {
    const at = new Date(now + 60 * 60 * 1000);
    const bookingIdentity = `cancellation-${randomUUID()}`;
    const bookingKey = emailBookingKey(agentId, bookingIdentity);
    const eventId = `calendar-event-${randomUUID()}`;
    const firstDate = new Date(at.getTime() + 5 * 24 * HOUR).toISOString().slice(0, 10);
    let eventDate = firstDate;
    const cancellationEvent = {
      summary: 'Cancelled appointment',
      description: `Booking reference ${bookingIdentity}`,
      start: eventDate,
      end: eventDate,
      calendar: 'Primary',
      calendarId: 'primary',
      allDay: true,
      eventId,
    };
    const calendarReader = async (window: { timeMin: Date; timeMax: Date }) => ({
      complete: true,
      events:
        window.timeMax.getTime() - window.timeMin.getTime() > 2 * 24 * HOUR
          ? [{ ...cancellationEvent, start: eventDate, end: eventDate }]
          : [],
    });
    const runPortable = (runAt: Date) =>
      runBriefing(
        {
          db: deps.db,
          router: deps.router,
          calendarCancellationEnabled: true,
          calendarReader,
          persistence,
        },
        { agentId, now: runAt },
      );

    await put('emailBookingOccurrences', {
      id: bookingKey,
      agentId,
      bookingKey,
      lifecycle: 'cancelled',
      dates: [
        {
          iso: firstDate,
          what: 'Cancelled appointment',
          dateRole: 'event_start',
          precision: 'date',
          civilDate: firstDate,
          lifecycle: 'cancelled',
          bookingIdentity,
        },
      ],
      sourceChannelMessageId: `gmail:${randomUUID()}`,
      sourceReceivedAt: at,
      sourceAuthenticated: true,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });

    const first = await runPortable(at);
    expect(first.bookingCancellations).toBe(1);
    expect(first.suggested).toBe(1);
    const sourceDigest = (value: string) =>
      createHash('sha256').update(value).digest('hex').slice(0, 16);
    const firstSourceRef = `booking:${bookingKey}:1:cancel:${sourceDigest(bookingIdentity)}:${sourceDigest(eventId)}`;
    const firstSuggestion = await store
      .collection('suggestions')
      .where('agentId', '==', agentId)
      .where('sourceRef', '==', firstSourceRef)
      .limit(1)
      .get();
    expect(firstSuggestion.size).toBe(1);
    const firstSuggestionDoc = firstSuggestion.docs[0];
    if (!firstSuggestionDoc) throw new Error('expected first cancellation suggestion');
    await firstSuggestionDoc.ref.update({ status: 'dismissed' });

    const refreshed = await runPortable(new Date(at.getTime() + 2 * 60 * 1000));
    expect(refreshed.bookingCancellations).toBe(0);
    expect(refreshed.suggested).toBe(0);

    const secondDate = new Date(at.getTime() + 9 * 24 * HOUR).toISOString().slice(0, 10);
    eventDate = secondDate;
    await store.doc('emailBookingOccurrences', bookingKey).update({
      dates: [
        {
          iso: secondDate,
          what: 'Rescheduled cancelled appointment',
          dateRole: 'event_start',
          precision: 'date',
          civilDate: secondDate,
          lifecycle: 'cancelled',
          bookingIdentity,
        },
      ],
      version: 2,
      updatedAt: new Date(at.getTime() + 3 * 60 * 1000),
    });
    const newVersion = await runPortable(new Date(at.getTime() + 3 * 60 * 1000));
    expect(newVersion.bookingCancellations).toBe(1);
    expect(newVersion.suggested).toBe(1);
    const secondSourceRef = firstSourceRef.replace(':1:cancel:', ':2:cancel:');
    const secondSuggestion = await store
      .collection('suggestions')
      .where('agentId', '==', agentId)
      .where('sourceRef', '==', secondSourceRef)
      .limit(1)
      .get();
    expect(secondSuggestion.size).toBe(1);
  });
});
