import { createHash, randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { notificationDashboardMessageId } from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreMemoryRepository } from './memory.js';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore privacy erasure', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

  it('erases all owner domains, retains tombstones, and resumes after interruption', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const foreignId = randomUUID();
    const memoryId = randomUUID();
    const ownerlessOrphanMemoryId = randomUUID();
    const foreignOccasionId = randomUUID();
    const occasionId = randomUUID();
    const relationId = randomUUID();
    const assertionId = randomUUID();
    const assertionEvidenceId = randomUUID();
    const entityId = randomUUID();
    const aliasId = randomUUID();
    const packId = randomUUID();
    const previewId = randomUUID();
    const importId = randomUUID();
    const preparedId = randomUUID();
    const taskId = randomUUID();
    const sampleId = randomUUID();
    const hash = `privacy-${randomUUID()}`;
    const sourceTags = ['takeout-private', 'takeout-legacy', 'takeout-foreign'];
    const memoryLineageIds = sourceTags.slice(0, 2).map((source) =>
      createHash('sha256')
        .update(JSON.stringify([source, memoryId]))
        .digest('hex'),
    );
    const foreignMemoryLineageId = createHash('sha256')
      .update(JSON.stringify([sourceTags[2], foreignId]))
      .digest('hex');
    const ownerlessOrphanLineageId = createHash('sha256')
      .update(JSON.stringify(['orphan-source', ownerlessOrphanMemoryId]))
      .digest('hex');
    const occasionLineageIds = sourceTags.slice(0, 2).map((source) =>
      createHash('sha256')
        .update(JSON.stringify([source, occasionId]))
        .digest('hex'),
    );
    const foreignOccasionLineageId = createHash('sha256')
      .update(JSON.stringify([sourceTags[2], foreignOccasionId]))
      .digest('hex');
    const fireEffectId = randomUUID();
    const foreignFireEffectId = randomUUID();
    const watchFireId = randomUUID();
    const foreignWatchFireId = randomUUID();
    const incidentId = randomUUID();
    const incidentSourceId = randomUUID();
    const incidentAttentionId = randomUUID();
    const securityEmailId = randomUUID();
    const foreignIncidentId = randomUUID();
    const reportId = `privacy-report-${randomUUID()}`;
    const foreignReportId = `foreign-report-${randomUUID()}`;
    const outboxIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const recallSurfaceId = randomUUID();
    const foreignRecallSurfaceId = randomUUID();
    const sourceKey = randomUUID().replaceAll('-', '').repeat(2);
    const sourceRevision = randomUUID().replaceAll('-', '').repeat(2);
    const now = new Date('2026-09-22T12:00:00Z');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('missionReports', reportId).set({
        id: reportId,
        agentId,
        text: 'Private mission report',
        chatStatus: 'delivered',
        ownerStatus: 'unknown',
        mirrorStatus: 'failed',
      }),
      store.doc('missionReports', foreignReportId).set({
        id: foreignReportId,
        agentId: foreignId,
        text: 'Foreign report',
        ownerStatus: 'pending',
      }),
      ...(['pending', 'failed', 'sending', 'delivered'] as const).map((status, index) =>
        store.doc('notificationOutbox', outboxIds[index] ?? '').set({
          id: outboxIds[index],
          agentId,
          deliveryKey: `privacy-outbox-${index}`,
          legKey: 'dashboard',
          adapter: 'dashboard',
          status,
          destination: { conversationId: 'private-conversation' },
          payload: { text: 'Private notice text' },
          retryable: status === 'failed',
          leaseToken: status === 'sending' ? randomUUID() : null,
          leaseUntil: status === 'sending' ? new Date(Date.now() + 60_000) : null,
          providerMessageId: status === 'delivered' ? 'provider-receipt-1' : null,
          result: { detail: 'private provider body' },
          createdAt: now,
          updatedAt: now,
          availableAt: now,
          attempts: 1,
          finishedAt: status === 'delivered' ? now : null,
        }),
      ),
      store.doc('recallSurfaces', recallSurfaceId).set({
        id: recallSurfaceId,
        agentId,
        sourceKey,
        sourceRevision,
        kind: 'chat',
        firstSurfacedAt: now,
        lastSurfacedAt: now,
        lastMessageId: randomUUID(),
        surfaceCount: 1,
        suppressedAt: now,
        version: 2,
      }),
      store.doc('recallSurfaces', foreignRecallSurfaceId).set({
        id: foreignRecallSurfaceId,
        agentId: foreignId,
        sourceKey: randomUUID().replaceAll('-', '').repeat(2),
        sourceRevision: null,
        kind: 'chat',
        firstSurfacedAt: now,
        lastSurfacedAt: now,
        lastMessageId: null,
        surfaceCount: 1,
        suppressedAt: null,
        version: 1,
      }),
      store.doc('memories', memoryId).set({ id: memoryId, agentId, contentHash: hash }),
      store.doc('memoryImportLineage', memoryLineageIds[0] ?? '').set({
        agentId,
        source: sourceTags[0],
        memoryId,
        sourceUnitProvenance: [
          { authorEmail: 'private@example.test', quote: 'private archive text' },
        ],
      }),
      // Legacy portable lineage rows lacked a direct owner column; the owner
      // can still be proved while the linked memory record is present.
      store.doc('memoryImportLineage', memoryLineageIds[1] ?? '').set({
        source: sourceTags[1],
        memoryId,
        sourceUnitProvenance: [{ authorEmail: 'legacy-private@example.test' }],
      }),
      store.doc('memoryImportLineage', foreignMemoryLineageId).set({
        agentId: foreignId,
        source: sourceTags[2],
        memoryId: foreignId,
        sourceUnitProvenance: [{ authorEmail: 'foreign@example.test' }],
      }),
      store.doc('memoryImportLineage', ownerlessOrphanLineageId).set({
        source: 'orphan-source',
        memoryId: ownerlessOrphanMemoryId,
        sourceUnitProvenance: [{ authorEmail: 'unattributable@example.test' }],
      }),
      store.doc('occasions', occasionId).set({
        id: occasionId,
        agentId,
        contactId: randomUUID(),
        kind: 'custom',
        label: 'Private source occasion',
        month: 3,
        day: 4,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: 'private merged source detail',
        originTrust: 'assistant',
        quarantined: false,
        ownerConfirmed: false,
        source: 'consolidation',
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('occasions', foreignOccasionId).set({
        id: foreignOccasionId,
        agentId: foreignId,
        contactId: randomUUID(),
        kind: 'custom',
        label: 'Foreign occasion',
        month: 5,
        day: 6,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: 'foreign source detail',
        originTrust: 'assistant',
        quarantined: false,
        ownerConfirmed: false,
        source: 'consolidation',
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('occasionImportLineage', occasionLineageIds[0] ?? '').set({
        agentId,
        source: sourceTags[0],
        occasionId,
        createdAt: now,
      }),
      store.doc('occasionImportLineage', occasionLineageIds[1] ?? '').set({
        source: sourceTags[1],
        occasionId,
        createdAt: now,
      }),
      store.doc('occasionImportLineage', foreignOccasionLineageId).set({
        agentId: foreignId,
        source: sourceTags[2],
        occasionId: foreignOccasionId,
        createdAt: now,
      }),
      store.doc('memoryContentHashes', hash).set({ memoryId }),
      store.doc('knowledgeGraphSources', memoryId).set({ memoryId, contentHash: hash }),
      store.doc('knowledgeGraphRelations', relationId).set({ id: relationId, agentId }),
      store.doc('knowledgeGraphAssertions', assertionId).set({
        id: assertionId,
        agentId,
        semanticKey: `privacy:${assertionId}`,
      }),
      store.doc('knowledgeGraphAssertionEvidence', assertionEvidenceId).set({
        id: assertionEvidenceId,
        agentId,
        assertionId,
        sourceMemoryId: memoryId,
      }),
      store.doc('knowledgeGraphEntities', entityId).set({ id: entityId, agentId }),
      store.doc('knowledgeGraphEntityAliases', aliasId).set({ id: aliasId, agentId }),
      store.doc('situationPacks', packId).set({
        id: packId,
        agentId,
        data: { title: 'Plan', decisions: [{ reason: 'private' }] },
        version: 3,
      }),
      store.doc('situationPreviews', previewId).set({ id: previewId, packId }),
      store.doc('importSources', importId).set({
        id: importId,
        agentId,
        source: 'voice-samples-mail',
        workspacePath: 'import/voice.txt',
        taskId,
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'running' }),
      store.doc('preparedMemoryExtractions', preparedId).set({
        id: preparedId,
        agentId,
        conversationId: randomUUID(),
        sourceHash: 'private',
        extractionVersion: 'memory-extraction-v3',
        payload: { facts: [{ content: 'private' }] },
      }),
      store.doc('writingSamples', sampleId).set({ id: sampleId, agentId, text: 'private' }),
      store.doc('watchFireEffects', fireEffectId).set({
        id: fireEffectId,
        agentId,
        kind: 'owner_notification',
        status: 'pending',
        payload: { text: 'private notice' },
      }),
      store.doc('watchFireEffects', foreignFireEffectId).set({
        id: foreignFireEffectId,
        agentId: foreignId,
        kind: 'owner_notification',
        status: 'pending',
        payload: { text: 'foreign notice' },
      }),
      store.doc('watchFires', watchFireId).set({
        id: watchFireId,
        agentId,
        watchId: randomUUID(),
        triggerRef: 'private-trigger',
        summary: 'private notice',
        excerpt: 'private watched content',
      }),
      store.doc('watchFires', foreignWatchFireId).set({
        id: foreignWatchFireId,
        agentId: foreignId,
        watchId: randomUUID(),
        triggerRef: 'foreign-trigger',
        summary: 'foreign notice',
        excerpt: 'foreign content',
      }),
      store.doc('voiceProfile', '1').set({ id: 1, description: 'private', signature: 'private' }),
      store.doc('securityIncidents', incidentId).set({
        id: incidentId,
        agentId,
        incidentKey: 'private-key',
        confidence: 'provider-reference',
        revision: 1,
        disposition: 'unreviewed',
        decisionRevision: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('securityIncidentSources', incidentSourceId).set({
        id: incidentSourceId,
        agentId,
        incidentId,
        channelMessageId: 'gmail:private',
        sourceMessageId: '<private@test>',
        mailboxHash: 'private-hash',
        evidenceFingerprint: 'private-evidence',
        observedAt: now,
      }),
      store.doc('securityIncidentAttention', incidentAttentionId).set({
        id: incidentAttentionId,
        agentId,
        incidentId,
        revision: 1,
        producer: 'arrival',
        deliveryStatus: 'accepted',
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('emailIngest', securityEmailId).set({
        id: securityEmailId,
        agentId,
        channelMessageId: 'gmail:private',
        category: 'security',
        securityIncidentId: incidentId,
        securityEvidence: { providerIncidentRef: 'private-ref', evidenceQuote: 'Private quote' },
        directRouting: 'needs_attention',
        directRecoveryReason: 'provider_message_missing',
        emailContentProvenance: {
          version: 1,
          mode: 'direct',
          authenticated: true,
          sourceLength: 0,
          storedLength: 0,
          sourceHash: 'a'.repeat(64),
          bodyHash: 'b'.repeat(64),
          messageHash: 'c'.repeat(64),
          prefixLength: 0,
          hasExternalOrUnknown: false,
          spans: [],
          parts: [],
        },
      }),
      store.doc('securityIncidents', foreignIncidentId).set({
        id: foreignIncidentId,
        agentId: foreignId,
        incidentKey: 'foreign-key',
        confidence: 'provider-reference',
        revision: 1,
        disposition: 'unreviewed',
        decisionRevision: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('ownerCards', agentId).set({ agentId, content: 'private', compiledAt: now }),
      store.doc('knowledgeGraphRelations', foreignId).set({ id: foreignId, agentId: foreignId }),
      store
        .doc('memories', foreignId)
        .set({ id: foreignId, agentId: foreignId, contentHash: 'foreign' }),
    ]);
    const repository = new FirestorePrivacyErasureRepository(store);
    // Ownership/identity validation must finish before any erase side effect.
    await store.doc('writingSamples', sampleId).update({ id: 'forged' });
    await expect(repository.erase()).rejects.toThrow(
      'Writing sample ownership or identity mismatch',
    );
    expect((await store.doc('privacyErasureJobs', agentId).get()).exists).toBe(false);
    expect((await store.doc('memoryTombstones', hash).get()).exists).toBe(false);
    expect((await store.doc('memories', memoryId).get()).exists).toBe(true);
    await store.doc('writingSamples', sampleId).update({ id: sampleId });
    await expect(repository.erase()).resolves.toEqual({
      memories: 1,
      graphRelations: 1,
      writingSamples: 1,
      securityIncidents: 1,
    });
    expect((await store.doc('securityIncidents', incidentId).get()).exists).toBe(false);
    expect((await store.doc('securityIncidentSources', incidentSourceId).get()).exists).toBe(false);
    expect((await store.doc('securityIncidentAttention', incidentAttentionId).get()).exists).toBe(
      false,
    );
    expect((await store.doc('securityIncidents', foreignIncidentId).get()).exists).toBe(true);
    expect((await store.doc('emailIngest', securityEmailId).get()).data()).toMatchObject({
      agentId,
      securityIncidentId: null,
      securityEvidence: null,
      directRouting: null,
      directRecoveryReason: null,
      emailContentProvenance: null,
    });
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe(
      'content-erased',
    );
    expect((await store.doc('recallSurfaces', recallSurfaceId).get()).exists).toBe(false);
    expect((await store.doc('recallSurfaces', foreignRecallSurfaceId).get()).exists).toBe(true);
    expect((await store.doc('knowledgeGraphEntities', entityId).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphAssertions', assertionId).get()).exists).toBe(false);
    expect(
      (await store.doc('knowledgeGraphAssertionEvidence', assertionEvidenceId).get()).exists,
    ).toBe(false);
    expect((await store.doc('knowledgeGraphEntityAliases', aliasId).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(false);
    expect((await store.doc('memoryImportLineage', memoryLineageIds[0] ?? '').get()).exists).toBe(
      false,
    );
    expect((await store.doc('memoryImportLineage', memoryLineageIds[1] ?? '').get()).exists).toBe(
      false,
    );
    expect((await store.doc('memoryImportLineage', foreignMemoryLineageId).get()).exists).toBe(
      true,
    );
    // Ownerless orphan rows cannot be attributed safely after their target is gone.
    expect((await store.doc('memoryImportLineage', ownerlessOrphanLineageId).get()).exists).toBe(
      true,
    );
    expect((await store.doc('occasions', occasionId).get()).exists).toBe(false);
    expect((await store.doc('occasions', foreignOccasionId).get()).exists).toBe(true);
    expect(
      (await store.doc('occasionImportLineage', occasionLineageIds[0] ?? '').get()).exists,
    ).toBe(false);
    expect(
      (await store.doc('occasionImportLineage', occasionLineageIds[1] ?? '').get()).exists,
    ).toBe(false);
    expect((await store.doc('occasionImportLineage', foreignOccasionLineageId).get()).exists).toBe(
      true,
    );
    expect((await store.doc('memoryContentHashes', hash).get()).exists).toBe(false);
    expect((await store.doc('situationPreviews', previewId).get()).exists).toBe(false);
    expect((await store.doc('missionReports', reportId).get()).data()).toMatchObject({
      text: '',
      chatStatus: 'delivered',
      ownerStatus: 'unknown',
      mirrorStatus: 'skipped',
    });
    expect((await store.doc('missionReports', foreignReportId).get()).get('text')).toBe(
      'Foreign report',
    );
    const erasedOutbox = await Promise.all(
      outboxIds.map((id) => store.doc('notificationOutbox', id ?? '').get()),
    );
    for (const row of erasedOutbox) {
      expect(row.get('destination')).toBeNull();
      expect(row.get('payload')).toBeNull();
      expect(row.get('result')).toBeNull();
      expect(row.get('retryable')).toBe(false);
      expect(row.get('leaseToken')).toBeNull();
      expect(row.get('leaseUntil')).toBeNull();
    }
    expect(erasedOutbox.map((row) => row.get('status'))).toEqual([
      'skipped',
      'skipped',
      'unknown',
      'delivered',
    ]);
    expect(erasedOutbox[3]?.get('providerMessageId')).toBe('provider-receipt-1');
    expect((await store.doc('situationPacks', packId).get()).data()).toMatchObject({
      data: { title: 'Plan', decisions: [] },
      version: 4,
    });
    expect((await store.doc('tasks', taskId).get()).get('status')).toBe('cancelled');
    expect((await store.doc('preparedMemoryExtractions', preparedId).get()).exists).toBe(false);
    expect((await store.doc('ownerCards', agentId).get()).get('content')).toBe('');
    expect((await store.doc('voiceProfile', '1').get()).get('description')).toBe('');
    expect((await store.doc('memories', foreignId).get()).exists).toBe(true);
    expect((await store.doc('watchFireEffects', fireEffectId).get()).exists).toBe(false);
    expect((await store.doc('watchFireEffects', foreignFireEffectId).get()).exists).toBe(true);
    expect((await store.doc('watchFires', watchFireId).get()).exists).toBe(false);
    expect((await store.doc('watchFires', foreignWatchFireId).get()).exists).toBe(true);
    expect((await store.doc('knowledgeGraphRelations', foreignId).get()).exists).toBe(true);
    const remainingAssets = await repository.pendingAssets();
    expect(remainingAssets.map((asset) => asset.workspacePath)).toEqual(['import/voice.txt']);
    await expect(repository.complete()).rejects.toThrow('assets remain');
    const voiceAsset = remainingAssets[0];
    if (!voiceAsset) throw new Error('Expected voice source cleanup asset');
    await repository.assetDeleted(voiceAsset.id);
    await repository.complete();
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('complete');
  });

  it('removes observer dashboard messages through the owner erasure lifecycle and keeps an invoked provider leg unknown', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const workId = randomUUID();
    const dashboardDeliveryKey = `observer:${randomUUID()}`;
    const orphanDeliveryKey = `observer-orphan:${randomUUID()}`;
    const stableChannelMessageId = notificationDashboardMessageId(
      agentId,
      dashboardDeliveryKey,
      'dashboard',
    );
    const orphanChannelMessageId = notificationDashboardMessageId(
      agentId,
      orphanDeliveryKey,
      'dashboard',
    );
    const messageId = randomUUID();
    const externalLegId = randomUUID();
    const dashboardLegId = randomUUID();
    const orphanDashboardLegId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignConversationId = randomUUID();
    const foreignWorkId = randomUUID();
    const foreignMessageId = randomUUID();
    const foreignChannelMessageId = notificationDashboardMessageId(
      foreignAgentId,
      `observer:${randomUUID()}`,
      'dashboard',
    );
    const foreignLegId = randomUUID();
    const now = new Date('2026-10-09T12:00:00Z');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId: foreignAgentId,
        channel: 'web',
        title: 'Notice erasure fixture',
      }),
      store.doc('conversations', foreignConversationId).set({
        id: foreignConversationId,
        agentId: foreignAgentId,
        channel: 'web',
        title: 'Unrelated owner notice fixture',
      }),
      store.doc('emailObserverWork', workId).set({
        id: workId,
        agentId,
        sourceKey: `gmail:${randomUUID()}`,
        channelMessageId: `gmail:${randomUUID()}`,
        sourceKind: 'message',
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'idempotent_db',
        status: 'prepared',
        attemptCount: 1,
        claimToken: 'claim-before-erasure',
        claimGeneration: 1,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: { text: 'private prepared notice' },
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('emailObserverWork', foreignWorkId).set({
        id: foreignWorkId,
        agentId: foreignAgentId,
        sourceKey: `gmail:${randomUUID()}`,
        channelMessageId: `gmail:${randomUUID()}`,
        sourceKind: 'message',
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'idempotent_db',
        status: 'complete',
        attemptCount: 1,
        claimToken: null,
        claimGeneration: 1,
        leaseExpiresAt: null,
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: null,
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('messages', messageId).set({
        id: messageId,
        conversationId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Private observer notice' }],
        text: 'Private observer notice',
        origin: 'assistant',
        channelMessageId: stableChannelMessageId,
        createdAt: now,
        hiddenAt: null,
        appendSequence: '00000000000000000001',
      }),
      store.doc('messageChannelIds', stableChannelMessageId).set({
        messageId,
        conversationId,
      }),
      store.doc('messageChannelIds', orphanChannelMessageId).set({
        messageId: randomUUID(),
        conversationId,
      }),
      store.doc('messages', foreignMessageId).set({
        id: foreignMessageId,
        conversationId: foreignConversationId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Unrelated owner notice content' }],
        text: 'Unrelated owner notice content',
        origin: 'assistant',
        channelMessageId: foreignChannelMessageId,
        createdAt: now,
        hiddenAt: null,
        appendSequence: '00000000000000000001',
      }),
      store.doc('messageChannelIds', foreignChannelMessageId).set({
        messageId: foreignMessageId,
        conversationId: foreignConversationId,
      }),
      store.doc('notificationOutbox', dashboardLegId).set({
        id: dashboardLegId,
        agentId,
        deliveryKey: dashboardDeliveryKey,
        legKey: 'dashboard',
        adapter: 'dashboard',
        status: 'delivered',
        destination: { conversationId },
        payload: { text: 'Private observer notice' },
        retryable: false,
        providerMessageId: null,
        producerWorkId: workId,
        producerPrivacyGeneration: null,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        attempts: 1,
        finishedAt: now,
      }),
      store.doc('notificationOutbox', orphanDashboardLegId).set({
        id: orphanDashboardLegId,
        agentId,
        deliveryKey: orphanDeliveryKey,
        legKey: 'dashboard',
        adapter: 'dashboard',
        status: 'delivered',
        destination: { conversationId },
        payload: { text: 'Already removed dashboard message' },
        retryable: false,
        providerMessageId: null,
        producerWorkId: workId,
        producerPrivacyGeneration: null,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        attempts: 1,
        finishedAt: now,
      }),
      store.doc('notificationOutbox', foreignLegId).set({
        id: foreignLegId,
        agentId: foreignAgentId,
        deliveryKey: `observer:${randomUUID()}`,
        legKey: 'dashboard',
        adapter: 'dashboard',
        status: 'delivered',
        destination: { conversationId: foreignConversationId },
        payload: { text: 'Unrelated owner notice content' },
        retryable: false,
        providerMessageId: null,
        producerWorkId: foreignWorkId,
        producerPrivacyGeneration: null,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        attempts: 1,
        finishedAt: now,
      }),
      store.doc('notificationOutbox', externalLegId).set({
        id: externalLegId,
        agentId,
        deliveryKey: dashboardDeliveryKey,
        legKey: 'email',
        adapter: 'email',
        status: 'sending',
        destination: { address: 'private@example.test' },
        payload: { text: 'Private external notice' },
        retryable: false,
        providerMessageId: 'provider-receipt-while-sending',
        producerWorkId: workId,
        producerPrivacyGeneration: null,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        attempts: 1,
        finishedAt: null,
      }),
    ]);

    const repository = new FirestorePrivacyErasureRepository(store);
    await expect(repository.erase()).rejects.toThrow(
      'Email observer dashboard notice points outside its owner conversation',
    );
    expect((await store.doc('emailObserverWork', workId).get()).get('status')).toBe('unknown');
    expect((await store.doc('messages', messageId).get()).exists).toBe(true);

    // A restart after work was scrubbed must retry notice cleanup from the
    // durable work row, rather than treating the unknown row as finished.
    await store.doc('conversations', conversationId).update({ agentId });
    await repository.erase();

    expect((await store.doc('messages', messageId).get()).exists).toBe(false);
    expect((await store.doc('messageChannelIds', stableChannelMessageId).get()).exists).toBe(false);
    expect((await store.doc('messageChannelIds', orphanChannelMessageId).get()).exists).toBe(false);
    expect((await store.doc('messages', foreignMessageId).get()).exists).toBe(true);
    expect((await store.doc('messageChannelIds', foreignChannelMessageId).get()).exists).toBe(true);
    expect((await store.doc('notificationOutbox', foreignLegId).get()).get('payload')).toEqual({
      text: 'Unrelated owner notice content',
    });
    const dashboard = await store.doc('notificationOutbox', dashboardLegId).get();
    expect(dashboard.data()).toMatchObject({
      status: 'delivered',
      payload: null,
      destination: null,
    });
    const external = await store.doc('notificationOutbox', externalLegId).get();
    expect(external.data()).toMatchObject({
      status: 'unknown',
      retryable: false,
      payload: null,
      destination: null,
      providerMessageId: 'provider-receipt-while-sending',
    });
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe(
      'content-erased',
    );
  });

  it('erases ordinary import claims and queues every snapshot/source path before completion', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const foreignId = randomUUID();
    const source = 'mail-import';
    const sourceId = randomUUID();
    const taskId = randomUUID();
    const sourceKey = createHash('sha256').update(`${agentId}\0${source}`).digest('hex');
    const foreignSourceKey = createHash('sha256').update(`${foreignId}\0${source}`).digest('hex');
    const deletionId = createHash('sha256')
      .update(`import-delete\0${agentId}\0${source}`)
      .digest('hex');
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const now = new Date('2026-10-07T12:00:00Z');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('importSources', sourceId).set({
        id: sourceId,
        agentId,
        source,
        status: 'pending',
        workspacePath: 'import/mail.mbox',
        taskId,
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'running' }),
      store.doc('importSourceKeys', sourceKey).set({ agentId, source, sourceId }),
      store.doc('importSourceDeletionJobs', deletionId).set({
        id: deletionId,
        agentId,
        sourceHash,
        sourceId,
        status: 'pending_assets',
      }),
      store.doc('importSources', foreignId).set({
        id: foreignId,
        agentId: foreignId,
        source,
        status: 'pending',
        workspacePath: 'import/foreign.mbox',
      }),
      store.doc('importSourceKeys', foreignSourceKey).set({
        agentId: foreignId,
        source,
        sourceId: foreignId,
      }),
      store.doc('toolCallReceipts', 'owner-receipt').set({ id: 'owner-receipt', agentId }),
      store.doc('toolCallReceiptKeys', 'owner-key').set({ id: 'owner-key', agentId }),
      store
        .doc('toolCallReceipts', 'foreign-receipt')
        .set({ id: 'foreign-receipt', agentId: foreignId }),
      store
        .doc('toolCallReceiptKeys', 'foreign-key')
        .set({ id: 'foreign-key', agentId: foreignId }),
    ]);

    for (let index = 0; index < 55; index += 1) {
      const suffix =
        index === 0 ? 'manifest.json' : `windows-${String(index).padStart(6, '0')}.json`;
      const path = `.assistant/imports/${source}/${taskId}/${suffix}`;
      const id = createHash('sha256')
        .update(`import-snapshot\0${agentId}\0${sourceId}\0${path}`)
        .digest('hex');
      await store.doc('importSnapshotAssets', id).set({
        id,
        agentId,
        sourceId,
        source,
        taskId,
        workspacePath: path,
        createdAt: now,
      });
    }
    const foreignSnapshotId = createHash('sha256').update(`foreign-${randomUUID()}`).digest('hex');
    await store.doc('importSnapshotAssets', foreignSnapshotId).set({
      id: foreignSnapshotId,
      agentId: foreignId,
      sourceId: foreignId,
      source,
      taskId: randomUUID(),
      workspacePath: `.assistant/imports/${source}/foreign/manifest.json`,
      createdAt: now,
    });

    const repository = new FirestorePrivacyErasureRepository(store);
    await repository.erase();

    expect((await store.doc('importSources', sourceId).get()).exists).toBe(false);
    expect((await store.doc('tasks', taskId).get()).get('status')).toBe('cancelled');
    expect((await store.doc('importSourceKeys', sourceKey).get()).exists).toBe(false);
    expect((await store.doc('importSourceDeletionJobs', deletionId).get()).exists).toBe(false);
    expect((await store.doc('importSources', foreignId).get()).exists).toBe(true);
    expect((await store.doc('importSourceKeys', foreignSourceKey).get()).exists).toBe(true);
    expect((await store.doc('importSnapshotAssets', foreignSnapshotId).get()).exists).toBe(true);
    expect((await store.doc('toolCallReceipts', 'owner-receipt').get()).exists).toBe(false);
    expect((await store.doc('toolCallReceiptKeys', 'owner-key').get()).exists).toBe(false);
    expect((await store.doc('toolCallReceipts', 'foreign-receipt').get()).exists).toBe(true);
    expect((await store.doc('toolCallReceiptKeys', 'foreign-key').get()).exists).toBe(true);
    expect(
      (await store.collection('importSnapshotAssets').where('agentId', '==', agentId).get()).size,
    ).toBe(0);

    const assets = await store
      .collection('privacyErasureAssets')
      .where('agentId', '==', agentId)
      .get();
    expect(assets.size).toBe(56);
    expect(assets.docs.map((asset) => asset.get('workspacePath'))).toContain('import/mail.mbox');
    expect(assets.docs.filter((asset) => asset.get('assetKind') === 'snapshot')).toHaveLength(55);
    expect(
      assets.docs.every(
        (asset) =>
          asset.get('assetKind') === 'source' ||
          String(asset.get('workspacePath')).startsWith(`.assistant/imports/${source}/${taskId}/`),
      ),
    ).toBe(true);
    await expect(repository.complete()).rejects.toThrow('assets remain');
    for (const asset of assets.docs) {
      const id = asset.get('sourceId');
      if (typeof id !== 'string') throw new Error('Expected cleanup source identity');
      await repository.assetDeleted(id);
    }
    await repository.complete();
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('complete');
  });

  it('refuses installation-wide erasure when owner identity is ambiguous', async () => {
    const store = emulatorStore();
    stores.push(store);
    const first = randomUUID();
    const second = randomUUID();
    await Promise.all([
      store.doc('agents', first).set({ id: first }),
      store.doc('agents', second).set({ id: second }),
    ]);
    await expect(new FirestorePrivacyErasureRepository(store).erase()).rejects.toThrow(
      'exactly one configured owner',
    );
    expect((await store.collection('privacyErasureJobs').get()).empty).toBe(true);
  });

  it('keeps a malformed owner import source fenced instead of dropping an untrusted path', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const sourceId = randomUUID();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('importSources', sourceId).set({
        id: sourceId,
        agentId,
        source: 'mail-import',
        status: 'pending',
        workspacePath: '../outside/private.mbox',
      }),
    ]);
    const repository = new FirestorePrivacyErasureRepository(store);
    await expect(repository.erase()).rejects.toThrow(
      'Import ownership, identity, or path mismatch',
    );
    expect((await store.doc('importSources', sourceId).get()).exists).toBe(true);
    expect(
      (await store.collection('privacyErasureAssets').where('agentId', '==', agentId).get()).size,
    ).toBe(0);
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('active');
  });

  it('refuses to start erasure when a writing sample belongs to another owner', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const ownerSampleId = randomUUID();
    const foreignSampleId = randomUUID();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('writingSamples', ownerSampleId).set({
        id: ownerSampleId,
        agentId,
        context: 'upload:owner',
      }),
      store.doc('writingSamples', foreignSampleId).set({
        id: foreignSampleId,
        agentId: randomUUID(),
        context: 'upload:foreign',
      }),
    ]);

    await expect(new FirestorePrivacyErasureRepository(store).erase()).rejects.toThrow(
      'Writing sample ownership or identity mismatch',
    );
    expect((await store.doc('privacyErasureJobs', agentId).get()).exists).toBe(false);
    expect((await store.doc('writingSamples', ownerSampleId).get()).exists).toBe(true);
    expect((await store.doc('writingSamples', foreignSampleId).get()).exists).toBe(true);
  });

  it('fails closed when owner-tagged lineage disagrees with its target owner', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const foreignId = randomUUID();
    const source = 'owned-source';
    const lineageId = createHash('sha256')
      .update(JSON.stringify([source, foreignId]))
      .digest('hex');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('memories', foreignId).set({
        id: foreignId,
        agentId: randomUUID(),
        contentHash: randomUUID(),
      }),
      store.doc('memoryImportLineage', lineageId).set({
        agentId,
        source,
        memoryId: foreignId,
        sourceUnitProvenance: [{ quote: 'private provenance' }],
      }),
    ]);

    const repository = new FirestorePrivacyErasureRepository(store);
    await expect(repository.erase()).rejects.toThrow(
      'memoryImportLineage target identity disagrees with its owner',
    );
    expect((await store.doc('memories', foreignId).get()).exists).toBe(true);
    expect((await store.doc('memoryImportLineage', lineageId).get()).exists).toBe(true);
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('active');
  });

  it('drains more than one transaction page without losing tombstones or counts', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    const rows = Array.from({ length: 53 }, () => ({ id: randomUUID(), hash: randomUUID() }));
    const occasionRows = rows.map(() => ({ id: randomUUID() }));
    const batch = store.db.batch();
    for (const [index, row] of rows.entries()) {
      const source = `bulk-source-${index}`;
      const lineageId = createHash('sha256')
        .update(JSON.stringify([source, row.id]))
        .digest('hex');
      batch.set(store.doc('memories', row.id), { id: row.id, agentId, contentHash: row.hash });
      batch.set(store.doc('memoryContentHashes', row.hash), { memoryId: row.id });
      batch.set(store.doc('memoryImportLineage', lineageId), {
        agentId,
        source,
        memoryId: row.id,
        sourceUnitProvenance: [{ unitIndex: index, quote: `private unit ${index}` }],
      });
      const occasion = occasionRows[index];
      if (!occasion) continue;
      const occasionLineageId = createHash('sha256')
        .update(JSON.stringify([source, occasion.id]))
        .digest('hex');
      batch.set(store.doc('occasions', occasion.id), { id: occasion.id, agentId });
      batch.set(store.doc('occasionImportLineage', occasionLineageId), {
        agentId,
        source,
        occasionId: occasion.id,
        sourceUnitProvenance: [{ unitIndex: index, quote: `private occasion ${index}` }],
      });
    }
    await batch.commit();
    const repository = new FirestorePrivacyErasureRepository(store);
    await expect(repository.erase()).resolves.toEqual({
      memories: 53,
      graphRelations: 0,
      writingSamples: 0,
      securityIncidents: 0,
    });
    expect((await store.collection('memories').where('agentId', '==', agentId).get()).empty).toBe(
      true,
    );
    expect(
      (await store.collection('memoryImportLineage').where('agentId', '==', agentId).get()).empty,
    ).toBe(true);
    expect(
      (await store.collection('occasionImportLineage').where('agentId', '==', agentId).get()).empty,
    ).toBe(true);
    expect((await store.collection('occasions').where('agentId', '==', agentId).get()).empty).toBe(
      true,
    );
    for (const row of rows) {
      expect((await store.doc('memoryTombstones', row.hash).get()).exists).toBe(true);
    }
    await repository.complete();
  });

  it('keeps a malformed durable fence closed', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'unknown' });
    await expect(new FirestorePrivacyErasureRepository(store).erase()).rejects.toThrow(
      'job is malformed',
    );
    await expect(
      new FirestoreMemoryRepository(store, {
        provider: 'test',
        model: 'unit',
        dimensions: 3,
        revision: '1',
      }).save({
        id: randomUUID(),
        agentId,
        contentHash: randomUUID(),
        embedding: [1, 0, 0],
      } as Records['memories']),
    ).rejects.toThrow('Privacy erasure is in progress');
  });
});
