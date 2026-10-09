import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreRecallSurfacingRepository } from './recall-surfacing.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore recall surfacing ledger', () => {
  let store: InstallationStore;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const conversationId = randomUUID();
  const sourceKey = 'a'.repeat(64);
  const sourceRevision = 'b'.repeat(64);

  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-10-07T12:00:00Z'));
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('conversations', conversationId).set({ id: conversationId, agentId }),
    ]);
  });

  afterEach(async () => disposeStore(store));

  it('writes only opaque source identity with the assistant reply and applies owner controls', async () => {
    const result = await new FirestoreMessageRepository(store).append({
      conversationId,
      role: 'assistant',
      origin: 'assistant',
      text: 'A remembered detail.',
      parts: [
        { type: 'text', text: 'A remembered detail.' },
        { type: 'recall', sources: [{ surfaceKey: sourceKey, sourceRevision, kind: 'chat' }] },
      ],
    });
    expect(result).toBeDefined();
    const repository = new FirestoreRecallSurfacingRepository(store);
    expect(await repository.suppressed(agentId, [sourceKey])).toEqual(new Set());
    const records = await repository.list(agentId);
    expect(records).toEqual([
      expect.objectContaining({
        agentId,
        sourceKey,
        sourceRevision,
        kind: 'chat',
        lastMessageId: result?.id,
        surfaceCount: 1,
        suppressedAt: null,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('A remembered detail');
    await expect(
      repository.setSuppressed({
        agentId,
        sourceKey,
        expectedSourceRevision: sourceRevision,
        expectedVersion: 1,
        suppressed: true,
      }),
    ).resolves.toEqual({ ok: true, version: 2 });
    expect(await repository.suppressed(agentId, [sourceKey])).toEqual(new Set([sourceKey]));
    expect(
      await repository.suppressed(agentId, [sourceKey], { [sourceKey]: 'd'.repeat(64) }),
    ).toEqual(new Set());
    expect(
      await repository.suppressed(agentId, [sourceKey], { [sourceKey]: sourceRevision }),
    ).toEqual(new Set([sourceKey]));
    const revised = 'd'.repeat(64);
    await new FirestoreMessageRepository(store).append({
      conversationId,
      role: 'assistant',
      origin: 'assistant',
      text: 'A corrected remembered detail.',
      parts: [
        {
          type: 'recall',
          sources: [{ surfaceKey: sourceKey, sourceRevision: revised, kind: 'chat' }],
        },
      ],
    });
    expect(await repository.suppressed(agentId, [sourceKey], { [sourceKey]: revised })).toEqual(
      new Set(),
    );
    expect(await repository.list(agentId)).toEqual([
      expect.objectContaining({
        sourceRevision: revised,
        suppressedAt: null,
        version: 3,
        surfaceCount: 2,
      }),
    ]);
    await expect(
      repository.setSuppressed({
        agentId: foreignAgentId,
        sourceKey,
        expectedSourceRevision: sourceRevision,
        suppressed: false,
      }),
    ).resolves.toEqual({ ok: false });
  });

  it('refuses writes while owner erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(
      new FirestoreMessageRepository(store).append({
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'A remembered detail.',
        parts: [
          { type: 'recall', sources: [{ surfaceKey: sourceKey, sourceRevision, kind: 'chat' }] },
        ],
      }),
    ).rejects.toThrow('Privacy erasure is in progress');
    expect(await store.collection('recallSurfaces').get()).toMatchObject({ empty: true });
  });

  it('fails closed when a deterministic ledger document contains another source identity', async () => {
    const repository = new FirestoreRecallSurfacingRepository(store);
    await repository.recordSurfaced({
      agentId,
      messageId: randomUUID(),
      refs: [{ sourceKey, sourceRevision, kind: 'chat' }],
    });
    const [row] = await repository.list(agentId);
    if (!row) throw new Error('Expected a recall ledger row');
    await store.doc('recallSurfaces', row.id).update({ sourceKey: 'c'.repeat(64) });
    await expect(repository.suppressed(agentId, [sourceKey])).rejects.toThrow(
      'Recall surface ownership mismatch',
    );
  });
});
