import { randomUUID } from 'node:crypto';
import { emailBookingOccurrenceId } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { FirestoreSuggestionDecisionRepository } from './suggestion-decisions.js';
import { FirestoreSuggestionRepository } from './suggestions.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore suggestion decisions', () => {
  let store: InstallationStore;
  let decisions: FirestoreSuggestionDecisionRepository;
  const agentId = randomUUID();
  const now = new Date('2026-09-23T12:00:00.000Z');

  beforeEach(async () => {
    store = emulatorStore(() => now);
    decisions = new FirestoreSuggestionDecisionRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; conversationId: string }> {
    const id = typeof overrides.id === 'string' ? overrides.id : randomUUID();
    const conversationId = randomUUID();
    await Promise.all([
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        isPrimary: true,
        archivedAt: null,
      }),
      store.doc('suggestions', id).set({
        id,
        createdAt: now,
        updatedAt: now,
        agentId,
        conversationId,
        origin: 'watch',
        proposedAction: 'Review the source and ask before sharing anything.',
        status: 'pending',
        expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        snoozedUntil: null,
        acceptedTaskId: null,
        ...overrides,
      }),
    ]);
    return { id, conversationId };
  }

  it('accepts once into tainted owner work with one durable wake intent', async () => {
    const { id, conversationId } = await seed();
    const [first, second] = await Promise.all([
      decisions.decide(id, 'accepted'),
      decisions.decide(id, 'accepted'),
    ]);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect((await store.collection('tasks').get()).size).toBe(1);
    const task = await store.doc('tasks', first.taskId as string).get();
    expect(task.get('agentId')).toBe(agentId);
    expect(task.get('conversationId')).toBe(conversationId);
    expect(task.get('trust')).toBe('owner');
    expect(task.get('trigger.payload.taintedOrigin')).toBe(true);
    expect(task.get('trigger.payload.suggestionId')).toBe(id);
    expect((await store.collection('taskEventKeys').get()).size).toBe(1);
    expect((await store.collection('outbox').get()).size).toBe(1);
    const repository = new FirestoreSuggestionRepository(store);
    expect(
      await repository.acceptedForTask({
        agentId,
        suggestionId: id,
        taskId: first.taskId as string,
      }),
    ).toMatchObject({ id, agentId, status: 'accepted', acceptedTaskId: first.taskId });
    expect(
      await repository.acceptedForTask({ agentId, suggestionId: id, taskId: randomUUID() }),
    ).toBeNull();
    expect(
      await repository.acceptedForTask({
        agentId: randomUUID(),
        suggestionId: id,
        taskId: first.taskId as string,
      }),
    ).toBeNull();
  });

  it('fences acceptance against a newer cancelled booking lifecycle', async () => {
    const bookingKey = `booking-${randomUUID()}`;
    const occurrenceId = emailBookingOccurrenceId(agentId, bookingKey);
    const { id } = await seed({
      origin: 'briefing',
      bookingKey,
      bookingVersion: 1,
      proposedAction: 'Create a booking event after checking the calendar.',
    });
    await store.doc('emailBookingOccurrences', occurrenceId).set({
      id: occurrenceId,
      agentId,
      bookingKey,
      lifecycle: 'cancelled',
      dates: [],
      sourceChannelMessageId: `gmail:${randomUUID()}`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 2,
      createdAt: now,
      updatedAt: now,
    });

    expect(await decisions.decide(id, 'accepted')).toMatchObject({
      ok: false,
      reason: 'This booking changed. Review the latest email before accepting.',
    });
    expect((await store.doc('suggestions', id).get()).get('status')).toBe('superseded');
    expect((await store.collection('tasks').get()).size).toBe(0);
  });

  it('accepts only a current cancelled-booking binding and freezes event identity into the task', async () => {
    const bookingKey = `booking-${randomUUID()}`;
    const occurrenceId = emailBookingOccurrenceId(agentId, bookingKey);
    const binding = {
      calendarEventId: 'provider-event-314',
      bookingIdentity: 'R-314',
    };
    const { id } = await seed({
      origin: 'briefing',
      bookingKey,
      bookingVersion: 3,
      bookingCancellation: binding,
      proposedAction: 'Cancel only the exact cancelled booking event.',
    });
    await store.doc('emailBookingOccurrences', occurrenceId).set({
      id: occurrenceId,
      agentId,
      bookingKey,
      lifecycle: 'cancelled',
      dates: [],
      sourceChannelMessageId: `gmail:${randomUUID()}`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 3,
      createdAt: now,
      updatedAt: now,
    });
    const accepted = await decisions.decide(id, 'accepted');
    expect(accepted.ok).toBe(true);
    const task = await store.doc('tasks', accepted.taskId as string).get();
    expect(task.get('trigger.payload.bookingOccurrence')).toEqual({
      agentId,
      bookingKey,
      version: 3,
      operation: 'cancel_existing',
      ...binding,
    });
  });

  it('keeps foreign, expired, and erased suggestions from creating work', async () => {
    const foreign = await seed({ agentId: randomUUID() });
    expect(await decisions.decide(foreign.id, 'accepted')).toMatchObject({ ok: false });
    const expired = await seed({ expiresAt: new Date(now.getTime() - 1) });
    expect(await decisions.decide(expired.id, 'accepted')).toMatchObject({ ok: false });
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    const current = await seed();
    await expect(decisions.decide(current.id, 'accepted')).rejects.toThrow('Privacy erasure');
    expect((await store.collection('tasks').get()).size).toBe(0);
  });

  it('dismisses idempotently and wakes snoozed cards at a future time', async () => {
    const dismissed = await seed();
    expect(await decisions.decide(dismissed.id, 'dismissed')).toEqual({ ok: true });
    expect(await decisions.decide(dismissed.id, 'dismissed')).toEqual({ ok: true });
    const later = await seed();
    const snoozed = await decisions.decide(later.id, 'snoozed');
    expect(snoozed.snoozedUntil).toBe(new Date(now.getTime() + 24 * 3600 * 1000).toISOString());
    expect(await decisions.decide(later.id, 'snoozed')).toEqual(snoozed);
    expect((await store.doc('suggestions', later.id).get()).get('status')).toBe('snoozed');
    expect((await store.collection('tasks').get()).size).toBe(0);
  });

  it('filters answered imported sources by exact owner and keeps pending sources open', async () => {
    const refs = {
      dismissed: `booking:${randomUUID()}:cancelled`,
      accepted: `booking:${randomUUID()}:accepted`,
      snoozed: `booking:${randomUUID()}:snoozed`,
      pending: `booking:${randomUUID()}:pending`,
      foreignOnly: `booking:${randomUUID()}:foreign`,
    };
    const foreignAgentId = randomUUID();
    const [dismissed, accepted, snoozed, pending] = await Promise.all([
      seed({ id: randomUUID(), status: 'dismissed', sourceRef: refs.dismissed }),
      seed({ id: randomUUID(), status: 'accepted', sourceRef: refs.accepted }),
      seed({
        id: randomUUID(),
        status: 'snoozed',
        snoozedUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        sourceRef: refs.snoozed,
      }),
      seed({ id: randomUUID(), status: 'pending', sourceRef: refs.pending }),
    ]);
    await seed({ agentId: foreignAgentId, status: 'dismissed', sourceRef: refs.foreignOnly });
    const ownerPending = await seed({ status: 'pending', sourceRef: refs.foreignOnly });

    const repository = new FirestoreSuggestionRepository(store);
    expect(
      await repository.inactiveSourceRefs(agentId, [
        refs.dismissed,
        refs.accepted,
        refs.snoozed,
        refs.pending,
        refs.foreignOnly,
      ]),
    ).toEqual([refs.dismissed, refs.accepted, refs.snoozed]);

    const open = await repository.listOpen(agentId, now);
    expect(open.map((row) => row.id)).toEqual(
      expect.arrayContaining([pending.id, ownerPending.id]),
    );
    expect(open.map((row) => row.id)).not.toContain(dismissed.id);
    expect(open.map((row) => row.id)).not.toContain(accepted.id);
    expect(open.map((row) => row.id)).not.toContain(snoozed.id);
  });

  it('rejects more than 64 exact-source lookups before querying', async () => {
    const repository = new FirestoreSuggestionRepository(store);
    const refs = Array.from({ length: 65 }, (_, index) => `booking:${randomUUID()}:${index}`);
    await expect(repository.inactiveSourceRefs(agentId, refs)).rejects.toThrow(
      'Invalid suggestion identity batch',
    );
  });

  it('rejects a foreign conversation and does not launder an outward action', async () => {
    const { id, conversationId } = await seed();
    await store.doc('conversations', conversationId).update({ agentId: randomUUID() });
    await expect(decisions.decide(id, 'accepted')).rejects.toThrow('conversation');
    expect((await store.collection('tasks').get()).size).toBe(0);
    expect((await store.doc('suggestions', id).get()).get('status')).toBe('pending');
  });

  it('uses the owner primary chat when an imported suggestion has no conversation link', async () => {
    const { id, conversationId } = await seed({ conversationId: null });
    const result = await decisions.decide(id, 'accepted');
    expect(result.ok).toBe(true);
    expect((await store.doc('tasks', result.taskId as string).get()).get('conversationId')).toBe(
      conversationId,
    );
    expect((await store.doc('primaryConversations', agentId).get()).get('conversationId')).toBe(
      conversationId,
    );
  });

  it('requires an immediate decision for a dated briefing near its deadline', async () => {
    const { id } = await seed({
      origin: 'briefing',
      proposedAction: 'Set a reminder two days before 2026-09-26 about: a flight',
      expiresAt: new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(await decisions.decide(id, 'snoozed')).toEqual({
      ok: false,
      reason: 'This suggestion needs a decision sooner. Please accept or dismiss it now.',
    });
    expect((await store.doc('suggestions', id).get()).get('status')).toBe('pending');
  });
});
