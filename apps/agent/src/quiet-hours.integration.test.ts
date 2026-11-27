import { randomUUID } from 'node:crypto';
import {
  createPostgresSettingsPersistence,
  createSettingsFacade,
} from '@assistant/application/settings';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import {
  agents,
  assertPostgresInstallationOwner,
  commitments,
  conversations,
  createPostgresExecutionPersistence,
  type Db,
  notificationPrefs,
  proactivePings,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  createFirestoreSettingsPersistence,
} from '@assistant/firestore';
import { commitmentDueMomentKey, notificationLeg } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { postgresPulseRepository } from '../../../packages/core/src/proactive/pulse.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { policyGatedOutOfBand } from './deps.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const timezone = 'America/Los_Angeles';
const afterMidnight = new Date('2026-08-26T07:30:00Z');
const window = { quietStartMin: 1320, quietEndMin: 420 };
const off = { quietStartMin: null, quietEndMin: null };

async function fixture(driver: 'postgres' | 'firestore') {
  const commitment = {
    id: randomUUID(),
    conversationId: randomUUID(),
    kind: 'promise',
    title: 'Review the synthetic packet',
    details: '',
    nextAction: 'Read the draft',
    snoozedUntil: null,
    status: 'open',
    dueAt: new Date('2026-08-26T10:30:00Z'),
    contentHash: 'synthetic-packet',
    createdAt: new Date('2026-08-25T20:00:00Z'),
    updatedAt: new Date('2026-08-25T20:00:00Z'),
  };
  if (driver === 'postgres') {
    const { db, close } = await createIsolatedTestDatabase();
    const agentId = await assertPostgresInstallationOwner(db);
    await db.update(agents).set({ timezone }).where(eq(agents.id, agentId));
    await db
      .insert(conversations)
      .values({ id: commitment.conversationId, agentId, channel: 'chat' });
    await db.insert(commitments).values({ agentId, ...commitment });
    return {
      agentId,
      db,
      settings: createPostgresSettingsPersistence(db),
      execution: createPostgresExecutionPersistence(db),
      setCap: (ambientDailyCap: number) =>
        db
          .update(notificationPrefs)
          .set({ ambientDailyCap })
          .where(eq(notificationPrefs.agentId, agentId)),
      pings: () => db.select().from(proactivePings).where(eq(proactivePings.agentId, agentId)),
      close,
      momentKey: commitmentDueMomentKey(commitment.id, commitment.dueAt),
    };
  }

  const store = emulatorStore();
  const agentId = randomUUID();
  await store.doc('agents', agentId).set({
    id: agentId,
    timezone,
    name: 'Synthetic Owner',
    email: 'owner@example.test',
    locale: 'en-US',
    signature: '',
    createdAt: commitment.createdAt,
    updatedAt: commitment.updatedAt,
  });
  await store.doc('commitments', commitment.id).set({ agentId, ...commitment });
  return {
    agentId,
    db: new Proxy(
      {},
      {
        get: () => {
          throw new Error('Unexpected SQL');
        },
      },
    ) as Db,
    settings: createFirestoreSettingsPersistence(store, agentId),
    execution: createFirestoreExecutionPersistence(store, agentId, {
      provider: 'synthetic',
      model: 'e5',
      revision: '1',
      dimensions: 1536,
    }),
    setCap: (ambientDailyCap: number) =>
      store.doc('notificationPrefs', agentId).update({ ambientDailyCap }),
    pings: async () =>
      (await store.collection('proactivePings').get()).docs.map((doc) => doc.data()),
    close: () => disposeStore(store),
    momentKey: commitmentDueMomentKey(commitment.id, commitment.dueAt),
  };
}

for (const driver of ['postgres', 'firestore'] as const) {
  it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${driver} saves and clears the owner-local window and records a scheduled hold`,
    { timeout: 150_000 },
    async () => {
      const f = await fixture(driver);
      try {
        const nudgePolicy = f.execution.nudgePolicy;
        const pulse = f.execution.pulse ?? postgresPulseRepository(f.db);
        if (!nudgePolicy || !pulse) throw new Error('Missing execution repositories');
        const facade = createSettingsFacade(f.settings);
        await f.settings.settings.updateNotificationPrefs(f.agentId, {
          ...off,
          ambientDailyCap: 4,
        });
        const [saved] = await Promise.all([
          facade.updateQuietHours(f.agentId, window),
          f.setCap(5),
        ]);
        expect(saved).toEqual({ timezone, ...window });
        const stored = await f.settings.settings.getNotificationPrefs(f.agentId);
        expect(stored).toEqual({ ...window, ambientDailyCap: 5 });
        expect(await facade.getQuietHours(f.agentId)).toEqual(saved);

        const owner = async () => {
          const storedOwner = await f.settings.settings.getOwner();
          if (!storedOwner) throw new Error('Fixture owner missing');
          return storedOwner;
        };
        const transport = vi.fn(async () => notificationLeg('push', 'delivered'));
        const gated = policyGatedOutOfBand(nudgePolicy, owner, {
          notifyOwner: transport,
          notifyApprovals: async () => undefined,
        });
        const receipts = vi.fn(gated.notifyOwner);
        const { task } = await f.execution.tasks.createTask({
          agentId: f.agentId,
          type: 'scheduled',
          trust: 'assistant',
          trigger: { source: 'schedule', payload: { job: 'pulse.check' } },
        });
        vi.useFakeTimers({ toFake: ['Date'], now: afterMidnight });
        try {
          const result = await executeTask(
            {
              db: f.db,
              persistence: f.execution,
              router: {} as ExecutorDeps['router'],
              dispatcher: {} as ExecutorDeps['dispatcher'],
              notifyOwner: receipts,
            },
            task.id,
          );
          expect(result).toMatchObject({
            outcome: 'done',
            detail: 'pulse: commitment-due delivered, 1 candidate(s)',
          });
        } finally {
          vi.useRealTimers();
        }
        const receipt = await receipts.mock.results[0]?.value;
        expect(receipt).toEqual(notificationLeg('out-of-band', 'held', 'quiet-hours'));
        expect(receipts).toHaveBeenCalledTimes(1);
        expect(transport).not.toHaveBeenCalled();
        const held = await f.pings();
        expect(held).toMatchObject([
          { urgency: 'ambient', delivered: false, reason: 'quiet-hours' },
        ]);
        expect(await pulse.momentKeys(f.agentId, 'commitment-due')).toEqual([f.momentKey]);
        const counts = await f.settings.settings.countHeldPings(
          f.agentId,
          new Date('2026-08-25T07:30:00Z'),
        );
        expect(counts).toEqual({ quietHours: 1, dailyCap: 0 });

        const allowed = await nudgePolicy.evaluate(await owner(), {
          urgency: 'ambient',
          now: new Date('2026-08-26T14:00:00Z'),
        });
        expect(allowed).toEqual({ deliver: true });
        const disabled = await facade.updateQuietHours(f.agentId, off);
        expect(disabled).toEqual({ timezone, ...off });
        expect(await facade.getQuietHours(f.agentId)).toEqual(disabled);
        expect(await f.settings.settings.getNotificationPrefs(f.agentId)).toEqual({
          ...off,
          ambientDailyCap: 5,
        });
        console.info('E5 synthetic readback', {
          driver,
          saved,
          stored,
          held: held.map(({ delivered, reason }) => ({ delivered, reason })),
          counts,
          receipt,
          allowed,
          disabled,
          transportCalls: transport.mock.calls.length,
        });
      } finally {
        await f.close();
      }
    },
  );
}
