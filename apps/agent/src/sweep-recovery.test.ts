import { randomUUID } from 'node:crypto';
import {
  assertPostgresInstallationOwner,
  calendarEventSnapshots,
  createPostgresNotificationOutboxRepository,
  createPostgresPulseAdmissionRepository,
  emailBookingOccurrences,
  emailIngest,
  messages,
  proactiveMoments,
  recordPostgresCalendarRecovery,
} from '@assistant/db';
import {
  FirestoreNotificationOutboxRepository,
  FirestorePulseRepository,
} from '@assistant/firestore';
import {
  type CalendarRecoveryObservation,
  calendarRecoveryFact,
  calendarRecoveryHash,
  type NotificationOutboxRepository,
  sendNotificationOutboxLeg,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';
import {
  acknowledgeFirestoreSweepRecovery,
  acknowledgePostgresSweepRecovery,
  readFirestoreSweepHealth,
  readPostgresSweepHealth,
  recordFirestoreSweepHeartbeat,
  recordPostgresSweepHeartbeat,
  type SweepRecovery,
} from './sweep-heartbeat.js';
import {
  publishFirestoreSweepRecovery,
  publishPostgresSweepRecovery,
  publishSweepOutage,
} from './sweep-recovery.js';

import {
  recordFirestoreWatchdogEpisode,
  recordPostgresWatchdogEpisode,
  type WatchdogEpisode,
  type WatchdogObservation,
  watchdogObservation,
} from './watchdog-episode.js';

const start = new Date('2026-11-18T08:00:00Z');
const end = new Date('2026-11-18T11:00:00Z');
const between = new Date('2026-11-18T09:30:00Z');
const elapsed = { fromMs: start.getTime(), toMs: end.getTime() };

type Alert = Parameters<typeof publishSweepOutage>[3];
interface Fixture {
  read(at: Date): Promise<{ state: string }>;
  record(at: Date, failed?: string[]): Promise<SweepRecovery | undefined>;
  alert(episode: WatchdogEpisode, notify: Alert): Promise<string>;
  episode(observation: WatchdogObservation, at: Date): Promise<WatchdogEpisode | null>;
  push(provider: () => void): Alert;
  publish(recovery: SweepRecovery): Promise<{ status: string }>;
  acknowledge(recovery: SweepRecovery): Promise<void>;
  seed(): Promise<void>;
  seedCalendar(complete: boolean): Promise<void>;
  saved(): Promise<{ messages: Array<string | null>; keys: string[] }>;
  close(): Promise<void>;
}

function durablePush(
  repo: NotificationOutboxRepository,
  agentId: string,
  provider: () => void,
): Alert {
  return async ({ deliveryKey, urgency, purpose, text }) => {
    expect(urgency).toBe('interrupt');
    expect(purpose).toBe('watchdog-outage');
    return sendNotificationOutboxLeg(
      repo,
      {
        agentId,
        deliveryKey,
        legKey: 'push:fixture-device',
        adapter: 'push',
        destination: { device: 'fixture-device' },
        payload: { text },
        now: between,
      },
      async () => {
        provider();
        return { status: 'delivered' };
      },
    );
  };
}

function records(agentId: string) {
  const mail = [
    { channelMessageId: 'gmail:cancel', subject: 'Saturday booking', importance: 1 },
    { channelMessageId: 'gmail:move', subject: 'Tuesday booking', importance: 1 },
    { channelMessageId: 'gmail:reported', subject: 'Important notice', importance: 5 },
    { channelMessageId: 'gmail:secret', subject: 'Door code ABC123', importance: 5 },
    {
      channelMessageId: 'gmail:token',
      subject: 'Access https://example.invalid/reset?token=sensitive-token',
      importance: 5,
    },
    {
      channelMessageId: 'gmail:identity',
      subject: 'Hotel changed — qr62xx',
      dates: [{ bookingIdentity: 'QR62XX' }],
      importance: 5,
    },
    {
      channelMessageId: 'gmail:old',
      subject: 'Previous important notice',
      importance: 5,
      providerReceivedAt: start,
    },
    {
      channelMessageId: 'gmail:later',
      subject: 'Later important notice',
      importance: 5,
      providerReceivedAt: new Date(end.getTime() + 1),
    },
    {
      channelMessageId: 'gmail:untrusted',
      subject: 'Untrusted important notice',
      importance: 5,
      authenticated: false,
    },
  ].map((row) => ({
    id: randomUUID(),
    agentId,
    fromEmail: 'example@example.invalid',
    authenticated: true,
    createdAt: end,
    providerReceivedAt: between,
    ...row,
  }));
  const bookings = Object.entries({ 'gmail:cancel': 'cancelled', 'gmail:move': 'rescheduled' }).map(
    ([sourceChannelMessageId, lifecycle]) => ({
      id: randomUUID(),
      agentId,
      bookingKey: `synthetic-${lifecycle}`,
      lifecycle,
      dates: [],
      sourceChannelMessageId,
      sourceReceivedAt: between,
      sourceAuthenticated: true,
      version: 2,
    }),
  );
  return { mail, bookings };
}

function calendarRecords(agentId: string) {
  const eventStart = '2026-11-21T15:00:00Z';
  const examples = [
    { eventId: 'moved', summary: 'Training session', kind: 'moved' as const, at: between },
    { eventId: 'cancelled', summary: 'Workshop', kind: 'cancelled' as const, at: between },
    { eventId: 'already-told', summary: 'Already reported', kind: 'moved' as const, at: between },
    { eventId: 'old', summary: 'Before the gap', kind: 'cancelled' as const, at: start },
    {
      eventId: 'unverified',
      summary: 'Missing without confirmation',
      kind: 'cancelled' as const,
      at: between,
    },
  ];
  const key = (row: (typeof examples)[number]) =>
    `calendar-${row.kind}:fixture-calendar:${row.eventId}${row.kind === 'moved' ? ':' + eventStart : ''}`;
  const snapshots = examples.map(({ eventId, summary }) => ({
    id: randomUUID(),
    agentId,
    calendarId: 'fixture-calendar',
    eventId,
    summary,
    start: eventStart,
    end: '2026-11-21T16:00:00Z',
    updatedAt: start,
  }));
  const observations: CalendarRecoveryObservation[] = examples
    .filter((row) => row.eventId !== 'unverified')
    .map((row) => ({
      event: calendarRecoveryHash('fixture-calendar', row.eventId),
      moment: calendarRecoveryHash(key(row)),
      matchingFact: calendarRecoveryFact(row.kind, row.summary, eventStart),
      kind: row.kind,
      observedAt: row.at.getTime(),
    }));
  const told = examples[2];
  if (!told) throw new Error('Missing stored observation fixture');
  const delivered = {
    id: randomUUID(),
    agentId,
    kind: 'calendar-moved',
    momentKey: key(told),
    summary: told.summary,
    deliveredAt: between,
  };
  const source = {
    id: randomUUID(),
    agentId,
    fromEmail: 'example@example.invalid',
    authenticated: true,
    subject: 'Provider notice for training session',
    channelMessageId: 'gmail:calendar-move',
    importance: 5,
    createdAt: end,
    providerReceivedAt: between,
  };
  const booking = {
    id: randomUUID(),
    agentId,
    bookingKey: 'calendar-move',
    lifecycle: 'rescheduled',
    dates: [{ what: 'Training session', iso: eventStart, dateRole: 'event_start' }],
    sourceChannelMessageId: source.channelMessageId,
    sourceReceivedAt: between,
    sourceAuthenticated: true,
    version: 1,
  };
  return { snapshots, observations, delivered, source, booking };
}

async function postgres(): Promise<Fixture> {
  const { db, close } = await createIsolatedTestDatabase();
  const agentId = await assertPostgresInstallationOwner(db);
  return {
    read: (at) => readPostgresSweepHealth(db, at),
    record: (at, failed = []) => recordPostgresSweepHeartbeat(db, at, at, failed, []),
    alert: (episode, notify) =>
      publishSweepOutage(
        createPostgresPulseAdmissionRepository(db),
        agentId,
        episode,
        notify,
        between,
      ),
    episode: (observation, at) => recordPostgresWatchdogEpisode(db, agentId, observation, at),
    push: (provider) =>
      durablePush(createPostgresNotificationOutboxRepository(db), agentId, provider),
    publish: (recovery) => publishPostgresSweepRecovery(db, recovery, end),
    acknowledge: (recovery) => acknowledgePostgresSweepRecovery(db, recovery),
    async seed() {
      const { mail, bookings } = records(agentId);
      await db.insert(emailIngest).values(mail);
      await db.insert(emailBookingOccurrences).values(bookings);
    },
    async seedCalendar(complete) {
      const { snapshots, observations, delivered, source, booking } = calendarRecords(agentId);
      await db.insert(calendarEventSnapshots).values(snapshots);
      await db.insert(proactiveMoments).values(delivered);
      await db.insert(emailIngest).values(source);
      await db.insert(emailBookingOccurrences).values(booking);
      await recordPostgresCalendarRecovery(db, agentId, null, between, complete, observations);
    },
    async saved() {
      return {
        messages: (await db.select({ text: messages.text }).from(messages)).map((row) => row.text),
        keys: (await db.select({ key: proactiveMoments.momentKey }).from(proactiveMoments)).map(
          (row) => row.key,
        ),
      };
    },
    close,
  };
}

async function firestore(): Promise<Fixture> {
  const store = emulatorStore(() => end);
  const agentId = randomUUID();
  await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
  return {
    read: (at) => readFirestoreSweepHealth(store, agentId, at),
    record: (at, failed = []) => recordFirestoreSweepHeartbeat(store, agentId, at, at, failed, []),
    alert: (episode, notify) =>
      publishSweepOutage(new FirestorePulseRepository(store), agentId, episode, notify, between),
    episode: (observation, at) => recordFirestoreWatchdogEpisode(store, agentId, observation, at),
    push: (provider) =>
      durablePush(new FirestoreNotificationOutboxRepository(store, agentId), agentId, provider),
    publish: (recovery) => publishFirestoreSweepRecovery(store, agentId, recovery, end),
    acknowledge: (recovery) => acknowledgeFirestoreSweepRecovery(store, recovery),
    async seed() {
      const { mail, bookings } = records(agentId);
      const batch = store.db.batch();
      for (const row of mail) batch.create(store.doc('emailIngest', row.id), row);
      for (const row of bookings) batch.create(store.doc('emailBookingOccurrences', row.id), row);
      await batch.commit();
    },
    async seedCalendar(complete) {
      const { snapshots, observations, delivered, source, booking } = calendarRecords(agentId);
      const batch = store.db.batch();
      for (const row of snapshots) batch.create(store.doc('calendarEventSnapshots', row.id), row);
      batch.create(store.doc('proactiveMoments', delivered.id), delivered);
      batch.create(store.doc('emailIngest', source.id), source);
      batch.create(store.doc('emailBookingOccurrences', booking.id), booking);
      await batch.commit();
      await new FirestorePulseRepository(store).recordCalendarRecovery(
        agentId,
        null,
        between,
        complete,
        observations,
      );
    },
    async saved() {
      return {
        messages: (await store.collection('messages').get()).docs.map((d) => d.get('text')),
        keys: (await store.collection('proactiveMoments').get()).docs.map((d) =>
          d.get('momentKey'),
        ),
      };
    },
    close: () => disposeStore(store),
  };
}

for (const [driver, fixture] of [
  ['PostgreSQL', postgres],
  ['Firestore', firestore],
] as const) {
  describe(driver, () => {
    it.skipIf(driver === 'Firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'recovers only confirmed withheld calendar changes and deduplicates matching mail',
      async () => {
        for (const complete of [true, false]) {
          const f = await fixture();
          try {
            await f.seedCalendar(complete);
            expect(await f.publish(elapsed)).toMatchObject({ status: 'persisted' });
            const digest = (await f.saved()).messages.find((text) =>
              text?.startsWith('While I was away'),
            );
            expect(digest).toContain('Calendar move · Training session');
            expect(digest).toContain('Calendar cancellation · Workshop');
            for (const excluded of [
              'Provider notice for training session',
              'Already reported',
              'Before the gap',
              'Missing without confirmation',
            ])
              expect(digest).not.toContain(excluded);
            expect(digest?.includes('No complete Calendar read was recorded')).toBe(!complete);
          } finally {
            await f.close();
          }
        }
      },
      90_000,
    );
    it.skipIf(driver === 'Firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'records one alert and one grounded recovery digest over a three-hour gap',
      async () => {
        const f = await fixture();
        try {
          expect((await f.read(start)).state).toBe('missing');
          expect(await f.record(start)).toBeUndefined();
          expect((await f.read(new Date(start.getTime() + 1_799_999))).state).toBe('healthy');
          expect((await f.read(new Date(start.getTime() + 1_800_000))).state).toBe('stale');
          const episode = await f.episode(
            { kind: 'stale', reason: 'sweep', sweepCompletedAt: start.toISOString() },
            between,
          );
          if (!episode) throw new Error('Missing sweep outage episode');
          const provider = vi.fn();
          const push = f.push(provider);
          expect(
            (await Promise.all([f.alert(episode, push), f.alert(episode, push)])).sort(),
          ).toEqual(['already-said', 'persisted']);
          expect(provider).toHaveBeenCalledOnce();

          // The first returning sweep fails. A later healthy pass retains the
          // original gap while concurrent digest attempts race at publication.
          expect(await f.record(end, ['runDueSchedules'])).toEqual(elapsed);
          const later = new Date(end.getTime() + 60_000);
          expect(await f.record(later)).toEqual(elapsed);
          expect(await f.record(end)).toBeUndefined();
          await f.seed();
          const result = await Promise.all([f.publish(elapsed), f.publish(elapsed)]);
          expect(result.map((row) => row.status).sort()).toEqual(['already-said', 'persisted']);
          await f.acknowledge(elapsed);
          expect(await f.record(new Date(later.getTime() + 60_000))).toBeUndefined();

          const saved = await f.saved();
          expect(saved.keys.sort()).toEqual([
            `sweep-recovery:${elapsed.fromMs}`,
            `watchdog-outage:${elapsed.fromMs}`,
          ]);
          expect(saved.messages).toHaveLength(2);
          const digest = saved.messages.find((text) => text?.startsWith('While I was away'));
          expect(digest).toBe(
            [
              'While I was away',
              'Scheduled checks resumed after a gap of 180 minutes.',
              'No complete Calendar read was recorded during this gap.',
              'From the authenticated mail available for that period:',
              '- Booking cancellation · Saturday booking',
              '- Booking rescheduled · Tuesday booking',
              '- Important mail · Hotel changed — [hidden]',
              '- Important mail · Important notice',
              '- Important mail · [hidden]',
              '- Important mail · [hidden]',
            ].join('\n'),
          );
        } finally {
          await f.close();
        }
      },
      90_000,
    );
    it.skipIf(driver === 'Firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'replays durable push after a briefing-only outage and dedupes an overlapping sweep outage',
      async () => {
        const f = await fixture();
        try {
          for (const state of ['disabled', 'missing', 'awaiting_first_run']) {
            expect(watchdogObservation({ state: 'healthy', briefing: { state } })).toEqual({
              kind: 'recovered',
            });
          }
          const observation = watchdogObservation({
            state: 'healthy',
            briefing: { state: 'stale' },
          });
          if (!observation) throw new Error('Missing briefing outage observation');
          const episode = await f.episode(observation, start);
          if (!episode) throw new Error('Missing briefing outage episode');
          expect(episode.reason).toBe('briefing');
          const interrupted = vi.fn(async () => {
            throw new Error('Stopped before preparing push');
          });
          await expect(f.alert(episode, interrupted)).rejects.toThrow(
            'Stopped before preparing push',
          );
          expect((await f.saved()).messages).toHaveLength(1);

          const both = watchdogObservation({
            state: 'stale',
            completedAt: start.toISOString(),
            briefing: { state: 'stale' },
          });
          if (!both) throw new Error('Missing overlapping outage observation');
          expect(await f.episode(both, between)).toEqual(episode);
          const provider = vi.fn();
          const push = f.push(provider);
          expect(await f.alert(episode, push)).toBe('already-said');
          expect(await f.alert(episode, push)).toBe('already-said');
          expect(provider).toHaveBeenCalledOnce();
          expect(await f.episode(observation, between)).toEqual(episode);
          expect((await f.saved()).messages).toEqual([
            'The daily briefing is overdue. No scheduled briefing has completed within 26 hours.',
          ]);

          expect(await f.episode({ kind: 'recovered' }, end)).toBeNull();
          expect(await f.episode(observation, between)).toBeNull();
          const again = await f.episode(observation, new Date(end.getTime() + 1000));
          expect(again?.key).toBeDefined();
          expect(again?.key).not.toBe(episode.key);
        } finally {
          await f.close();
        }
      },
      90_000,
    );
  });
}
