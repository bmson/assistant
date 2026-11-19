/** Actual signed web grant and Firestore SDK removal proof; local demo emulator only. */
import { createHash, randomUUID } from 'node:crypto';
import { applyOwnerEditorCommand } from '@assistant/application/owner-editor';
import { createOwnerEditorDomain } from '@assistant/application/owner-editor-domain';
import { ownerEditorPath, parseOwnerEditorRequest } from '@assistant/application/owner-editor-wire';
import {
  createFirestoreOwnerEditorDomainStorage,
  createFirestoreOwnerEditorOperationRepository,
  createInstallationStore,
  readFirestoreOwnerEditorIssuanceContext,
  readFirestoreOwnerMemoryRemovalSnapshot,
} from '@assistant/firestore';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorApply,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { issueOwnerEditorFormGrant, verifyOwnerEditorHandle } from './owner-editor-scope';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const enabled = !!host && /^(127\.0\.0\.1|localhost):\d+$/.test(host);
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local Firestore emulator required');

const embeddingSpace = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!enabled)('signed saved-note removal on actual Firestore SDK emulator', () => {
  let store: ReturnType<typeof createInstallationStore> | undefined;

  afterEach(async () => {
    if (!store) return;
    try {
      await store.db.recursiveDelete(store.root);
    } finally {
      await store.db.terminate();
      store = undefined;
    }
  });

  it('rejects stale graph impact, then atomically removes and replays one exact saved-note operation', async () => {
    if (!host || !enabled) throw new Error('Allocated local demo Firestore emulator required');
    const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    const ownerId = randomUUID();
    const memoryId = randomUUID();
    const otherMemoryId = randomUUID();
    const firstRelationId = randomUUID();
    const lateRelationId = randomUUID();
    const retainedRelationId = randomUUID();
    const firstEntityId = randomUUID();
    const sharedEntityId = randomUUID();
    const retainedEntityId = randomUUID();
    const ownerEpoch = randomUUID();
    const now = new Date();
    const content = 'Synthetic note for emulator removal proof.';
    const otherContent = 'Synthetic unrelated retained note.';
    const contentHash = sha256(content);
    const otherContentHash = sha256(otherContent);
    const databaseId = `note-remove-${nonce}-test`;
    const installationId = `note-remove-test-${nonce}`;
    store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId,
      databaseId,
    });
    const currentStore = store;
    const epochName = `owner-editor-epoch:${ownerId}`;
    const batch = currentStore.db.batch();
    batch.set(currentStore.doc('agents', ownerId), { id: ownerId });
    batch.set(currentStore.doc('maintenanceCursors', epochName), {
      name: epochName,
      updatedAt: now,
      cursor: JSON.stringify({
        ownerId,
        epoch: ownerEpoch,
        ready: true,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
    const memory = (id: string, note: string, hash: string) => ({
      id,
      agentId: ownerId,
      category: 'knowledge',
      content: note,
      contentHash: hash,
      createdAt: now,
      source: 'manual',
      sourceTaskId: null,
      subjectContactId: null,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      kind: 'fact',
      domain: 'home',
      originTrust: 'known',
      ownerConfirmed: false,
      confidence: '0.70',
      importance: 3,
      pinned: false,
      validFrom: null,
      validUntil: null,
      goalId: null,
      embedding: [1, 0, 0],
      embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    });
    batch.set(currentStore.doc('memories', memoryId), memory(memoryId, content, contentHash));
    batch.set(
      currentStore.doc('memories', otherMemoryId),
      memory(otherMemoryId, otherContent, otherContentHash),
    );
    for (const [id, hash] of [
      [memoryId, contentHash],
      [otherMemoryId, otherContentHash],
    ] as const)
      batch.set(currentStore.doc('memoryContentHashes', hash), {
        contentHash: hash,
        memoryId: id,
        agentId: ownerId,
      });
    batch.set(currentStore.doc('knowledgeGraphSources', memoryId), {
      memoryId,
      agentId: ownerId,
      status: 'ready',
      contentHash,
      extractionVersion: 1,
    });
    for (const [id, label] of [
      [firstEntityId, 'Synthetic standalone item'],
      [sharedEntityId, 'Synthetic shared item'],
      [retainedEntityId, 'Synthetic unrelated item'],
    ] as const)
      batch.set(currentStore.doc('knowledgeGraphEntities', id), {
        id,
        agentId: ownerId,
        kind: 'topic',
        canonicalKey: `topic:${id}`,
        label,
        preferredLabel: null,
      });
    const relation = (
      id: string,
      sourceMemoryId: string,
      subjectEntityId: string,
      objectEntityId: string,
    ) => ({
      id,
      agentId: ownerId,
      sourceMemoryId,
      subjectEntityId,
      objectEntityId,
      predicate: 'related_to',
      confidence: '0.90',
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      validFrom: null,
      validUntil: null,
      evidenceQuote: 'Synthetic evidence only.',
      createdAt: now,
    });
    batch.set(
      currentStore.doc('knowledgeGraphRelations', firstRelationId),
      relation(firstRelationId, memoryId, firstEntityId, sharedEntityId),
    );
    batch.set(
      currentStore.doc('knowledgeGraphRelations', retainedRelationId),
      relation(retainedRelationId, otherMemoryId, sharedEntityId, retainedEntityId),
    );
    batch.set(currentStore.doc('ownerCards', ownerId), {
      agentId: ownerId,
      content: 'Synthetic stale card',
      compiledAt: now,
    });
    await batch.commit();

    const session = { ownerId, formSessionScope: 'synthetic_emulator_session_2026' };
    const secret = 'synthetic-note-removal-form-secret';
    const context = { ownerId, epoch: ownerEpoch, privacyGeneration: null };
    const grantFor = () =>
      issueOwnerEditorFormGrant({
        context,
        session,
        command: 'remove_owner_memory',
        targetId: memoryId,
        secret,
        now: now.getTime(),
      });
    const makeRequest = async (grant: ReturnType<typeof grantFor>) => {
      const preview = await readFirestoreOwnerMemoryRemovalSnapshot(
        currentStore,
        ownerId,
        memoryId,
      );
      if (!preview?.impact) throw new Error('Synthetic note removal impact unavailable');
      const scopeCheck = verifyOwnerEditorHandle({
        token: grant.issuedOperationHandle,
        session,
        secret,
        now: now.getTime(),
      });
      if (scopeCheck.kind !== 'verified') throw new Error('Synthetic grant did not verify');
      const request: OwnerEditorApply = {
        version: 1,
        intent: 'apply',
        command: 'remove_owner_memory',
        operationId: scopeCheck.scope.operationId,
        memoryId,
        expectedContentHash: preview.snapshot.contentHash,
        expectedMemoryRevision: preview.snapshot.revision,
        expectedImpactRevision: preview.impact.revision,
      };
      const parsed = parseOwnerEditorRequest(request, ownerEditorPath(request.command));
      if (!parsed.ok || parsed.request.intent !== 'apply')
        throw new Error('Synthetic removal request did not parse');
      return { preview, request: parsed.request, scope: scopeCheck.scope };
    };

    const staleGrant = grantFor();
    const stale = await makeRequest(staleGrant);
    if (!stale.preview.impact) throw new Error('Initial impact snapshot unavailable');
    expect(await readFirestoreOwnerEditorIssuanceContext(currentStore, ownerId)).toEqual(context);
    expect(stale.scope).toMatchObject({
      ownerId,
      epoch: ownerEpoch,
      command: 'remove_owner_memory',
      targetId: memoryId,
    });
    expect(stale.preview.impact).toMatchObject({
      connectionCount: 1,
      orphanedItems: [{ id: firstEntityId, label: 'Synthetic standalone item' }],
    });
    await currentStore
      .doc('knowledgeGraphRelations', lateRelationId)
      .set(relation(lateRelationId, memoryId, firstEntityId, sharedEntityId));
    const storage = createFirestoreOwnerEditorDomainStorage(currentStore, ownerId, embeddingSpace);
    const domain = createOwnerEditorDomain({
      storage,
      router: {
        embeddingSpace: async () => embeddingSpace,
        embed: async () => [[1, 0, 0]],
      },
    });
    const operations = createFirestoreOwnerEditorOperationRepository(currentStore, ownerId);
    const staleReply = await applyOwnerEditorCommand({
      request: stale.request,
      scope: stale.scope,
      domain,
      operations,
      now: () => now,
    });
    expect(staleReply).toMatchObject({
      authority: 'operation_receipt',
      command: 'remove_owner_memory',
      outcome: 'conflict',
    });
    expect((await currentStore.doc('memories', memoryId).get()).exists).toBe(true);
    expect((await currentStore.doc('memoryTombstones', contentHash).get()).exists).toBe(false);
    expect((await currentStore.doc('graphDeletionIntents', memoryId).get()).exists).toBe(false);
    expect((await currentStore.doc('ownerCards', ownerId).get()).get('content')).toBe(
      'Synthetic stale card',
    );

    const grant = grantFor();
    const fresh = await makeRequest(grant);
    if (!fresh.preview.impact) throw new Error('Fresh impact snapshot unavailable');
    expect(fresh.preview.impact).toMatchObject({
      connectionCount: 2,
      orphanedItems: [{ id: firstEntityId, label: 'Synthetic standalone item' }],
    });
    const reply = await applyOwnerEditorCommand({
      request: fresh.request,
      scope: fresh.scope,
      domain,
      operations,
      now: () => now,
    });
    expect(reply).toMatchObject({
      authority: 'operation_receipt',
      command: 'remove_owner_memory',
      outcome: 'saved',
      ids: { memoryId },
      refreshPending: true,
    });
    expect(
      await applyOwnerEditorCommand({
        request: fresh.request,
        scope: fresh.scope,
        domain,
        operations,
        now: () => now,
      }),
    ).toEqual(reply);
    expect((await operations.lookup(fresh.scope, now)).reply).toEqual(reply);

    const [removed, tombstone, hashRow, fence, card, retainedMemory, retainedRelation, receipt] =
      await Promise.all([
        currentStore.doc('memories', memoryId).get(),
        currentStore.doc('memoryTombstones', contentHash).get(),
        currentStore.doc('memoryContentHashes', contentHash).get(),
        currentStore.doc('graphDeletionIntents', memoryId).get(),
        currentStore.doc('ownerCards', ownerId).get(),
        currentStore.doc('memories', otherMemoryId).get(),
        currentStore.doc('knowledgeGraphRelations', retainedRelationId).get(),
        currentStore.doc('ownerEditorOperations', ownerEditorOperationId(fresh.scope)).get(),
      ]);
    expect(removed.exists).toBe(false);
    expect(tombstone).toMatchObject({ exists: true });
    expect(tombstone.get('reason')).toBe('owner_forget');
    expect(hashRow.exists).toBe(false);
    expect(fence).toMatchObject({ exists: true });
    expect(fence.get('memoryId')).toBe(memoryId);
    expect(fence.get('agentId')).toBe(ownerId);
    expect(card.get('content')).toBe('');
    expect(retainedMemory.get('content')).toBe(otherContent);
    expect(retainedRelation.get('sourceMemoryId')).toBe(otherMemoryId);
    expect(receipt.get('result')).toMatchObject({ outcome: 'saved', ids: { memoryId } });
  });
});
