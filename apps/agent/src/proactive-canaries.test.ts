import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import {
  assessProactiveCanaries,
  proactiveCanaryProblems,
} from '@assistant/core/proactive/pipeline-health';
import {
  agents,
  ambientSnapshots,
  assertPostgresInstallationOwner,
  createPostgresExecutionPersistence,
  createPostgresScheduleRepository,
  type Db,
  emailIngest,
  googleCalendarConnections,
  locationPings,
  notificationPrefs,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import {
  type ExecutionPersistence,
  GOOGLE_CALENDAR_READ_SCOPE,
  type GoogleCalendarConnectionState,
  type PhoneCalendarSnapshotInput,
  PULSE_INTERVAL_MS,
  PULSE_SCHEDULE,
  type ScheduleRepository,
} from '@assistant/persistence';
import type { ApnsClient } from '@assistant/tools/modules/push';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { runAssistantHealthMonitor } from '../../../packages/core/src/workflow/health-monitor.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import {
  drainPushNotificationOutbox,
  healthCanaryAdmission,
  notifyOwnerByPush,
  type PushChannelDeps,
} from '../../../packages/modules/src/push/channel.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const HOUR = 60 * 60_000;
const FIX = new Date('2026-11-18T08:00:00.000Z');
const config = loadConfig({
  ASSISTANT_MODULES: 'calendar,sms',
  GOOGLE_OAUTH_CLIENT_ID: 'fixture-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-secret',
  GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'https://example.test/api/oauth/google-calendar/callback',
  MCP_ENC_KEY: 'a'.repeat(64),
  TWILIO_ACCOUNT_SID: 'fixture-sid',
  TWILIO_AUTH_TOKEN: 'fixture-token',
  TWILIO_FROM_NUMBER: '+15550101111',
  OWNER_PHONE: '+15550102222',
});

const source = { lat: '10.0', lng: '20.0', accuracyM: 30, source: 'shortcut', capturedAt: FIX };
const cachedWeather = {
  block: 'synthetic weather',
  flags: { has_weather: true },
  sources: {
    location: { capturedAt: FIX.toISOString() },
    weather: { fetchedAt: FIX.toISOString() },
  },
  computedAt: FIX,
};

interface Fixture {
  owner: string;
  db: Db;
  persistence: ExecutionPersistence;
  schedule: ScheduleRepository;
  weather(): Promise<void>;
  mail(at: Date): Promise<() => Promise<unknown>>;
  prefs(start: number | null, end: number | null, cap: number | null): Promise<unknown>;
  google(state: GoogleCalendarConnectionState): Promise<void>;
  close(): Promise<void>;
}

async function postgres(): Promise<Fixture> {
  const { db, close } = await createIsolatedTestDatabase();
  const owner = await assertPostgresInstallationOwner(db);
  await db.update(agents).set({ timezone: 'UTC' }).where(eq(agents.id, owner));
  return {
    owner,
    db,
    close,
    persistence: createPostgresExecutionPersistence(db),
    schedule: createPostgresScheduleRepository(db),
    async mail(at) {
      const id = randomUUID();
      await db.insert(emailIngest).values({
        id,
        agentId: owner,
        fromEmail: 'sender@example.test',
        channelMessageId: 'synthetic-canary-mail',
        createdAt: at,
        pipelineStage: 'pending_score',
      });
      return () => db.delete(emailIngest).where(eq(emailIngest.id, id));
    },
    prefs(quietStartMin, quietEndMin, ambientDailyCap) {
      const prefs = { quietStartMin, quietEndMin, ambientDailyCap };
      return db
        .insert(notificationPrefs)
        .values({ agentId: owner, ...prefs })
        .onConflictDoUpdate({ target: notificationPrefs.agentId, set: prefs });
    },
    async weather() {
      await db.insert(locationPings).values({ agentId: owner, ...source });
      await db.insert(ambientSnapshots).values({ agentId: owner, ...cachedWeather });
    },
    async google(state) {
      await db
        .insert(googleCalendarConnections)
        .values({ agentId: owner, state })
        .onConflictDoUpdate({
          target: googleCalendarConnections.agentId,
          set: { state },
        });
    },
  };
}

async function firestore(): Promise<Fixture> {
  const store = emulatorStore();
  const owner = randomUUID();
  await seedBudget(store);
  await store
    .doc('agents', owner)
    .set({ id: owner, name: 'Synthetic owner', email: 'owner@example.test', timezone: 'UTC' });
  return {
    owner,
    db: new Proxy(
      {},
      {
        get: () => {
          throw new Error('Unexpected PostgreSQL access');
        },
      },
    ) as Db,
    persistence: createFirestoreExecutionPersistence(store, owner, {
      provider: 'synthetic',
      model: 'canaries',
      dimensions: 1536,
      revision: '1',
    }),
    schedule: new FirestoreScheduleRepository(store),
    async mail(at) {
      const id = randomUUID();
      const ref = store.doc('emailIngest', id);
      await ref.set({
        id,
        agentId: owner,
        fromEmail: 'sender@example.test',
        channelMessageId: 'synthetic-canary-mail',
        createdAt: at,
        pipelineStage: 'pending_score',
      });
      return () => ref.delete();
    },
    prefs(quietStartMin, quietEndMin, ambientDailyCap) {
      return store
        .doc('notificationPrefs', owner)
        .set({ agentId: owner, quietStartMin, quietEndMin, ambientDailyCap });
    },
    async weather() {
      const id = randomUUID();
      await store.doc('locationPings', id).set({ id, agentId: owner, ...source });
      await store.doc('ambientSnapshots', owner).set({ agentId: owner, ...cachedWeather });
    },
    async google(state) {
      await store.doc('googleCalendarConnections', owner).set({ id: owner, agentId: owner, state });
    },
    close: () => disposeStore(store),
  };
}

async function seedPhone(f: Fixture) {
  const sharing = f.persistence.toolExecution?.phoneCalendarSharing;
  if (!sharing) throw new Error('Phone calendar persistence unavailable');
  const calendars = [{ id: 'personal', name: 'Personal', purpose: 'commitments' as const }];
  const publisherId = 'fixture-publisher';
  expect(
    await sharing.apply(
      f.owner,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 0,
        mutationId: 'fixture-enable',
        consentVersion: 1,
        calendars,
      },
      FIX,
    ),
  ).toMatchObject({ ok: true });
  const snapshot: PhoneCalendarSnapshotInput = {
    capturedAt: FIX.toISOString(),
    selectionRevision: 1,
    complete: true,
    truncated: false,
    timeZone: 'UTC',
    calendars,
    timeMin: new Date(FIX.getTime() - 24 * HOUR).toISOString(),
    timeMax: new Date(FIX.getTime() + 24 * HOUR).toISOString(),
    sourceAvailability: [{ calendarId: 'personal', status: 'available', complete: true }],
    events: [],
  };
  expect(
    await sharing.apply(
      f.owner,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      FIX,
    ),
  ).toMatchObject({ ok: true });
  return {
    revoke: () =>
      sharing.apply(f.owner, { command: 'revoke', publisherId, expectedGeneration: 1 }, FIX),
    incomplete: (now: Date) =>
      sharing.apply(
        f.owner,
        {
          command: 'snapshot',
          publisherId,
          expectedGeneration: 1,
          snapshot: {
            ...snapshot,
            capturedAt: now.toISOString(),
            complete: false,
            truncated: true,
            sourceAvailability: [{ calendarId: 'personal', status: 'missing', complete: false }],
          },
        },
        now,
      ),
  };
}

for (const [driver, fixture] of [
  ['PostgreSQL', postgres],
  ['Firestore', firestore],
] as const) {
  describe(driver, () => {
    it.skipIf(driver === 'Firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'checks the local connection, phone and weather freshness and the reserved SMS quota',
      async () => {
        const f = await fixture();
        try {
          const repo = f.persistence.proactiveCanaries;
          if (!repo) throw new Error('Canary repository unavailable');
          const at = (ms: number) => new Date(FIX.getTime() + ms);
          const assess = (ms = 0) => assessProactiveCanaries(repo, f.owner, config, at(ms));
          expect(await assess()).toMatchObject({
            googleCalendar: { state: 'not_configured' },
            phoneCalendar: { state: 'not_configured' },
            weather: { state: 'not_configured' },
            urgentSms: { state: 'within_limit', attempts: 0, limit: 3 },
          });
          const missingPulse = await assessProactiveCanaries(
            { ...repo, pulse: async () => ({ schedule: null, completedAt: null }) },
            f.owner,
            config,
            FIX,
          );
          expect(missingPulse.pulse).toEqual({ state: 'missing' });
          expect(proactiveCanaryProblems(missingPulse)).toContainEqual({
            key: 'pulse',
            detail: 'Pulse schedule is missing.',
          });
          const observerConfig = {
            ...config,
            TWILIO_AUTH_TOKEN: '',
            GOOGLE_OAUTH_CLIENT_SECRET: '',
          };
          const observe = () =>
            assessProactiveCanaries(repo, f.owner, observerConfig, FIX, 'observer');
          expect(await observe()).toMatchObject({
            googleCalendar: { state: 'unverified' },
            urgentSms: { state: 'unverified' },
          });
          const phone = await seedPhone(f);
          await f.weather();
          const connection = {
            id: randomUUID(),
            credentialVersion: 1,
            accessTokenEncrypted: null,
            accessTokenExpiresAt: null,
            refreshLease: null,
            account: { subject: 'synthetic', email: 'owner@example.test' },
            refreshTokenEncrypted: 'sealed',
            scopes: [GOOGLE_CALENDAR_READ_SCOPE],
            status: 'connected' as const,
            connectedAt: FIX.toISOString(),
          };
          const google = {
            version: 1 as const,
            adopted: true,
            ownerId: f.owner,
            revision: 1,
            connection,
            flow: null,
          };
          await f.google(google);
          const sms = f.persistence.smsChannel;
          if (!sms) throw new Error('SMS persistence unavailable');
          for (let i = 1; i <= 3; i++) {
            expect(
              await sms.reserveProactiveAttempt(
                f.owner,
                `sms-attempt:${String(i).repeat(64)}`,
                FIX,
              ),
            ).toBe('reserved');
          }
          expect(await assess()).toMatchObject({
            googleCalendar: { state: 'connected' },
            phoneCalendar: { state: 'fresh' },
            weather: { state: 'fresh' },
            urgentSms: { state: 'at_limit', attempts: 3, limit: 3 },
          });
          expect(await observe()).toMatchObject({
            googleCalendar: { state: 'connected' },
            urgentSms: { state: 'at_limit', attempts: 3 },
          });
          expect((await assess(90 * 60_000)).weather.state).toBe('expired');
          expect((await assess(24 * HOUR - 1)).phoneCalendar.state).toBe('fresh');
          expect(await assess(24 * HOUR)).toMatchObject({
            phoneCalendar: { state: 'expired' },
            urgentSms: { state: 'within_limit', attempts: 0 },
          });
          await f.google({
            ...google,
            connection: { ...connection, status: 'reconnect_required' },
          });
          expect(await phone.incomplete(at(HOUR))).toMatchObject({ ok: true });
          expect((await assess(HOUR)).phoneCalendar).toEqual({
            state: 'incomplete',
            observedAt: at(HOUR).toISOString(),
          });
          await phone.revoke();
          expect(await assess()).toMatchObject({
            googleCalendar: { state: 'expired' },
            phoneCalendar: { state: 'disabled' },
          });
        } finally {
          await f.close();
        }
      },
      90_000,
    );

    it.skipIf(driver === 'Firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'counts a completed quiet scheduled pulse and ignores a completion without a run',
      async () => {
        const f = await fixture();
        try {
          const repo = f.persistence.proactiveCanaries;
          if (!repo) throw new Error('Canary repository unavailable');
          await f.schedule.ensure({
            name: PULSE_SCHEDULE,
            agentId: f.owner,
            enabled: true,
            cron: '*/20 * * * *',
            nextRunAt: null,
            taskTemplate: { type: 'scheduled', job: 'pulse.check' },
          });
          const { schedule } = await repo.pulse(f.owner);
          if (!schedule) throw new Error('Pulse schedule missing');
          const makeTask = () =>
            f.persistence.tasks.createTask({
              agentId: f.owner,
              type: 'scheduled',
              trust: 'assistant',
              trigger: {
                source: 'schedule',
                payload: { job: 'pulse.check', schedule: PULSE_SCHEDULE, scheduleId: schedule.id },
              },
            });
          const unavailable = new Proxy(
            {},
            {
              get: () => {
                throw new Error('Unexpected model or tool');
              },
            },
          );
          const deps = {
            db: f.db,
            persistence: f.persistence,
            router: unavailable,
            dispatcher: unavailable,
          } as ExecutorDeps;
          const skipped = await makeTask();
          await executeTask(
            { ...deps, jobUnavailable: () => 'synthetic runtime unavailable' },
            skipped.task.id,
          );
          expect((await repo.pulse(f.owner)).completedAt).toBeNull();
          const quiet = await makeTask();
          const result = await executeTask(deps, quiet.task.id);
          expect(result).toMatchObject({ outcome: 'done', detail: 'pulse: quiet (no-candidates)' });
          const { completedAt } = await repo.pulse(f.owner);
          if (!completedAt) throw new Error('Pulse receipt missing');
          const at = (ms: number) => new Date(completedAt.getTime() + ms);
          expect(
            (await assessProactiveCanaries(repo, f.owner, config, at(PULSE_INTERVAL_MS - 1))).pulse
              .state,
          ).toBe('fresh');
          expect(
            (await assessProactiveCanaries(repo, f.owner, config, at(PULSE_INTERVAL_MS))).pulse
              .state,
          ).toBe('overdue');
          const monitor = (now: Date) =>
            runAssistantHealthMonitor(
              {
                db: f.db,
                health: f.persistence.assistantHealth,
                canaries: repo,
              },
              { agentId: f.owner, now },
            );
          expect(await monitor(at(PULSE_INTERVAL_MS))).toMatchObject({
            signals: ['Pulse: overdue.'],
            notified: true,
          });
          expect(await monitor(at(PULSE_INTERVAL_MS + 10 * 60_000))).toMatchObject({
            signals: ['Pulse: overdue.'],
            notified: false,
          });
        } finally {
          await f.close();
        }
      },
      90_000,
    );
    it.skipIf(driver === 'Firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'shares one private push per owner-local day and rechecks policy and recovery on retries',
      async () => {
        const f = await fixture();
        try {
          const repo = f.persistence.proactiveCanaries;
          const policy = f.persistence.nudgePolicy;
          if (!repo || !policy) throw new Error('Canary and nudge stores required');
          await f.schedule.ensure({
            name: PULSE_SCHEDULE,
            agentId: f.owner,
            enabled: true,
            cron: '*/20 * * * *',
            nextRunAt: null,
            taskTemplate: { type: 'scheduled', job: 'pulse.check' },
          });
          const pulse = (await repo.pulse(f.owner)).schedule;
          if (pulse) await f.schedule.setOwnerEnabled(f.owner, pulse.id, false);
          const owner = { id: f.owner, name: 'Private name', timezone: 'America/Los_Angeles' };
          const first = new Date('2026-11-19T07:58:00.000Z');
          const at = (minutes: number) => new Date(first.getTime() + minutes * 60_000);
          const eraseMail = await f.mail(at(-8 * 60));
          const send = vi.fn(
            async (_alert: unknown): Promise<{ ok: boolean; status: number }> => ({
              ok: true,
              status: 200,
            }),
          );
          const channel: PushChannelDeps = {
            apns: { configured: () => true, send } as unknown as ApnsClient,
            devices: {
              listActive: async () => [{ token: 'a'.repeat(64), environment: 'sandbox' }],
              invalidate: async () => undefined,
            },
            owner: async () => owner,
            notificationOutbox: f.persistence.notificationOutbox,
            admitHealthCanary: healthCanaryAdmission(async () => owner, policy, repo),
          };
          let held = 2;
          const run = async (now: Date) => {
            vi.setSystemTime(now);
            return runAssistantHealthMonitor(
              {
                db: f.db,
                health: f.persistence.assistantHealth,
                canaries: repo,
                readTotals: async () => ({
                  ...(await f.persistence.costs.totals()),
                  dailyHeldUsd: held,
                  dailyLimitUsd: 4,
                }),
                ownerTimeZone: async () => owner.timezone,
                notifyOwner: (notice) => notifyOwnerByPush(channel, notice),
              },
              { agentId: f.owner, now },
            );
          };
          const drain = async (now: Date) => {
            vi.setSystemTime(now);
            return drainPushNotificationOutbox(channel, now);
          };
          const firstRed = await run(first);
          expect(firstRed.signals).toEqual(
            expect.arrayContaining([
              expect.stringContaining('Mail processing'),
              expect.stringContaining('25%'),
            ]),
          );
          await run(at(1));
          expect(send).toHaveBeenCalledOnce();
          expect(send).toHaveBeenLastCalledWith(
            expect.objectContaining({
              title: 'Assistant',
              body: 'Assistant needs attention. Open the app to review.',
              expiresAt: 0,
              data: { route: 'chat', agentId: f.owner },
            }),
          );

          // The previous two probes share a civil day despite the UTC date.
          // After the owner's midnight a new leg may send, but a later quiet
          // window must block the worker from retrying a definite rejection.
          send.mockResolvedValueOnce({ ok: false, status: 503 });
          await run(at(2));
          expect(send).toHaveBeenCalledTimes(2);
          await f.prefs(0, 60, null);
          await drain(at(3));
          expect(send).toHaveBeenCalledTimes(2);
          await f.prefs(null, null, null);

          // A red observation on a third day can create a retryable leg. Once
          // recovery is observed, the worker drops that pending push.
          send.mockResolvedValueOnce({ ok: false, status: 503 });
          await run(at(2 + 24 * 60));
          expect(send).toHaveBeenCalledTimes(3);
          await eraseMail();
          held = 0;
          expect((await run(at(2 + 24 * 60))).signals).toEqual([]);
          await drain(at(3 + 24 * 60));
          expect(send).toHaveBeenCalledTimes(3);

          const fourthDay = 2 + 2 * 24 * 60;
          held = 2;
          await f.prefs(null, null, 2);
          send.mockResolvedValueOnce({ ok: false, status: 503 });
          await run(at(fourthDay));
          expect(send).toHaveBeenCalledTimes(4);
          // A different ambient reservation fills the second slot. If the
          // owner lowers the cap before the retry, the retry is held.
          expect(await policy.evaluate(owner, { urgency: 'ambient', now: at(fourthDay) })).toEqual({
            deliver: true,
          });
          await f.prefs(null, null, 1);
          await drain(at(fourthDay + 1));
          expect(send).toHaveBeenCalledTimes(4);

          const fifthDay = fourthDay + 24 * 60;
          const admission = channel.admitHealthCanary;
          if (!admission) throw new Error('Health policy unavailable');
          channel.admitHealthCanary = vi
            .fn(admission)
            .mockRejectedValueOnce(new Error('Synthetic policy read failure'));
          await f.prefs(null, null, null);
          await run(at(fifthDay));
          expect(send).toHaveBeenCalledTimes(4);
          await drain(at(fifthDay + 1));
          expect(send).toHaveBeenCalledTimes(5);
        } finally {
          vi.useRealTimers();
          await f.close();
        }
      },
      90_000,
    );
  });
}
