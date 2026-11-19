import { randomUUID } from 'node:crypto';
import {
  assertPostgresInstallationOwner,
  createPostgresPulseAdmissionRepository,
  emailBookingOccurrences,
  emailIngest,
  messages,
  proactiveMoments,
} from '@assistant/db';
import { FirestorePulseRepository } from '@assistant/firestore';
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

const start = new Date('2026-11-18T08:00:00Z');
const end = new Date('2026-11-18T11:00:00Z');
const between = new Date('2026-11-18T09:30:00Z');
const elapsed = { fromMs: start.getTime(), toMs: end.getTime() };

type Alert = Parameters<typeof publishSweepOutage>[3];
interface Fixture {
  read(at: Date): Promise<{ state: string }>;
  record(at: Date, failed?: string[]): Promise<SweepRecovery | undefined>;
  alert(notify: Alert): Promise<string>;
  publish(recovery: SweepRecovery): Promise<{ status: string }>;
  acknowledge(recovery: SweepRecovery): Promise<void>;
  seed(): Promise<void>;
  saved(): Promise<{ messages: Array<string | null>; keys: string[] }>;
  close(): Promise<void>;
}

function records(agentId: string) {
  const mail = [
    { channelMessageId: 'gmail:cancel', subject: 'Saturday booking', importance: 1 },
    { channelMessageId: 'gmail:move', subject: 'Tuesday booking', importance: 1 },
    { channelMessageId: 'gmail:reported', subject: 'Important notice', importance: 5 },
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

async function postgres(): Promise<Fixture> {
  const { db, close } = await createIsolatedTestDatabase();
  const agentId = await assertPostgresInstallationOwner(db);
  return {
    read: (at) => readPostgresSweepHealth(db, at),
    record: (at, failed = []) => recordPostgresSweepHeartbeat(db, at, at, failed, []),
    alert: (notify) =>
      publishSweepOutage(
        createPostgresPulseAdmissionRepository(db),
        agentId,
        start.toISOString(),
        notify,
        between,
      ),
    publish: (recovery) => publishPostgresSweepRecovery(db, recovery, end),
    acknowledge: (recovery) => acknowledgePostgresSweepRecovery(db, recovery),
    async seed() {
      const { mail, bookings } = records(agentId);
      await db.insert(emailIngest).values(mail);
      await db.insert(emailBookingOccurrences).values(bookings);
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
    alert: (notify) =>
      publishSweepOutage(
        new FirestorePulseRepository(store),
        agentId,
        start.toISOString(),
        notify,
        between,
      ),
    publish: (recovery) => publishFirestoreSweepRecovery(store, agentId, recovery, end),
    acknowledge: (recovery) => acknowledgeFirestoreSweepRecovery(store, recovery),
    async seed() {
      const { mail, bookings } = records(agentId);
      const batch = store.db.batch();
      for (const row of mail) batch.create(store.doc('emailIngest', row.id), row);
      for (const row of bookings) batch.create(store.doc('emailBookingOccurrences', row.id), row);
      await batch.commit();
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
      'records one alert and one grounded recovery digest over a three-hour gap',
      async () => {
        const f = await fixture();
        try {
          expect((await f.read(start)).state).toBe('missing');
          expect(await f.record(start)).toBeUndefined();
          expect((await f.read(new Date(start.getTime() + 1_799_999))).state).toBe('healthy');
          expect((await f.read(new Date(start.getTime() + 1_800_000))).state).toBe('stale');
          const notify = vi.fn(async (_input: Parameters<Alert>[0]) => undefined);
          expect((await Promise.all([f.alert(notify), f.alert(notify)])).sort()).toEqual([
            'already-said',
            'persisted',
          ]);
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ urgency: 'interrupt' }),
          );

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
              'From the authenticated mail available for that period:',
              '- Booking cancellation · Saturday booking',
              '- Booking rescheduled · Tuesday booking',
              '- Important mail · Important notice',
            ].join('\n'),
          );
        } finally {
          await f.close();
        }
      },
      90_000,
    );
  });
}
