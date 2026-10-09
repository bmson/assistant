import { describe, expect, it, vi } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import { decodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreWatchRepository } from './watches.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore watches', () => {
  it('creates owner-scoped watches and enforces cancellation ownership', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'notify',
        name: 'Recruiter',
        match: { expectedSenderEmails: ['recruiter@example.com'] },
        maxFires: null,
        expiresAt: new Date('2026-10-19T12:00:00Z'),
      });
      expect((await repository.list('agent-a')).map((row) => row.id)).toContain(watch.id);
      const history = await new FirestoreApplicationChatPersistence(store).listConversations(
        'agent-a',
        { archived: false, limit: 10 },
      );
      expect(history.conversations.map((conversation) => conversation.id)).toContain(
        watch.conversationId,
      );
      expect(await repository.list('agent-b')).toEqual([]);
      expect(await repository.cancel('agent-b', watch.id, now)).toBeNull();
      expect(await repository.cancel('agent-a', watch.id, now)).toEqual({
        status: 'cancelled',
        cancelled: true,
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('deduplicates a trigger and serializes distinct fires at maxFires', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'notify',
        name: 'Bounded',
        match: {},
        maxFires: 2,
        expiresAt: new Date('2026-10-19T12:00:00Z'),
      });
      const fire = (triggerRef: string) =>
        repository.recordFire({
          watchId: watch.id,
          agentId: 'agent-a',
          triggerRef,
          summary: triggerRef,
          excerpt: '',
          now,
        });
      const duplicate = await Promise.all([fire('gmail:one'), fire('gmail:one')]);
      expect(duplicate.filter((result) => result.recorded)).toHaveLength(1);
      const distinct = await Promise.all([fire('gmail:two'), fire('gmail:three')]);
      expect(distinct.filter((result) => result.recorded)).toHaveLength(1);
      const saved = decodeRecord<{ fireCount: number; status: string }>(
        (await store.doc('watches', watch.id).get()).data(),
      );
      expect(saved).toMatchObject({ fireCount: 2, status: 'fired' });
      const fires = await store.collection('watchFires').where('watchId', '==', watch.id).get();
      expect(fires.size).toBe(2);
    } finally {
      await disposeStore(store);
    }
  });

  it('expires due watches and claims each due web poll once', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const active = await repository.create({
        agentId: 'agent-a',
        kind: 'web',
        tier: 'notify',
        name: 'Page',
        match: { url: 'https://example.com', mode: 'change' },
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
        nextPollAt: now,
        pollIntervalSeconds: 60,
      });
      const expired = await repository.create({
        agentId: 'agent-a',
        kind: 'web',
        tier: 'notify',
        name: 'Old',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-18T12:00:00Z'),
        nextPollAt: now,
      });
      expect(await repository.expire('agent-a', now)).toBe(1);
      const claims = await Promise.all([
        repository.claimDueWeb(now, 10, 3600),
        repository.claimDueWeb(now, 10, 3600),
      ]);
      expect(claims.flat().map((row) => row.id)).toEqual([active.id]);
      expect((await store.doc('watches', expired.id).get()).get('status')).toBe('expired');

      const staleClaim = claims.flat()[0];
      if (!staleClaim?.nextPollAt) throw new Error('missing first claim');
      const newer = await repository.claimDueWeb(staleClaim.nextPollAt, 10, 3600);
      expect(newer).toHaveLength(1);
      expect(
        await repository.updateWeb({
          watchId: active.id,
          state: { fingerprint: 'stale' },
          now,
          expectedNextPollAt: staleClaim.nextPollAt,
        }),
      ).toBe(false);
      expect((await store.doc('watches', active.id).get()).get('state')).toEqual({});
      expect(
        await repository.recordFire({
          watchId: active.id,
          agentId: 'agent-a',
          triggerRef: 'web:stale',
          summary: 'stale',
          excerpt: '',
          state: { fingerprint: 'stale-fire' },
          now,
          expectedNextPollAt: staleClaim.nextPollAt,
        }),
      ).toMatchObject({ recorded: false });
      expect((await store.doc('watches', active.id).get()).get('state')).toEqual({});
      expect(
        await store.collection('watchFires').where('watchId', '==', active.id).get(),
      ).toHaveProperty('size', 0);
    } finally {
      await disposeStore(store);
    }
  });

  it('does not overwrite cancellation while expiring the same due watch', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'notify',
        name: 'Race',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-19T11:00:00Z'),
      });
      const [cancelled] = await Promise.all([
        repository.cancel('agent-a', watch.id, now),
        repository.expire('agent-a', now),
      ]);
      const status = (await store.doc('watches', watch.id).get()).get('status');
      if (cancelled?.cancelled) expect(status).toBe('cancelled');
      else expect(status).toBe('expired');
    } finally {
      await disposeStore(store);
    }
  });

  it('advances malformed legacy poll intervals with the positive default', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'web',
        tier: 'notify',
        name: 'Legacy interval',
        match: { url: 'https://example.com', mode: 'change' },
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
        nextPollAt: now,
        pollIntervalSeconds: -60,
      });
      const [claimed] = await repository.claimDueWeb(now, 10, 300);
      expect(claimed?.id).toBe(watch.id);
      expect(claimed?.nextPollAt).toEqual(new Date(now.getTime() + 300_000));
      await expect(repository.claimDueWeb(now, 10, 0)).rejects.toThrow(
        'default web watch poll interval must be positive',
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('serializes suggestion commits and rejects a foreign conversation reference', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'suggest',
        name: 'Suggestion race',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
      });
      await store.doc('conversations', 'foreign').set({
        id: 'foreign',
        agentId: 'agent-b',
        channel: 'chat',
        trust: 'owner',
        title: 'Foreign',
        archived: false,
        createdAt: now,
        updatedAt: now,
      });
      await store.doc('watches', watch.id).update({ conversationId: 'foreign' });
      await repository.recordFire({
        watchId: watch.id,
        agentId: 'agent-a',
        triggerRef: 'gmail:race',
        summary: 'race',
        excerpt: 'reply requested',
        now,
      });
      const input = {
        agentId: 'agent-a',
        watchId: watch.id,
        triggerRef: 'gmail:race',
        summary: 'Reply?',
        proposedAction: 'Draft a reply.',
        now,
      };
      const results = await Promise.all([
        repository.commitSuggestion(input),
        repository.commitSuggestion(input),
        repository.commitSuggestion(input),
      ]);
      expect(results[0]?.suggestion.id).toBe(results[1]?.suggestion.id);
      expect(results[1]?.suggestion.id).toBe(results[2]?.suggestion.id);
      expect(results[0]?.suggestion.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(results[0]?.conversationId).not.toBe('foreign');
      const destination = await store.doc('conversations', results[0]?.conversationId ?? '').get();
      expect(destination.get('agentId')).toBe('agent-a');
      expect(destination.get('title')).toBe('Notifications');
      expect(
        (await store.collection('suggestions').where('agentId', '==', 'agent-a').get()).size,
      ).toBe(1);
      expect(
        (await store.collection('conversations').where('title', '==', 'Notifications').get()).size,
      ).toBe(1);
      const prepared = await repository.getPreparedSuggestion({
        agentId: 'agent-a',
        watchId: watch.id,
        triggerRef: 'gmail:race',
      });
      expect(prepared?.effect.kind).toBe('suggestion_message');
      expect(prepared?.effect.status).toBe('pending');
      await store.doc('watches', watch.id).delete();
      await expect(
        repository.getPreparedSuggestion({
          agentId: 'agent-a',
          watchId: watch.id,
          triggerRef: 'gmail:race',
        }),
      ).resolves.toMatchObject({
        suggestion: { status: 'pending' },
        effect: { kind: 'suggestion_message', status: 'pending' },
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('reuses imported random IDs and repairs a foreign suggestion conversation', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'suggest',
        name: 'Imported suggestion',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
      });
      await store.doc('conversations', 'foreign').set({
        id: 'foreign',
        agentId: 'agent-b',
        title: 'Foreign',
      });
      await store.doc('watches', watch.id).update({ conversationId: 'foreign' });
      await repository.recordFire({
        watchId: watch.id,
        agentId: 'agent-a',
        triggerRef: 'gmail:imported',
        summary: 'imported',
        excerpt: '',
        now,
      });
      await store.doc('conversations', 'imported-notifications').set({
        id: 'imported-notifications',
        agentId: 'agent-a',
        title: 'Notifications',
      });
      await store.doc('suggestions', 'imported-suggestion').set({
        id: 'imported-suggestion',
        agentId: 'agent-a',
        conversationId: 'foreign',
        sourceRef: `watch:${watch.id}:gmail:imported`,
        status: 'pending',
      });
      const input = {
        agentId: 'agent-a',
        watchId: watch.id,
        triggerRef: 'gmail:imported',
        summary: 'Imported',
        proposedAction: 'Act',
        now,
      };
      const results = await Promise.all([
        repository.commitSuggestion(input),
        repository.commitSuggestion(input),
      ]);
      expect(results.map((result) => result?.suggestion.id)).toEqual([
        'imported-suggestion',
        'imported-suggestion',
      ]);
      expect(results.map((result) => result?.conversationId)).toEqual([
        'imported-notifications',
        'imported-notifications',
      ]);
      expect(
        (await store.doc('suggestions', 'imported-suggestion').get()).get('conversationId'),
      ).toBe('imported-notifications');
      expect((await store.collection('suggestions').get()).size).toBe(1);
      expect(
        (await store.collection('conversations').where('title', '==', 'Notifications').get()).size,
      ).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('repairs a commit interrupted between conversation and suggestion writes', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'suggest',
        name: 'Recovery',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
      });
      if (!watch.conversationId) throw new Error('missing watch conversation');
      await store.doc('conversations', watch.conversationId).delete();
      await repository.recordFire({
        watchId: watch.id,
        agentId: 'agent-a',
        triggerRef: 'gmail:recovery',
        summary: 'recovery',
        excerpt: '',
        now,
      });
      const input = {
        agentId: 'agent-a',
        watchId: watch.id,
        triggerRef: 'gmail:recovery',
        summary: 'Recover',
        proposedAction: 'Act',
        now,
      };
      const first = await repository.commitSuggestion(input);
      if (!first) throw new Error('missing first suggestion');
      expect(first.suggestion.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      await store.doc('suggestions', first.suggestion.id).delete();
      const recovered = await repository.commitSuggestion(input);
      expect(recovered?.suggestion.id).toBe(first.suggestion.id);
      expect(recovered?.conversationId).toBe(first.conversationId);
      expect((await store.collection('suggestions').get()).size).toBe(1);
      expect(
        (await store.collection('conversations').where('title', '==', 'Notifications').get()).size,
      ).toBe(1);

      await store.doc('conversations', first.conversationId).delete();
      const recreated = await repository.commitSuggestion(input);
      expect(recreated?.conversationId).toBe(first.conversationId);
      expect(recreated?.suggestion.conversationId).toBe(first.conversationId);
      expect((await store.doc('conversations', first.conversationId).get()).get('agentId')).toBe(
        'agent-a',
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('does not overwrite a newer owner-scoped suggestion destination', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'suggest',
        name: 'Destination race',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
      });
      await store.doc('conversations', 'foreign').set({
        id: 'foreign',
        agentId: 'agent-b',
        title: 'Foreign',
      });
      await store.doc('conversations', 'new-owner-destination').set({
        id: 'new-owner-destination',
        agentId: 'agent-a',
        title: 'Owner destination',
      });
      await store.doc('watches', watch.id).update({ conversationId: 'foreign' });
      await repository.recordFire({
        watchId: watch.id,
        agentId: 'agent-a',
        triggerRef: 'gmail:destination-race',
        summary: 'race',
        excerpt: '',
        now,
      });
      const suggestionRef = store.doc('suggestions', 'legacy-race');
      await suggestionRef.set({
        id: 'legacy-race',
        agentId: 'agent-a',
        sourceRef: `watch:${watch.id}:gmail:destination-race`,
        conversationId: 'foreign',
      });

      const prototype = Object.getPrototypeOf(suggestionRef) as {
        update: typeof suggestionRef.update;
      };
      const originalUpdate = prototype.update;
      let injected = false;
      const updateSpy = vi.spyOn(prototype, 'update').mockImplementation(function (
        this: typeof suggestionRef,
        ...args
      ) {
        if (this.path === suggestionRef.path && !injected) {
          injected = true;
          const competingUpdate = Reflect.apply(originalUpdate, this, [
            { conversationId: 'new-owner-destination', updatedAt: now },
          ]) as ReturnType<typeof suggestionRef.update>;
          return competingUpdate.then(() => Reflect.apply(originalUpdate, this, args));
        }
        return Reflect.apply(originalUpdate, this, args);
      });
      try {
        const result = await repository.commitSuggestion({
          agentId: 'agent-a',
          watchId: watch.id,
          triggerRef: 'gmail:destination-race',
          summary: 'Race',
          proposedAction: 'Act',
          now,
        });
        expect(injected).toBe(true);
        expect(result?.conversationId).toBe('new-owner-destination');
        expect(result?.suggestion.conversationId).toBe('new-owner-destination');
        expect((await suggestionRef.get()).get('conversationId')).toBe('new-owner-destination');
      } finally {
        updateSpy.mockRestore();
      }
    } finally {
      await disposeStore(store);
    }
  });
});
