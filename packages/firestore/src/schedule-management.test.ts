import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreScheduleRepository } from './schedules.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const historicalInstruction =
  "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) upcoming occasions in the next several days (occasions.list) — birthdays or anniversaries to prepare for, (5) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, any upcoming occasion, and what you plan to do today. No fluff.";
const legacyTemplate = {
  type: 'scheduled',
  budgetUsdLimit: '0.10',
  instruction: historicalInstruction,
};
const dailyTemplate = { type: 'scheduled', budgetUsdLimit: '0.10', job: 'briefing.compose' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore schedule management reads', () => {
  let store: InstallationStore;
  let schedules: FirestoreScheduleRepository;

  beforeEach(() => {
    store = emulatorStore();
    schedules = new FirestoreScheduleRepository(store);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed(
    id: string,
    agentId: string,
    options: { enabled?: boolean; name?: string } = {},
  ) {
    await store.doc('schedules', id).set({
      id,
      agentId,
      name: options.name ?? `schedule:${id}`,
      cron: '* * * * *',
      taskTemplate: { reminderKind: 'recurring', reminderText: id },
      enabled: options.enabled ?? true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date('2026-09-12T12:00:00Z'),
      updatedAt: new Date('2026-09-12T12:00:00Z'),
    });
  }

  async function seedRetirementPair() {
    await store.doc('agents', 'owner').set({ id: 'owner' });
    const morning = await schedules.ensure({
      agentId: 'owner',
      name: 'morning-brief',
      cron: '30 7 * * *',
      taskTemplate: legacyTemplate,
      nextRunAt: new Date('2026-11-18T15:30:00.000Z'),
    });
    const daily = await schedules.ensure({
      agentId: 'owner',
      name: 'daily-briefing',
      cron: '45 7 * * *',
      taskTemplate: dailyTemplate,
      nextRunAt: new Date('2026-11-18T15:45:00.000Z'),
    });
    return { morning, daily };
  }

  it('retires exactly once and preserves subsequent owner re-enable', async () => {
    const { morning, daily } = await seedRetirementPair();
    const observations = await Promise.all([
      schedules.retireDefaultMorningBrief('owner'),
      schedules.retireDefaultMorningBrief('owner'),
    ]);
    expect(observations.sort()).toEqual([0, 1]);
    expect(await schedules.getByName('owner', 'morning-brief')).toMatchObject({
      id: morning.id,
      enabled: false,
      seedReviewRequired: true,
      nextRunAt: morning.nextRunAt,
      taskTemplate: legacyTemplate,
    });
    expect(await schedules.getByName('owner', 'daily-briefing')).toEqual(daily);
    expect((await store.collection('tasks').get()).empty).toBe(true);
    expect((await store.collection('outbox').get()).empty).toBe(true);
    expect(await schedules.setOwnerEnabled('owner', morning.id, true)).toBe(true);
    expect(await schedules.retireDefaultMorningBrief('owner')).toBe(0);
    expect(await schedules.getByName('owner', 'morning-brief')).toMatchObject({ enabled: true });
  });

  it.each([
    'inactive',
    'paused',
    'review',
    'owner-enabled',
    'custom',
    'duplicate',
    'wrong-job',
    'wrong-owner',
    'paused-replacement',
    'identity-conflict',
    'seed-conflict',
  ] as const)('leaves %s schedules exactly as stored', async (scenario) => {
    const { morning, daily } = await seedRetirementPair();
    const legacyRef = store.doc('schedules', morning.id);
    const dailyRef = store.doc('schedules', daily.id);
    switch (scenario) {
      case 'inactive':
        await store.doc('coordination', 'migration').set({ status: 'pending_activation' });
        break;
      case 'paused':
        await legacyRef.update({ enabled: false });
        break;
      case 'owner-enabled':
        await schedules.setOwnerEnabled('owner', morning.id, true);
        break;
      case 'review':
        await legacyRef.update({ seedReviewRequired: true });
        break;
      case 'custom':
        await legacyRef.update({ 'taskTemplate.instruction': 'Owner-written briefing.' });
        break;
      case 'duplicate':
        await store.doc('schedules', 'shadow').set({ ...morning, id: 'shadow' });
        break;
      case 'wrong-job':
        await dailyRef.update({ 'taskTemplate.job': 'pulse.check' });
        break;
      case 'wrong-owner':
        await dailyRef.update({ agentId: 'foreign' });
        break;
      case 'paused-replacement':
        await dailyRef.update({ enabled: false });
        break;
      case 'identity-conflict': {
        const key = createHash('sha256')
          .update(JSON.stringify(['owner', 'daily-briefing']))
          .digest('hex');
        await store.doc('scheduleNames', key).update({ scheduleId: 'unrelated' });
        break;
      }
      case 'seed-conflict':
        await legacyRef.update({
          seedDefinition: { cron: '0 10 * * *', taskTemplate: legacyTemplate },
        });
        break;
    }
    const prior = (await legacyRef.get()).data();
    expect(await schedules.retireDefaultMorningBrief('owner')).toBe(0);
    expect((await legacyRef.get()).data()).toEqual(prior);
  });

  it('pages all owner schedules in ID order, including disabled and nonreminder rows', async () => {
    await seed('b', 'owner');
    await seed('d', 'owner', { enabled: false });
    await seed('f', 'owner', { name: 'goal:owner' });
    await seed('a', 'other');

    const first = await schedules.listPage('owner', { limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual(['b', 'd']);
    expect(first.items[1]?.enabled).toBe(false);
    expect(first.nextCursor).toBe('d');

    const second = await schedules.listPage('owner', {
      afterId: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.items.map((row) => row.id)).toEqual(['f']);
    expect(second.nextCursor).toBeNull();
  });

  it('continues after a deleted cursor document', async () => {
    await seed('a', 'owner');
    await seed('b', 'owner');
    await seed('c', 'owner');
    const first = await schedules.listPage('owner', { limit: 1 });
    await store.doc('schedules', first.items[0]?.id ?? '').delete();

    const next = await schedules.listPage('owner', { afterId: first.nextCursor ?? '', limit: 1 });
    expect(next.items.map((row) => row.id)).toEqual(['b']);
  });

  it('validates bounded limits, cursors, empty pages, and row identity', async () => {
    await expect(schedules.listPage('owner', { limit: 0 })).rejects.toThrow('batch');
    await expect(schedules.listPage('owner', { limit: 201 })).rejects.toThrow('batch');
    await expect(schedules.listPage('owner', { afterId: '' })).rejects.toThrow('cursor');
    expect(await schedules.listPage('owner')).toEqual({ items: [], nextCursor: null });

    await store.doc('schedules', 'document').set({
      id: 'different',
      agentId: 'owner',
      name: 'reminder:broken',
      cron: '* * * * *',
      taskTemplate: {},
      enabled: true,
      nextRunAt: null,
    });
    await expect(schedules.listPage('owner')).rejects.toThrow('identity');
  });
});
