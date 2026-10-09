import type { OwnerCommitment } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function commitment(input: Partial<OwnerCommitment> & Pick<OwnerCommitment, 'id' | 'title'>) {
  const { id, title, ...fields } = input;
  return {
    id,
    agentId: 'owner-agent',
    conversationId: 'conversation',
    sourceMessageId: null,
    sourceTaskId: null,
    sourceOccurrenceKey: null,
    reopenedFromId: null,
    reopenOperationId: null,
    kind: 'promise',
    title,
    details: '',
    nextAction: '',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.90',
    contentHash: input.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  } satisfies OwnerCommitment;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner context', () => {
  let store: InstallationStore;
  let repository: FirestoreOwnerContextRepository;

  beforeEach(async () => {
    store = emulatorStore(() => NOW);
    repository = new FirestoreOwnerContextRepository(store);
    await store.doc('conversations', 'conversation').set({
      id: 'conversation',
      agentId: 'owner-agent',
      metadata: {},
    });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('reads the agent-addressed owner card and fails closed on foreign contents', async () => {
    await store.doc('ownerCards', 'owner-agent').set({
      agentId: 'owner-agent',
      content: 'Private owner profile',
      compiledAt: NOW,
    });
    await expect(repository.getOwnerCard('owner-agent')).resolves.toEqual({
      content: 'Private owner profile',
      compiledAt: NOW,
    });
    await expect(repository.getOwnerCard('foreign-agent')).resolves.toBeNull();

    await store.doc('ownerCards', 'owner-agent').set({
      agentId: 'foreign-agent',
      content: 'Foreign profile in a corrupted path',
      compiledAt: NOW,
    });
    await expect(repository.getOwnerCard('owner-agent')).resolves.toBeNull();
  });

  it('returns only the newest location inside the requested retention and source scope', async () => {
    const rows = [
      {
        id: 'old',
        agentId: 'owner-agent',
        lat: '1.000000',
        lng: '1.000000',
        label: 'Old',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: null,
        capturedAt: new Date('2026-09-12T10:00:00Z'),
        createdAt: NOW,
      },
      {
        id: 'shortcut',
        agentId: 'owner-agent',
        lat: '2.000000',
        lng: '2.000000',
        label: 'Shortcut',
        accuracyM: 10,
        source: 'shortcut',
        timeZone: null,
        capturedAt: new Date('2026-09-12T11:58:00Z'),
        createdAt: NOW,
      },
      {
        id: 'latest',
        agentId: 'owner-agent',
        lat: '3.000000',
        lng: '3.000000',
        label: 'Latest',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: null,
        capturedAt: new Date('2026-09-12T11:59:00Z'),
        createdAt: NOW,
      },
      {
        id: 'foreign',
        agentId: 'foreign-agent',
        lat: '4.000000',
        lng: '4.000000',
        label: 'Foreign',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: null,
        capturedAt: NOW,
        createdAt: NOW,
      },
    ];
    await Promise.all(rows.map((row) => store.doc('locationPings', row.id).set(row)));
    const input = {
      agentId: 'owner-agent',
      notBefore: new Date('2026-09-12T11:30:00Z'),
      notAfter: NOW,
    };
    await expect(repository.getLatestLocation(input)).resolves.toMatchObject({ id: 'latest' });
    await expect(
      repository.getLatestLocation({ ...input, source: 'shortcut' }),
    ).resolves.toMatchObject({ id: 'shortcut' });
    await expect(
      repository.getLatestLocation({
        ...input,
        notBefore: new Date('2026-09-12T11:59:30Z'),
      }),
    ).resolves.toBeNull();
  });

  it('returns open and elapsed snoozes in updated order within agent scope', async () => {
    const futureSnoozes = Array.from({ length: 101 }, (_, index) =>
      commitment({
        id: `sleeping-${index}`,
        title: `Future snooze ${index}`,
        status: 'snoozed',
        snoozedUntil: new Date('2026-09-13T10:00:00Z'),
        updatedAt: new Date(NOW.getTime() - index * 1000),
      }),
    );
    const rows = [
      commitment({
        id: 'older-open',
        title: 'Older open',
        updatedAt: new Date('2026-09-12T09:00:00Z'),
      }),
      commitment({
        id: 'newer-open',
        title: 'Newer open',
        updatedAt: new Date('2026-09-12T11:00:00Z'),
      }),
      commitment({
        id: 'elapsed',
        title: 'Elapsed snooze',
        status: 'snoozed',
        snoozedUntil: new Date('2026-09-12T10:00:00Z'),
        updatedAt: new Date('2026-09-12T10:30:00Z'),
      }),
      ...futureSnoozes,
      commitment({ id: 'resolved', title: 'Resolved', status: 'resolved' }),
      commitment({ id: 'foreign', title: 'Foreign', agentId: 'foreign-agent' }),
    ];
    const batch = store.db.batch();
    for (const row of rows) batch.set(store.doc('commitments', row.id), row);
    await batch.commit();
    const found = await repository.listOpenCommitments({
      agentId: 'owner-agent',
      now: NOW,
      limit: 3,
    });
    expect(found.map((row) => row.id)).toEqual(['newer-open', 'elapsed', 'older-open']);
  });

  it('filters direct fixture rows and missing or mismatched source provenance', async () => {
    await store.doc('conversations', 'ordinary-conversation').set({
      id: 'ordinary-conversation',
      agentId: 'owner-agent',
      metadata: {},
    });
    await store.doc('conversations', 'legacy-conversation').set({
      id: 'legacy-conversation',
      agentId: 'owner-agent',
    });
    await store.doc('conversations', 'malformed-metadata-conversation').set({
      id: 'malformed-metadata-conversation',
      agentId: 'owner-agent',
      metadata: 'malformed',
    });
    await store.doc('conversations', 'fixture-conversation').set({
      id: 'fixture-conversation',
      agentId: 'owner-agent',
      metadata: { visualQaRunId: 'fixture-run' },
    });
    const sourceRows = [
      {
        id: 'ordinary-source',
        conversationId: 'ordinary-conversation',
        role: 'user',
        channelMessageId: 'gmail-message-1',
        hiddenAt: null,
      },
      {
        id: 'visual-source',
        conversationId: 'ordinary-conversation',
        role: 'user',
        channelMessageId: 'visual-qa:run:commitment',
        hiddenAt: null,
      },
      {
        id: 'readability-source',
        conversationId: 'ordinary-conversation',
        role: 'user',
        channelMessageId: 'readability-run-01-user',
        hiddenAt: null,
      },
      {
        id: 'foreign-conversation-source',
        conversationId: 'other-conversation',
        role: 'user',
        channelMessageId: null,
        hiddenAt: null,
      },
    ];
    await Promise.all(sourceRows.map((row) => store.doc('messages', row.id).set(row)));
    const rows = [
      commitment({
        id: 'ordinary-source-free',
        title: 'Legitimate source-free owner loop',
        conversationId: 'ordinary-conversation',
        sourceMessageId: null,
        sourceOccurrenceKey: null,
      }),
      (() => {
        const legacy = commitment({
          id: 'legacy-source-free',
          title: 'Legacy source-free owner loop',
          conversationId: 'legacy-conversation',
          sourceMessageId: null,
        });
        // Old portable rows predate the nullable occurrence-key field.
        delete (legacy as Partial<OwnerCommitment>).sourceOccurrenceKey;
        return legacy;
      })(),
      commitment({
        id: 'empty-occurrence-key',
        title: 'Malformed empty occurrence key',
        conversationId: 'ordinary-conversation',
        sourceMessageId: null,
        sourceOccurrenceKey: '',
      }),
      commitment({
        id: 'ordinary-manual-reopen',
        title: 'Owner reopened source-free loop',
        conversationId: 'ordinary-conversation',
        sourceMessageId: null,
        reopenedFromId: 'closed-source-row',
        reopenOperationId: 'owner-reopen-op',
        sourceOccurrenceKey: 'manual-reopen:v1:owner-agent:owner-reopen-op',
      }),
      commitment({
        id: 'ordinary-source-backed',
        title: 'Ordinary cited owner loop',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'ordinary-source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:ordinary-source',
      }),
      commitment({
        id: 'malformed-metadata',
        title: 'Malformed conversation metadata',
        conversationId: 'malformed-metadata-conversation',
        sourceMessageId: null,
      }),
      commitment({
        id: 'direct-fixture-conversation',
        title: 'Direct fixture owner loop',
        conversationId: 'fixture-conversation',
        sourceMessageId: null,
      }),
      commitment({
        id: 'readability-source-id',
        title: 'Readability source identity',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'readability-run:source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:readability-id',
      }),
      commitment({
        id: 'fixture-source-id',
        title: 'Tagged source identity',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'visual-qa:run:source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:source',
      }),
      commitment({
        id: 'fixture-source-message',
        title: 'Tagged source message',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'visual-source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:visual',
      }),
      commitment({
        id: 'readability-source-message',
        title: 'Readability source message',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'readability-source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:readability',
      }),
      commitment({
        id: 'missing-source-message',
        title: 'Missing source message',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'deleted-source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:deleted',
      }),
      commitment({
        id: 'mismatched-source-conversation',
        title: 'Mismatched source conversation',
        conversationId: 'ordinary-conversation',
        sourceMessageId: 'foreign-conversation-source',
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:foreign',
      }),
      commitment({
        id: 'lost-source-reference',
        title: 'Lost source reference',
        conversationId: 'ordinary-conversation',
        sourceMessageId: null,
        sourceOccurrenceKey: 'v1:owner-agent:ordinary-conversation:promise:deleted',
      }),
    ];
    const batch = store.db.batch();
    for (const row of rows) batch.set(store.doc('commitments', row.id), row);
    await batch.commit();

    const found = await repository.listOpenCommitments({
      agentId: 'owner-agent',
      now: NOW,
      limit: 20,
    });
    expect(found.map((row) => row.id).sort()).toEqual(
      [
        'ordinary-source-free',
        'legacy-source-free',
        'ordinary-manual-reopen',
        'ordinary-source-backed',
      ].sort(),
    );
  });

  it('continues through fixture-only pages to return older ordinary commitments', async () => {
    await store.doc('conversations', 'ordinary-paged').set({
      id: 'ordinary-paged',
      agentId: 'owner-agent',
      metadata: {},
    });
    await store.doc('conversations', 'fixture-paged').set({
      id: 'fixture-paged',
      agentId: 'owner-agent',
      metadata: { visualQaRunId: 'fixture-paged-run' },
    });
    const batch = store.db.batch();
    for (let index = 0; index < 101; index += 1) {
      const row = commitment({
        id: `fixture-page-${index.toString().padStart(3, '0')}`,
        title: `Fixture page ${index}`,
        conversationId: 'fixture-paged',
        updatedAt: new Date(NOW.getTime() - index),
      });
      batch.set(store.doc('commitments', row.id), row);
    }
    const ordinary = commitment({
      id: 'ordinary-after-fixtures',
      title: 'Ordinary after fixture page',
      conversationId: 'ordinary-paged',
      updatedAt: new Date(NOW.getTime() - 10_000),
    });
    batch.set(store.doc('commitments', ordinary.id), ordinary);
    await batch.commit();

    await expect(
      repository.listOpenCommitments({ agentId: 'owner-agent', now: NOW, limit: 1 }),
    ).resolves.toMatchObject([{ id: ordinary.id }]);
  });

  it('does not substitute a different conversation row returned by an identity-mismatched path', async () => {
    await store.doc('conversations', 'conversation-path-a').set({
      id: 'conversation-path-b',
      agentId: 'owner-agent',
      metadata: { visualQaRunId: 'the-real-path-a-is-fixture' },
    });
    await store.doc('conversations', 'conversation-path-b').set({
      id: 'conversation-path-a',
      agentId: 'owner-agent',
      metadata: {},
    });
    await store.doc('conversations', 'conversation-path-c').set({
      id: 'conversation-path-c',
      agentId: 'owner-agent',
      metadata: {},
    });
    const pathA = commitment({
      id: 'swapped-conversation-path-a',
      title: 'Must not substitute path A',
      conversationId: 'conversation-path-a',
    });
    const pathB = commitment({
      id: 'swapped-conversation-path-b',
      title: 'Must not substitute path B',
      conversationId: 'conversation-path-b',
    });
    const ordinary = commitment({
      id: 'ordinary-conversation-path-c',
      title: 'Valid ordinary conversation control',
      conversationId: 'conversation-path-c',
    });
    await Promise.all(
      [pathA, pathB, ordinary].map((row) => store.doc('commitments', row.id).set(row)),
    );

    const found = await repository.listOpenCommitments({
      agentId: 'owner-agent',
      now: NOW,
      limit: 5,
    });
    const foundIds = found.map((candidate) => candidate.id);
    expect(foundIds).toContain(ordinary.id);
    expect(foundIds).not.toContain(pathA.id);
    expect(foundIds).not.toContain(pathB.id);
  });

  it('does not substitute a different message row returned by an identity-mismatched path', async () => {
    await store.doc('conversations', 'ordinary-message-parent').set({
      id: 'ordinary-message-parent',
      agentId: 'owner-agent',
      metadata: {},
    });
    await store.doc('messages', 'message-path-a').set({
      id: 'message-path-b',
      conversationId: 'ordinary-message-parent',
      role: 'user',
      channelMessageId: 'visual-qa:the-real-path-a-is-fixture',
      hiddenAt: null,
    });
    await store.doc('messages', 'message-path-b').set({
      id: 'message-path-a',
      conversationId: 'ordinary-message-parent',
      role: 'user',
      channelMessageId: 'ordinary-owner-message',
      hiddenAt: null,
    });
    await store.doc('messages', 'message-path-c').set({
      id: 'message-path-c',
      conversationId: 'ordinary-message-parent',
      role: 'user',
      channelMessageId: 'ordinary-control-message',
      hiddenAt: null,
    });
    const pathA = commitment({
      id: 'swapped-message-path-a',
      title: 'Must not substitute message path A',
      conversationId: 'ordinary-message-parent',
      sourceMessageId: 'message-path-a',
      sourceOccurrenceKey: 'v1:owner-agent:ordinary-message-parent:promise:message-path-a',
    });
    const pathB = commitment({
      id: 'swapped-message-path-b',
      title: 'Must not substitute message path B',
      conversationId: 'ordinary-message-parent',
      sourceMessageId: 'message-path-b',
      sourceOccurrenceKey: 'v1:owner-agent:ordinary-message-parent:promise:message-path-b',
    });
    const ordinary = commitment({
      id: 'ordinary-message-path-c',
      title: 'Valid ordinary message control',
      conversationId: 'ordinary-message-parent',
      sourceMessageId: 'message-path-c',
      sourceOccurrenceKey: 'v1:owner-agent:ordinary-message-parent:promise:message-path-c',
    });
    await Promise.all(
      [pathA, pathB, ordinary].map((row) => store.doc('commitments', row.id).set(row)),
    );

    const found = await repository.listOpenCommitments({
      agentId: 'owner-agent',
      now: NOW,
      limit: 5,
    });
    const foundIds = found.map((candidate) => candidate.id);
    expect(foundIds).toContain(ordinary.id);
    expect(foundIds).not.toContain(pathA.id);
    expect(foundIds).not.toContain(pathB.id);
  });

  it('rejects a commitment whose stored identity does not match its document path', async () => {
    await store
      .doc('commitments', 'document-id')
      .set(commitment({ id: 'different-id', title: 'Corrupted identity' }));
    await expect(
      repository.listOpenCommitments({ agentId: 'owner-agent', now: NOW, limit: 5 }),
    ).resolves.toEqual([]);
  });
});
