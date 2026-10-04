import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence, PulseRepository } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const HOUR = 3_600_000;
const SPACE = { provider: 'synthetic', model: 'pulse-fixture', dimensions: 1536, revision: '1' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore pulse job', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let deps: ExecutorDeps;
  let pulse: PulseRepository;
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * HOUR);

  beforeEach(async () => {
    store = emulatorStore();
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
    if (!persistence.pulse) throw new Error('missing pulse repository');
    pulse = persistence.pulse;
    deps = {
      db: unavailable('db') as Db,
      router: unavailable('router') as ExecutorDeps['router'],
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence,
    };
    await put('agents', {
      id: agentId,
      name: 'Ada',
      email: 'ada@assistant.test',
      timezone: 'UTC',
      createdAt: at(-1000),
      updatedAt: at(-1000),
    });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function put(collection: string, row: Record<string, unknown> & { id: string }) {
    await store.doc(collection, row.id).set(encodeRecord(row));
    return row.id;
  }

  async function commitment(
    title: string,
    dueInHours: number,
    extra: Record<string, unknown> = {},
  ) {
    return put('commitments', {
      id: randomUUID(),
      agentId,
      conversationId: randomUUID(),
      kind: 'promise',
      title,
      details: '',
      nextAction: 'Send the draft',
      status: 'open',
      dueAt: at(dueInHours),
      snoozedUntil: null,
      resolvedAt: null,
      resolution: null,
      confidence: '0.9',
      contentHash: randomUUID(),
      createdAt: at(-10),
      updatedAt: at(-10),
      ...extra,
    });
  }

  async function mail(
    channelMessageId: string,
    importance: number,
    extra: Record<string, unknown> = {},
  ) {
    return put('emailIngest', {
      id: randomUUID(),
      agentId,
      conversationId: null,
      channelMessageId,
      category: 'personal',
      importance,
      reason: 'internal rationale',
      fromEmail: 'landlord@example.test',
      fromName: 'Landlord',
      subject: `Lease question ${channelMessageId}`,
      contentTrust: 'external',
      authenticated: true,
      actionable: true,
      dates: [],
      triaged: true,
      extractedAt: null,
      createdAt: at(-4),
      updatedAt: at(-4),
      ...extra,
    });
  }

  async function runJob(): Promise<string | undefined> {
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'pulse.check' } },
    });
    const result = await executeTask(deps, task.id);
    expect(result.outcome).toBe('done');
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

  it('says the single most pressing thing once, then holds for the pacing gap', async () => {
    await commitment('Quarterly report', 3);
    await commitment('Snoozed report', 3, { snoozedUntil: at(5) });
    await mail('mail-handled', 5);
    await put('tasks', {
      id: randomUUID(),
      agentId,
      type: 'adhoc',
      trust: 'owner',
      status: 'done',
      externalEventId: 'mail-handled',
      createdAt: at(-1),
      updatedAt: at(-1),
    });
    await mail('mail-open', 4);
    await mail('mail-unimportant', 2);
    await mail('mail-not-actionable', 5, { actionable: false });
    // Just arrived: the arrival alert is still the latest word on it.
    await mail('mail-fresh', 5, { createdAt: at(-1), updatedAt: at(-1) });

    expect(await runJob()).toBe('pulse: mail-action delivered with a suggestion, 2 candidate(s)');
    const [notice] = await notices();
    expect(notice?.text).toBe('Still open: “Lease question mail-open” from Landlord');
    const suggestion = await store
      .collection('suggestions')
      .where('sourceRef', '==', 'pulse:mail-open')
      .get();
    expect(suggestion.size).toBe(1);
    expect(suggestion.docs[0]?.get('origin')).toBe('pulse');

    const moments = await store.collection('proactiveMoments').get();
    expect(moments.docs.map((doc) => [doc.get('momentKey'), doc.get('pinged')])).toEqual([
      ['mail-action:mail-open', false],
    ]);

    // Inside the hour after speaking, the pulse stays quiet.
    expect(await runJob()).toBe('pulse: quiet (min-gap)');
    expect(await notices()).toHaveLength(1);
  });

  it('delivers the next moment after the gap and never repeats one already said', async () => {
    await commitment('Quarterly report', 3);
    await put('proactiveMoments', {
      id: randomUUID(),
      agentId,
      kind: 'mail-action',
      momentKey: 'mail-action:mail-open',
      summary: 'Imported from PostgreSQL',
      pinged: true,
      deliveredAt: at(-3),
    });
    await mail('mail-open', 5);

    // The stronger mail candidate was already said outside the gap. It must
    // not hide the new commitment, and it must not be announced again.
    expect(await runJob()).toBe('pulse: commitment-due delivered, 2 candidate(s)');
    expect((await notices()).map((row) => row.text)).toEqual([
      expect.stringMatching(/^"Quarterly report" is due .* — next: Send the draft\.$/),
    ]);
  });

  it("honours the owner's own daily cap", async () => {
    await commitment('Quarterly report', 3);
    await store.doc('notificationPrefs', agentId).set({ agentId, ambientDailyCap: 0 });
    expect(await runJob()).toBe('pulse: quiet (daily-cap)');
    expect(await notices()).toEqual([]);
  });

  // Two transactions contend for one moment; the emulator's shared lock manager
  // can take several seconds to settle them, as in the Notifications race test.
  it('admits each owner notice once under concurrency', { timeout: 30_000 }, async () => {
    const notice = {
      agentId,
      now: new Date(now),
      observationFence: await pulse.observationFence(agentId),
      pacing: { gapSince: at(-1), windowSince: at(-24), dailyCap: 6 },
      moment: { kind: 'commitment-due', key: 'commitment-due:x', summary: 'x' },
      notice: { text: 'x', extraParts: [] },
    };
    const admitted = await Promise.all([pulse.admitNotice(notice), pulse.admitNotice(notice)]);
    expect(admitted.map((row) => row.status).sort()).toEqual(['already-said', 'persisted']);
    const persisted = admitted.find((row) => row.status === 'persisted');
    if (persisted?.status !== 'persisted') throw new Error('Fixture admission failed');
    await pulse.markPinged(agentId, persisted.momentId, true);
    expect(await pulse.deliveredSince(agentId, at(-1))).toBe(1);
    expect(await pulse.momentKeys(agentId, 'commitment-due')).toEqual(['commitment-due:x']);
    expect(await notices()).toHaveLength(1);
  });

  it('keeps the calendar snapshot in step with successful reads', async () => {
    const event = (eventId: string, start: string) => ({
      calendarId: 'primary',
      eventId,
      iCalUID: null,
      summary: `Event ${eventId}`,
      start,
      end: start,
      status: 'confirmed',
      attendeeResponseHash: {},
    });
    // An imported row keeps its id and is updated in place.
    const importedId = await put('calendarEventSnapshots', {
      id: randomUUID(),
      agentId,
      ...event('imported', '2026-10-01T09:00:00Z'),
      updatedAt: at(-2),
    });
    await put('calendarEventSnapshots', {
      id: randomUUID(),
      agentId,
      ...event('stale', '2026-09-01T09:00:00Z'),
      updatedAt: at(-30),
    });
    await put('calendarEventSnapshots', {
      id: randomUUID(),
      agentId,
      ...event('cancelled', '2026-10-02T09:00:00Z'),
      updatedAt: at(-2),
    });

    await pulse.syncCalendarSnapshot(agentId, {
      cancelled: [{ calendarId: 'primary', eventId: 'cancelled' }],
      seen: [event('imported', '2026-10-01T10:00:00Z'), event('new', '2026-10-03T09:00:00Z')],
      staleBefore: at(-24),
      now: new Date(now),
    });
    const rows = await pulse.calendarSnapshot(agentId);
    expect(rows.map((row) => [row.eventId, row.start]).sort()).toEqual([
      ['imported', '2026-10-01T10:00:00Z'],
      ['new', '2026-10-03T09:00:00Z'],
    ]);
    expect((await store.doc('calendarEventSnapshots', importedId).get()).get('start')).toBe(
      '2026-10-01T10:00:00Z',
    );
  });
});
