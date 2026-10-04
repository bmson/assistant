import { randomUUID } from 'node:crypto';
import type { PulseNoticeInput } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestorePulseRepository } from './pulse.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';
import { suggestionIdFor } from './suggestions.js';
import { disposeStore, emulatorStore } from './test-store.js';

const HOUR = 3_600_000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore atomic pulse admission', () => {
  const agentId = randomUUID();
  const now = new Date('2026-10-03T12:00:00Z');
  let store: InstallationStore;
  let pulse: FirestorePulseRepository;
  const at = (hours: number) => new Date(now.getTime() + hours * HOUR);

  beforeEach(async () => {
    store = emulatorStore(() => now);
    pulse = new FirestorePulseRepository(store);
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
  });

  afterEach(async () => disposeStore(store));

  const input = (key = 'mail:one', extra: Partial<PulseNoticeInput> = {}): PulseNoticeInput => ({
    agentId,
    now,
    observationFence: null,
    pacing: { gapSince: at(-1), windowSince: at(-24), dailyCap: 6 },
    moment: { kind: 'mail-action', key, summary: 'Verified source changed' },
    notice: {
      text: 'Your flight time changed.',
      extraParts: [
        { type: 'data-card', data: { kind: 'proactive-alert', title: 'Flight change' } },
      ],
    },
    suggestion: {
      summary: 'Review the new flight time',
      proposedAction: 'Show the verified itinerary and draft a response',
      sourceRef: `pulse:${key}`,
      origin: 'pulse',
      expiresAt: at(24),
    },
    ...extra,
  });

  async function sizes() {
    const names = [
      'proactiveMoments',
      'messages',
      'suggestions',
      'conversations',
      'notificationConversations',
    ];
    return Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, (await store.collection(name).get()).size]),
      ),
    );
  }

  async function importedMoment(key: string, hours: number) {
    const id = randomUUID();
    await store.doc('proactiveMoments', id).set(
      encodeRecord({
        id,
        agentId,
        kind: 'mail-action',
        momentKey: key,
        summary: 'Imported legacy notice',
        deliveredAt: at(hours),
        pinged: false,
      }),
    );
    return id;
  }

  it('commits one ledger, message and proposal and is inert on an after-commit retry', async () => {
    expect(await pulse.observationFence(agentId)).toBeNull();
    const result = await pulse.admitNotice(input());
    expect(result.status).toBe('persisted');
    if (result.status !== 'persisted') throw new Error('Fixture admission failed');
    expect(result.suggestionCreated).toBe(true);
    const message = decodeRecord<Record<string, unknown>>(
      (await store.doc('messages', result.messageId).get()).data(),
    );
    const suggestionId = suggestionIdFor(agentId, 'pulse:mail:one');
    expect(message).toMatchObject({
      id: result.messageId,
      conversationId: result.conversationId,
      role: 'assistant',
      origin: 'assistant',
      text: 'Your flight time changed.',
      parts: [
        { type: 'text', text: 'Your flight time changed.' },
        { type: 'data-card', data: { kind: 'proactive-alert', title: 'Flight change' } },
        {
          type: 'suggestion',
          suggestionId,
          summary: 'Review the new flight time',
          proposedAction: 'Show the verified itinerary and draft a response',
        },
      ],
    });
    expect((await store.doc('suggestions', suggestionId).get()).get('conversationId')).toBe(
      result.conversationId,
    );
    expect(await pulse.admitNotice(input())).toEqual({ status: 'already-said' });
    expect(await sizes()).toEqual({
      proactiveMoments: 1,
      messages: 1,
      suggestions: 1,
      conversations: 1,
      notificationConversations: 1,
    });
  });

  it('serializes concurrent identical candidates without creating a second owner notice', async () => {
    const results = await Promise.all([pulse.admitNotice(input()), pulse.admitNotice(input())]);
    expect(results.map((row) => row.status).sort()).toEqual(['already-said', 'persisted']);
    expect(await sizes()).toMatchObject({ proactiveMoments: 1, messages: 1, suggestions: 1 });
  });

  it('serializes distinct candidates at the minimum-gap boundary', async () => {
    const results = await Promise.all([
      pulse.admitNotice(input('mail:one')),
      pulse.admitNotice(input('mail:two')),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual(['min-gap', 'persisted']);
    expect(await sizes()).toMatchObject({ proactiveMoments: 1, messages: 1, suggestions: 1 });
  });

  it('atomically spends the final daily slot across concurrent distinct candidates', async () => {
    await importedMoment('old', -3);
    // Cap precedes gap inside admission, so the losing contender reports the
    // final slot consumed even though the newly committed notice also closes
    // the gap. The ordinary hourly bounds remain in place for both contenders.
    const results = await Promise.all([
      pulse.admitNotice(
        input('mail:one', {
          pacing: { gapSince: at(-1), windowSince: at(-24), dailyCap: 2 },
        }),
      ),
      pulse.admitNotice(
        input('mail:two', {
          pacing: { gapSince: at(-1), windowSince: at(-24), dailyCap: 2 },
        }),
      ),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual(['daily-cap', 'persisted']);
    expect(await sizes()).toMatchObject({ proactiveMoments: 2, messages: 1, suggestions: 1 });
    expect(
      await pulse.admitNotice(
        input('mail:three', {
          pacing: { gapSince: at(-1), windowSince: at(-24), dailyCap: 2 },
        }),
      ),
    ).toEqual({ status: 'daily-cap' });
  });

  it('enforces the daily cap from imported history independently of the minimum gap', async () => {
    await importedMoment('one', -3);
    await importedMoment('two', -2);
    expect(
      await pulse.admitNotice(
        input('mail:three', {
          pacing: { gapSince: at(-1), windowSince: at(-24), dailyCap: 2 },
        }),
      ),
    ).toEqual({ status: 'daily-cap' });
    expect(await sizes()).toMatchObject({ proactiveMoments: 2, messages: 0, suggestions: 0 });
  });

  it('rolls back staged ledger, proposal, destination and marker when message encoding fails', async () => {
    await expect(
      pulse.admitNotice(
        input('invalid', {
          notice: { text: 'Bad payload', extraParts: [{ type: 'test', value: NaN }] },
        }),
      ),
    ).rejects.toThrow('Nonfinite persisted number');
    expect(await sizes()).toEqual({
      proactiveMoments: 0,
      messages: 0,
      suggestions: 0,
      conversations: 0,
      notificationConversations: 0,
    });
    expect((await store.doc('coordination', `pulse-admission:${agentId}`).get()).exists).toBe(
      false,
    );
    expect((await pulse.admitNotice(input('invalid'))).status).toBe('persisted');
  });

  it('keeps imported ledger-only moments inert, even when current pacing would block', async () => {
    const id = await importedMoment('mail:one', 0);
    expect(await pulse.admitNotice(input())).toEqual({ status: 'already-said' });
    expect(await sizes()).toMatchObject({ proactiveMoments: 1, messages: 0, suggestions: 0 });
    expect((await store.doc('proactiveMoments', id).get()).get('summary')).toBe(
      'Imported legacy notice',
    );
  });

  it('preserves an imported dismissed proposal and does not reattach it to a fresh notice', async () => {
    const id = randomUUID();
    await store.doc('suggestions', id).set({
      id,
      agentId,
      sourceRef: 'pulse:mail:one',
      status: 'dismissed',
      summary: 'Old proposal',
    });
    const result = await pulse.admitNotice(input());
    if (result.status !== 'persisted') throw new Error('Fixture admission failed');
    expect(result.suggestionCreated).toBe(false);
    expect((await store.doc('messages', result.messageId).get()).get('parts')).toHaveLength(2);
    expect((await store.doc('suggestions', id).get()).get('status')).toBe('dismissed');
    expect(await sizes()).toMatchObject({ proactiveMoments: 1, messages: 1, suggestions: 1 });
  });

  it('rechecks the current preference after observation and rejects malformed caps', async () => {
    const observed = input();
    await store.doc('notificationPrefs', agentId).set({ agentId, ambientDailyCap: 0 });
    expect(await pulse.admitNotice(observed)).toEqual({ status: 'daily-cap' });
    await store.doc('notificationPrefs', agentId).update({ ambientDailyCap: 'six' });
    await expect(pulse.admitNotice(observed)).rejects.toThrow('Invalid owner ambient daily cap');
    expect(await sizes()).toMatchObject({ proactiveMoments: 0, messages: 0, suggestions: 0 });
  });

  it('rejects active erasure and stale observations after a completed erasure', async () => {
    const observed = input();
    await store.doc('privacyErasureJobs', agentId).set({
      agentId,
      generation: 'new-generation',
      status: 'active',
    });
    await expect(pulse.observationFence(agentId)).rejects.toThrow('Privacy erasure');
    await expect(pulse.admitNotice(observed)).rejects.toThrow('Privacy erasure');
    await store.doc('privacyErasureJobs', agentId).update({ status: 'complete' });
    await expect(pulse.admitNotice(observed)).rejects.toThrow('changed during pulse observation');
    expect(await sizes()).toMatchObject({ proactiveMoments: 0, messages: 0, suggestions: 0 });
    const observationFence = await pulse.observationFence(agentId);
    expect(observationFence).toBe('new-generation');
    expect((await pulse.admitNotice(input('new', { observationFence }))).status).toBe('persisted');
    await store.doc('privacyErasureJobs', agentId).update({ generation: 'later-generation' });
    await expect(
      pulse.admitNotice(input('stale-second-erase', { observationFence })),
    ).rejects.toThrow('changed during pulse observation');
  });

  it('refuses malformed completed fences and foreign owner/task identities without writing', async () => {
    const taskId = randomUUID();
    await store.doc('tasks', taskId).set({ id: taskId, agentId: randomUUID() });
    await expect(pulse.admitNotice(input('foreign-task', { taskId }))).rejects.toThrow(
      'outside the configured installation',
    );
    await expect(
      pulse.admitNotice(input('foreign-owner', { agentId: randomUUID() })),
    ).rejects.toThrow('exactly one configured owner');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'complete' });
    await expect(pulse.observationFence(agentId)).rejects.toThrow('Privacy erasure');
    await expect(pulse.admitNotice(input())).rejects.toThrow('Privacy erasure');
    expect(await sizes()).toMatchObject({ proactiveMoments: 0, messages: 0, suggestions: 0 });
  });

  it('routes atomically into the primary chat without creating Notifications', async () => {
    const id = randomUUID();
    const taskId = randomUUID();
    await store.doc('conversations', id).set({
      id,
      agentId,
      channel: 'chat',
      isPrimary: true,
      archivedAt: null,
    });
    await store.doc('tasks', taskId).set({ id: taskId, agentId });
    const result = await pulse.admitNotice(input('primary', { taskId }));
    if (result.status !== 'persisted') throw new Error('Fixture admission failed');
    expect(result.conversationId).toBe(id);
    expect((await store.doc('messages', result.messageId).get()).get('taskId')).toBe(taskId);
    expect(await sizes()).toMatchObject({ conversations: 1, notificationConversations: 0 });
  });

  it('reuses a migrated Notifications chat while reading proposals before any marker write', async () => {
    const id = randomUUID();
    await store.doc('conversations', id).set({
      id,
      agentId,
      channel: 'chat',
      isPrimary: false,
      title: 'Notifications',
      archivedAt: at(-1),
    });
    const result = await pulse.admitNotice(input());
    if (result.status !== 'persisted') throw new Error('Fixture admission failed');
    expect(result.conversationId).toBe(id);
    expect(result.suggestionCreated).toBe(true);
    expect(
      (await store.doc('notificationConversations', agentId).get()).get('conversationId'),
    ).toBe(id);
    expect((await store.doc('conversations', id).get()).get('archivedAt')).toBeNull();
    expect(await sizes()).toMatchObject({ conversations: 1, notificationConversations: 1 });
  });

  it('falls back from an archived primary and supports a notice without a proposal', async () => {
    const id = randomUUID();
    await store.doc('conversations', id).set({
      id,
      agentId,
      channel: 'chat',
      isPrimary: true,
      archivedAt: at(-1),
    });
    const result = await pulse.admitNotice(input('without-proposal', { suggestion: undefined }));
    if (result.status !== 'persisted') throw new Error('Fixture admission failed');
    expect(result.conversationId).not.toBe(id);
    expect(result.suggestionCreated).toBe(false);
    expect((await store.doc('messages', result.messageId).get()).get('parts')).toHaveLength(2);
    expect(await sizes()).toMatchObject({ conversations: 2, suggestions: 0 });
  });
});
