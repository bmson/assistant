import { randomUUID } from 'node:crypto';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreMissionRepository } from './missions.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore mission budget accounting', () => {
  let store: InstallationStore;
  let missions: FirestoreMissionRepository;
  let clock: Date;

  beforeEach(() => {
    clock = new Date('2026-10-07T12:00:00.000Z');
    store = emulatorStore(() => clock);
    missions = new FirestoreMissionRepository(store, 'agent');
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('includes every nested descendant in the original mission spend total', async () => {
    const root = taskFixture({
      id: 'mission-root',
      agentId: 'agent',
      conversationId: 'conversation',
      reminderId: '',
    });
    root.type = 'mission';
    root.spentUsd = '0.100000';
    const child = taskFixture({
      id: 'mission-child',
      agentId: 'agent',
      conversationId: 'conversation',
      reminderId: '',
    });
    child.parentTaskId = root.id;
    child.spentUsd = '0.200000';
    const grandchild = taskFixture({
      id: 'mission-grandchild',
      agentId: 'agent',
      conversationId: 'conversation',
      reminderId: '',
    });
    grandchild.parentTaskId = child.id;
    grandchild.spentUsd = '0.300000';
    await Promise.all(
      [root, child, grandchild].map((task) => store.doc('tasks', task.id).set(task)),
    );

    await expect(missions.spentUsd('agent', root.id)).resolves.toBeCloseTo(0.6, 6);
  });

  it('refuses to account for a root outside the configured installation', async () => {
    const root = taskFixture({
      id: 'foreign-mission',
      agentId: 'another-agent',
      conversationId: 'conversation',
      reminderId: '',
    });
    root.type = 'mission';
    await store.doc('tasks', root.id).set(root);

    await expect(missions.spentUsd('another-agent', root.id)).rejects.toThrow(
      /configured installation/,
    );
  });

  it('commits terminal state with report intent and fences concurrent report repair leases', async () => {
    const mission = taskFixture({
      id: randomUUID(),
      agentId: 'agent',
      conversationId: 'conversation',
      reminderId: '',
    });
    mission.type = 'mission';
    mission.status = 'running';
    mission.leaseToken = randomUUID();
    await store.doc('tasks', mission.id).set(mission);
    const eventId = `mission:${mission.id}:terminal:done`;
    const transition = {
      taskId: mission.id,
      agentId: mission.agentId,
      leaseToken: mission.leaseToken,
      eventId,
      outcome: 'complete',
      status: 'done' as const,
      text: 'Mission complete.',
    };

    await expect(missions.transitionWithReport(transition)).resolves.toBe(true);
    await expect(missions.transitionWithReport(transition)).resolves.toBe(false);
    expect((await store.doc('tasks', mission.id).get()).get('status')).toBe('done');
    expect((await store.doc('missionReports', eventId).get()).get('text')).toBe(
      'Mission complete.',
    );
    await expect(missions.dueReports('agent')).resolves.toEqual([eventId]);

    const leases = await Promise.all([
      missions.claimReport(eventId, 'agent'),
      missions.claimReport(eventId, 'agent'),
    ]);
    const current = leases.find((lease) => lease !== null);
    expect(leases.filter(Boolean)).toHaveLength(1);
    if (!current) throw new Error('No report lease was claimed');
    expect(
      await missions.settleReportLeg({
        id: eventId,
        claimToken: current.claimToken,
        leg: 'chat',
        status: 'delivered',
      }),
    ).toBe(true);
    clock = new Date(clock.getTime() + 31_000);
    const reclaimed = await missions.claimReport(eventId, 'agent');
    expect(reclaimed).not.toBeNull();
    if (!reclaimed) throw new Error('Expired mission report lease was not reclaimed');
    expect(
      await missions.settleReportLeg({
        id: eventId,
        claimToken: current.claimToken,
        leg: 'owner',
        status: 'failed',
      }),
    ).toBe(false);
    expect(
      await missions.settleReportLeg({
        id: eventId,
        claimToken: reclaimed.claimToken,
        leg: 'owner',
        status: 'failed',
      }),
    ).toBe(true);
    expect((await store.doc('missionReports', eventId).get()).get('chatStatus')).toBe('delivered');
    expect((await store.doc('missionReports', eventId).get()).get('ownerStatus')).toBe('failed');
  });
});
