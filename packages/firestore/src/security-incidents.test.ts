import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreEmailSyncRepository } from './email-sync.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore security incidents', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

  it('lists only unclaimed current revisions and shares the attention claim across producers', async () => {
    const store = emulatorStore(() => new Date('2026-10-06T18:00:00.000Z'));
    stores.push(store);
    const agentId = randomUUID();
    const channelMessageId = `gmail:${randomUUID()}`;
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, email: 'owner@example.test' }),
      store.doc('coordination', 'migration').set({ status: 'active' }),
    ]);
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    const quote = 'New sign-in to owner@example.test from Pixel 9 at 2026-10-06T17:55:00Z.';
    await repository.recordIngest({
      agentId,
      channelMessageId,
      conversationId: null,
      fromEmail: 'security@example.test',
      fromName: 'Account Security',
      subject: 'New sign-in',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'security',
      importance: 3,
      actionable: false,
      reason: 'routine security notice',
      dates: [],
      securityEvidence: {
        eventType: 'sign-in',
        affectedAccount: 'owner@example.test',
        eventAt: '2026-10-06T17:55:00Z',
        device: 'Pixel 9',
        evidenceQuote: quote,
      },
    });
    const observed = await repository.observeSecurityIncident({
      agentId,
      channelMessageId,
      sourceMessageId: `<${randomUUID()}@provider.test>`,
      mailbox: 'owner@example.test',
      authenticated: true,
      evidence: {
        eventType: 'sign-in',
        affectedAccount: 'owner@example.test',
        eventAt: '2026-10-06T17:55:00Z',
        device: 'Pixel 9',
        evidenceQuote: quote,
      },
      sourceText: quote,
      observedAt: new Date('2026-10-06T17:55:00.000Z'),
      observationFence: null,
    });

    const candidates = await repository.listSecurityAttentionCandidates(agentId, 10);
    expect(candidates).toEqual([
      expect.objectContaining({
        channelMessageId,
        incidentId: observed.incident.id,
        revision: 1,
        confidence: 'recovery-reference',
        category: 'security',
        subject: 'New sign-in',
        evidence: expect.objectContaining({ evidenceQuote: quote }),
      }),
    ]);
    expect(
      await repository.claimSecurityAttention({
        agentId,
        incidentId: observed.incident.id,
        revision: 1,
        producer: 'arrival',
        now: new Date(),
      }),
    ).toBe(true);
    expect(await repository.listSecurityAttentionCandidates(agentId, 10)).toEqual([]);
    expect(
      await repository.claimSecurityAttention({
        agentId,
        incidentId: observed.incident.id,
        revision: 1,
        producer: 'briefing',
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('rejects a source observation started before a completed erasure generation', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const channelMessageId = `gmail:${randomUUID()}`;
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, email: 'owner@example.test' }),
      store.doc('coordination', 'migration').set({ status: 'active' }),
    ]);
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    await repository.recordIngest({
      agentId,
      channelMessageId,
      conversationId: null,
      fromEmail: 'security@example.test',
      fromName: null,
      subject: 'New sign-in',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'security',
      importance: 3,
      actionable: false,
      reason: '',
      dates: [],
    });
    const staleFence = await repository.privacyObservationFence(agentId);
    await store.doc('privacyErasureJobs', agentId).set({
      agentId,
      generation: randomUUID(),
      status: 'complete',
      counts: { memories: 0, graphRelations: 0, writingSamples: 0, securityIncidents: 0 },
    });
    await expect(
      repository.observeSecurityIncident({
        agentId,
        channelMessageId,
        sourceMessageId: null,
        mailbox: 'owner@example.test',
        authenticated: true,
        evidence: null,
        sourceText: 'New sign-in',
        observedAt: new Date(),
        observationFence: staleFence,
      }),
    ).rejects.toThrow('Privacy erasure changed during source observation');
    expect(
      (await store.collection('securityIncidents').where('agentId', '==', agentId).get()).size,
    ).toBe(0);
  });
});
