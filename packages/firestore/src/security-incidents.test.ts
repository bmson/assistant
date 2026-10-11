import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreEmailSyncRepository } from './email-sync.js';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
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

  it('lists delivered reviews, suppresses dismissed revisions, selects the newest material revision, and clears after erasure', async () => {
    const store = emulatorStore(() => new Date('2026-10-06T18:00:00.000Z'));
    stores.push(store);
    const agentId = randomUUID();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, email: 'owner@example.test' }),
      store.doc('coordination', 'migration').set({ status: 'active' }),
    ]);
    const repository = new FirestoreEmailSyncRepository(store, agentId);
    const providerIncidentRef = 'provider-incident-992';
    const observe = async (
      suffix: string,
      device: string,
      at: string,
      incidentRef = providerIncidentRef,
    ) => {
      const channelMessageId = `gmail:${suffix}`;
      const quote = `New sign-in reference ${incidentRef} for owner@example.test from ${device} at ${at}.`;
      const evidence = {
        providerIncidentRef: incidentRef,
        eventType: 'sign-in',
        affectedAccount: 'owner@example.test',
        eventAt: at,
        device,
        evidenceQuote: quote,
      };
      await repository.recordIngest({
        agentId,
        channelMessageId,
        conversationId: null,
        fromEmail: 'security@example.test',
        fromName: 'Account Security',
        subject: `Sign-in from ${device}`,
        contentTrust: 'unknown',
        authenticated: true,
        category: 'security',
        importance: 3,
        actionable: false,
        reason: 'security notice',
        dates: [],
        securityEvidence: evidence,
      });
      return repository.observeSecurityIncident({
        agentId,
        channelMessageId,
        sourceMessageId: `<${suffix}@provider.test>`,
        mailbox: 'owner@example.test',
        authenticated: true,
        evidence,
        sourceText: quote,
        observedAt: new Date(at),
        observationFence: null,
      });
    };

    const first = await observe('review-original', 'Pixel 9', '2026-10-06T17:55:00.000Z');
    expect(first.incident.revision).toBe(1);
    expect(await repository.listSecurityReviewItems(agentId, 10)).toEqual([
      expect.objectContaining({ incidentId: first.incident.id, revision: 1 }),
    ]);
    expect(
      await repository.claimSecurityAttention({
        agentId,
        incidentId: first.incident.id,
        revision: 1,
        producer: 'arrival',
        now: new Date('2026-10-06T17:56:00Z'),
      }),
    ).toBe(true);
    expect(await repository.listSecurityAttentionCandidates(agentId, 10)).toEqual([]);
    expect(await repository.listSecurityReviewItems(agentId, 10)).toEqual([
      expect.objectContaining({ incidentId: first.incident.id, revision: 1 }),
    ]);
    expect(await repository.listSecurityReviewItems(randomUUID(), 10)).toEqual([]);
    expect(
      await repository.decideSecurityIncident({
        agentId: randomUUID(),
        incidentId: first.incident.id,
        expectedRevision: 1,
        disposition: 'dismissed',
        reason: 'foreign owner',
        now: new Date('2026-10-06T17:56:30Z'),
      }),
    ).toBe(false);
    expect(
      await repository.decideSecurityIncident({
        agentId,
        incidentId: randomUUID(),
        expectedRevision: 1,
        disposition: 'dismissed',
        reason: 'unknown incident',
        now: new Date('2026-10-06T17:56:30Z'),
      }),
    ).toBe(false);
    expect(
      await repository.decideSecurityIncident({
        agentId,
        incidentId: first.incident.id,
        expectedRevision: 2,
        disposition: 'dismissed',
        reason: 'stale revision',
        now: new Date('2026-10-06T17:56:30Z'),
      }),
    ).toBe(false);

    expect(
      await repository.decideSecurityIncident({
        agentId,
        incidentId: first.incident.id,
        expectedRevision: 1,
        disposition: 'dismissed',
        reason: 'owner reviewed',
        now: new Date('2026-10-06T17:57:00Z'),
      }),
    ).toBe(true);
    expect(await repository.listSecurityReviewItems(agentId, 10)).toEqual([]);

    const changed = await observe('review-material-change', 'Pixel 10', '2026-10-06T17:59:00.000Z');
    expect(changed.incident.id).toBe(first.incident.id);
    expect(changed.incident.revision).toBe(2);
    expect(await repository.listSecurityReviewItems(agentId, 10)).toEqual([
      expect.objectContaining({
        incidentId: first.incident.id,
        revision: 2,
        channelMessageId: 'gmail:review-material-change',
        subject: 'Sign-in from Pixel 10',
      }),
    ]);
    expect(
      await repository.decideSecurityIncident({
        agentId,
        incidentId: first.incident.id,
        expectedRevision: 2,
        disposition: 'expected',
        reason: 'owner recognizes this device',
        now: new Date('2026-10-06T18:00:00Z'),
      }),
    ).toBe(true);
    expect(
      await repository.decideSecurityIncident({
        agentId,
        incidentId: first.incident.id,
        expectedRevision: 2,
        disposition: 'dismissed',
        reason: 'owner changed their decision',
        now: new Date('2026-10-06T18:00:01Z'),
      }),
    ).toBe(true);
    expect(
      await repository.securityIncidentForMessage(agentId, 'gmail:review-material-change'),
    ).toMatchObject({
      disposition: 'dismissed',
      decisionRevision: 2,
    });

    await observe(
      'limit-order-older',
      'Pixel 11',
      '2026-10-06T18:01:00.000Z',
      'provider-incident-older',
    );
    const newest = await observe(
      'limit-order-newer',
      'Pixel 12',
      '2026-10-06T18:02:00.000Z',
      'provider-incident-newer',
    );
    expect(await repository.listSecurityReviewItems(agentId, 1)).toEqual([
      expect.objectContaining({ incidentId: newest.incident.id }),
    ]);

    await store.doc('coordination', 'migration').update({ status: 'paused' });
    await expect(repository.listSecurityReviewItems(agentId, 10)).rejects.toThrow(
      'Firestore installation is not operationally ready',
    );
    await store.doc('coordination', 'migration').update({ status: 'active' });

    const erasure = new FirestorePrivacyErasureRepository(store, agentId);
    await erasure.erase();
    await erasure.complete();
    expect(await repository.listSecurityReviewItems(agentId, 10)).toEqual([]);
  });
});
