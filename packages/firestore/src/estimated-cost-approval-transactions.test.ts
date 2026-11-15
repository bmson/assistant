import { createHash } from 'node:crypto';
import { canonicalEstimatedCostJson, estimatedCostCardMessageId } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreCostRepository } from './costs.js';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import {
  approveFirestoreEstimatedCost,
  beginFirestoreEstimatedCostGrantAttempt,
  storePreparedFirestoreQuote,
} from './estimated-cost-approval-transactions.js';
import { firestoreEstimatedCostSourceBinding } from './estimated-cost-binding.js';
import {
  createFirestoreEstimatedCostQuotePreparer,
  createFirestoreEstimatedCostTurnParking,
} from './estimated-cost-preparer.js';
import { InstallationStore } from './store.js';
import { disposeStore, emulatorStore, seedBudget } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore estimated cost parking', () => {
  let store: InstallationStore;
  const now = new Date('2026-11-15T12:00:00Z');
  beforeEach(async () => {
    store = emulatorStore(() => now);
    await seedBudget(store);
    await Promise.all([
      store.doc('tasks', 'a').set({
        id: 'a',
        agentId: 'owner',
        conversationId: 'conversation',
        type: 'chat_turn',
        trust: 'owner',
        status: 'running',
        leaseToken: 'lease',
        lockedUntil: new Date(now.getTime() + 600_000),
        spentUsd: '0',
        budgetUsdLimit: '0.5',
        queueGeneration: 0,
        state: { original: 'checkpoint' },
        trigger: {
          payload: {
            text: 'A',
            chatAdmission: {
              protocol: 'owner-chat-v1',
              clientOperationId: 'operation-a',
              requestHash: 'fingerprint',
            },
          },
        },
      }),
      store.doc('taskBudgetHolds', 'a').set({ heldMicros: 0 }),
      store
        .doc('conversations', 'conversation')
        .set({ id: 'conversation', agentId: 'owner', channel: 'chat', modelOverride: null }),
      store
        .doc('modelRoles', 'draft')
        .set({ role: 'draft', primaryModel: 'primary', fallbackModel: 'fallback', params: {} }),
      store
        .doc('modelRoles', 'classify')
        .set({ role: 'classify', primaryModel: 'primary', fallbackModel: 'fallback', params: {} }),
      store
        .doc('modelRoles', 'plan')
        .set({ role: 'plan', primaryModel: 'primary', fallbackModel: 'fallback', params: {} }),
      store
        .doc('models', 'primary')
        .set({ id: 'primary', enabled: true, promptCostPerMTok: '1.0000' }),
      store
        .doc('models', 'fallback')
        .set({ id: 'fallback', enabled: true, promptCostPerMTok: '0.5000' }),
      store
        .doc('modelConnections', 'openrouter')
        .set({ id: 'openrouter', kind: 'openrouter', apiKeyEncrypted: 'synthetic', enabled: true }),
    ]);
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  it.each([
    { critical: false, environment: false },
    { critical: true, environment: false },
    { critical: false, environment: true },
  ])(
    'parks A and resumes configured roles with %j',
    async ({ critical, environment }) => {
      const manifest = {
        provider: 'openrouter' as const,
        endpoint: 'https://openrouter.ai/api/v1' as const,
        installationId: store.installationId,
        projectId: 'demo-assistant-test',
        secretVersion: 'projects/demo-assistant-test/secrets/openrouter-api-key/versions/7',
        sourceRelease: 'a'.repeat(40),
      };
      if (environment) {
        await store.doc('modelConnections', 'openrouter').delete();
        store = new InstallationStore(
          store.db,
          store.installationId,
          store.now,
          manifest.projectId,
          '(default)',
          manifest,
        );
      }
      const allowance = critical ? 550_000 : 500_000;
      const projected = 800_000 + allowance;
      const planned = projected + 10_000;
      const costs = new FirestoreCostRepository(store);
      const old = await costs.reserve({ source: 'model', estimatedUsd: 0.8 });
      if (!old.ok) throw new Error('Expected historical hold');
      await store.doc('costReservations', old.reservationId).update({ status: 'unknown' });
      const baseline = [{ reservationId: old.reservationId, estimatedMicros: 800_000 }];
      const actor = { installationId: store.installationId, ownerId: 'owner' };
      await store.doc('estimatedCostBaselines', store.installationId).set({
        installationId: store.installationId,
        ownerId: 'owner',
        rows: baseline,
        createdAt: now,
        digest: createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
      });
      const sourceInput = {
        actor,
        taskId: 'a',
        role: 'classify',
        selectedModelId: 'fallback',
        routingDigest: 'a'.repeat(64),
        critical,
        additionalRoles: ['draft', 'plan'],
      };
      const sourceBinding = await store.db.runTransaction(
        (tx) => firestoreEstimatedCostSourceBinding(tx, store, sourceInput),
        { readOnly: true },
      );
      const bindingDigest = createHash('sha256')
        .update(canonicalEstimatedCostJson(sourceBinding))
        .digest('hex');
      const quote = {
        type: 'estimated-cost-approval' as const,
        operationId: 'operation-a',
        taskId: 'a',
        requestText: 'A',
        quoteId: 'quote-a',
        quoteVersion: 'v1',
        expiresAt: new Date(now.getTime() + 300_000).toISOString(),
        nextAttemptMicros: critical ? 300_001 : 300_000,
        allowanceMicros: allowance,
        recordedDailyMicros: 0,
        recordedMonthlyMicros: 0,
        totalHeldMicros: 800_000,
        eligibleHistoricalUnknownMicros: 800_000,
        pendingApprovalMicros: allowance,
        dailyCeilingMicros: critical ? 1_100_000 : 1_000_000,
        monthlyCeilingMicros: critical ? 11_000_000 : 10_000_000,
        dailyProjectedGrossMicros: projected,
        monthlyProjectedGrossMicros: projected,
        complete: true,
        canApprove: true,
      };
      const prepared = {
        actor,
        quoteRequestId: 'prepare-a',
        taskId: 'a',
        leaseToken: 'lease',
        requestFingerprint: 'fingerprint',
        bindingDigest,
        sourceBinding,
        critical,
        quote,
        baseline,
      };
      const cardRef = store.doc(
        'messages',
        estimatedCostCardMessageId('operation-a', 'quote-a', 'v1'),
      );
      await cardRef.set({ occupied: true });
      expect(await storePreparedFirestoreQuote(store, prepared)).toMatchObject({
        ok: false,
        outcome: 'unavailable',
      });
      expect((await store.doc('tasks', 'a').get()).get('status')).toBe('running');
      expect((await store.doc('estimatedCostRequests', 'operation-a').get()).exists).toBe(false);
      expect((await costs.totals()).heldUsd).toBe(0.8);
      await cardRef.delete();
      const chat = new FirestoreApplicationChatPersistence(store);
      const before = await chat.appendOwned('owner', {
        conversationId: 'conversation',
        role: 'user',
        origin: 'owner',
        text: 'Newer B',
        parts: [{ type: 'text', text: 'Newer B' }],
      });
      if (!before?.appendSequence) throw new Error('Missing prior message cursor');
      const parked = await storePreparedFirestoreQuote(store, prepared);
      expect(parked).toMatchObject({
        ok: true,
        request: { status: 'pending', operationId: 'operation-a' },
      });
      expect((await store.doc('tasks', 'a').get()).data()).toMatchObject({
        status: 'waiting_estimated_cost',
        state: { original: 'checkpoint' },
      });
      const firstCard = await store
        .doc('messages', estimatedCostCardMessageId('operation-a', 'quote-a', 'v1'))
        .get();
      expect(firstCard.data()).toMatchObject({
        taskId: 'a',
        conversationId: 'conversation',
        role: 'assistant',
        parts: [quote],
      });
      expect(firstCard.get('appendedAt')).toBeDefined();
      const after = await chat.listMessages('owner', 'conversation', {
        after: {
          id: before.id,
          createdAt: before.createdAt,
          appendSequence: before.appendSequence,
        },
      });
      expect(after?.messages.map((message) => message.id)).toEqual([
        estimatedCostCardMessageId('operation-a', 'quote-a', 'v1'),
      ]);
      expect(after?.messages[0]?.appendSequence).not.toBe('00000000000000000000');
      expect((await costs.totals()).heldUsd).toBe(0.8);
      expect(await storePreparedFirestoreQuote(store, prepared)).toEqual(parked);
      const b = await costs.reserve({ source: 'model', estimatedUsd: 0.1 });
      if (!b.ok) throw new Error('B must remain eligible');
      await costs.reconcile(b.reservationId, { usd: 0.01 });
      expect((await costs.readEstimatedCostView(actor, 'operation-a'))?.tracking).toMatchObject({
        recordedDailyMicros: 10_000,
        totalHeldMicros: 800_000,
        pendingApprovalMicros: allowance,
        dailyPlannedExposureMicros: planned,
      });
      expect(
        await approveFirestoreEstimatedCost(store, actor, {
          operationId: 'operation-a',
          quoteId: 'quote-a',
          quoteVersion: 'v1',
          decisionId: 'stale-after-b',
          decision: 'approve',
        }),
      ).toMatchObject({ ok: true, receipt: { status: 'stale' } });
      expect((await costs.totals()).heldUsd).toBe(0.8);
      const refreshed = {
        ...prepared,
        quoteRequestId: 'prepare-refresh',
        leaseToken: null,
        quote: {
          ...quote,
          quoteId: 'quote-b',
          quoteVersion: 'v2',
          recordedDailyMicros: 10_000,
          recordedMonthlyMicros: 10_000,
          dailyProjectedGrossMicros: planned,
          monthlyProjectedGrossMicros: planned,
        },
      };
      expect(await storePreparedFirestoreQuote(store, refreshed)).toMatchObject({
        ok: true,
        request: { status: 'pending', quote: { quoteId: 'quote-b' } },
      });
      expect(
        (
          await store
            .doc('messages', estimatedCostCardMessageId('operation-a', 'quote-b', 'v2'))
            .get()
        ).exists,
      ).toBe(true);
      expect(await storePreparedFirestoreQuote(store, prepared)).toMatchObject({
        ok: false,
        outcome: 'conflict',
      });
      const decision = {
        operationId: 'operation-a',
        quoteId: 'quote-b',
        quoteVersion: 'v2',
        decisionId: 'decision-one',
        decision: 'approve' as const,
      };
      const decisions = await Promise.all([
        approveFirestoreEstimatedCost(store, actor, decision),
        approveFirestoreEstimatedCost(store, actor, { ...decision, decisionId: 'decision-two' }),
      ]);
      const winner = decisions.find((item) => item.ok && item.receipt.status === 'approved');
      expect(winner?.ok).toBe(true);
      expect(decisions.filter((item) => !item.ok)).toHaveLength(1);
      if (!winner?.ok) throw new Error('Expected approval receipt');
      expect(
        await approveFirestoreEstimatedCost(store, actor, {
          ...decision,
          decisionId: winner.receipt.decisionId,
        }),
      ).toEqual(winner);
      const task = await store.doc('tasks', 'a').get();
      expect(task.get('status')).toBe('pending');
      const marker = task.get('state').estimatedCostApproval as { grantId: string };
      expect((await costs.readEstimatedCostView(actor, 'operation-a'))?.tracking).toMatchObject({
        recordedDailyMicros: 10_000,
        totalHeldMicros: projected,
        historicalUnknownMicros: 800_000,
        pendingApprovalMicros: 0,
        dailyPlannedExposureMicros: planned,
      });
      const common = {
        actor,
        operationId: 'operation-a',
        grantId: marker.grantId,
        bindingDigest,
        taskId: 'a',
        source: 'model' as const,
      };
      expect(
        await costs.drawEstimatedCostGrant({
          ...common,
          attemptId: 'classify-attempt',
          estimatedMicros: critical ? 300_001 : 300_000,
          description: 'classify',
        }),
      ).toMatchObject({ ok: true });
      expect(
        await costs.drawEstimatedCostGrant({
          ...common,
          attemptId: 'plan-attempt',
          estimatedMicros: 100_000,
          description: 'plan',
        }),
      ).toMatchObject({ ok: true });
      expect(
        await costs.drawEstimatedCostGrant({
          ...common,
          attemptId: 'draft-attempt',
          estimatedMicros: 100_000,
          description: 'draft',
        }),
      ).toMatchObject({ ok: true });
      expect((await costs.totals()).heldUsd).toBe(projected / 1_000_000);
      await store.doc('tasks', 'a').update({
        status: 'running',
        leaseToken: 'resume-lease',
        lockedUntil: new Date(now.getTime() + 600_000),
      });
      const makeAttempt = (
        role: string,
        reservationId: string,
        amount: number,
        digest: string,
      ) => ({
        actor,
        operationId: 'operation-a',
        taskId: 'a',
        grantId: marker.grantId,
        reservationId,
        leaseToken: 'resume-lease',
        role,
        critical,
        modelId: 'fallback',
        nextAttemptMicros: amount,
        routingDigest: digest.repeat(64),
        requestDigest: digest.repeat(64),
        metadata: {
          provider: 'openrouter',
          model: 'fallback',
          role,
          requestDigest: digest.repeat(64),
          inputTokenEstimate: 1,
          outputTokenLimit: 1,
          reasoning: 'disabled' as const,
        },
      });
      const classify = makeAttempt(
        'classify',
        'classify-attempt',
        critical ? 300_001 : 300_000,
        'a',
      );
      if (environment) {
        const changed = new InstallationStore(
          store.db,
          store.installationId,
          store.now,
          manifest.projectId,
          '(default)',
          { ...manifest, secretVersion: manifest.secretVersion.replace('/7', '/8') },
        );
        expect(await beginFirestoreEstimatedCostGrantAttempt(changed, classify)).toBe(false);
      }
      expect(
        await beginFirestoreEstimatedCostGrantAttempt(store, {
          ...classify,
          routingDigest: 'f'.repeat(64),
        }),
      ).toBe(false);
      if (!critical)
        expect(
          await beginFirestoreEstimatedCostGrantAttempt(store, { ...classify, critical: true }),
        ).toBe(false);
      expect(await beginFirestoreEstimatedCostGrantAttempt(store, classify)).toBe(true);
      expect(await beginFirestoreEstimatedCostGrantAttempt(store, classify)).toBe(false);
      await costs.markAttemptUnknown('classify-attempt', 'uncertain');
      expect(
        await beginFirestoreEstimatedCostGrantAttempt(
          store,
          makeAttempt('plan', 'plan-attempt', 100_000, 'c'),
        ),
      ).toBe(true);
      await store.doc('models', 'fallback').update({ promptCostPerMTok: '0.6000' });
      expect(
        await beginFirestoreEstimatedCostGrantAttempt(
          store,
          makeAttempt('draft', 'draft-attempt', 100_000, 'd'),
        ),
      ).toBe(false);
    },
    30_000,
  );

  it('prepares and parks a server candidate, then refreshes after independent spend', async () => {
    for (const role of ['extract', 'reason', 'rewrite', 'embed', 'batch'])
      await store
        .doc('modelRoles', role)
        .set({ role, primaryModel: 'primary', fallbackModel: 'fallback', params: {} });
    await store.doc('taskBudgetHolds', 'a').delete();
    const costs = new FirestoreCostRepository(store);
    const old = await costs.reserve({ source: 'model', estimatedUsd: 0.8 });
    if (!old.ok) throw new Error('Expected historical hold');
    await store.doc('costReservations', old.reservationId).update({ status: 'unknown' });
    const baseline = [{ reservationId: old.reservationId, estimatedMicros: 800_000 }];
    const actor = { installationId: store.installationId, ownerId: 'owner' };
    await store.doc('estimatedCostBaselines', store.installationId).set({
      installationId: store.installationId,
      ownerId: 'owner',
      rows: baseline,
      createdAt: now,
      digest: createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
    });
    const parking = createFirestoreEstimatedCostTurnParking(store, {
      mutationsEnabled: () => true,
    });
    const input = {
      actor,
      operationId: 'operation-a',
      conversationId: 'conversation',
      taskId: 'a',
      leaseToken: 'lease',
      requestFingerprint: 'fingerprint',
      quoteRequestId: 'prepare-a',
      candidate: {
        role: 'classify',
        critical: false,
        modelId: 'fallback',
        nextAttemptMicros: 300_000,
        routingDigest: 'a'.repeat(64),
        requestDigest: 'b'.repeat(64),
      },
    };
    expect(await createFirestoreEstimatedCostTurnParking(store).park(input)).toMatchObject({
      ok: false,
      outcome: 'unavailable',
    });
    expect((await store.doc('tasks', 'a').get()).get('status')).toBe('running');
    const outcome = await parking.park(input);
    expect(outcome).toMatchObject({
      ok: true,
      status: 'pending',
      operationId: 'operation-a',
      taskId: 'a',
    });
    expect((await store.doc('taskBudgetHolds', 'a').get()).get('heldMicros')).toBe(0);
    expect((await costs.totals()).heldUsd).toBe(0.8);
    const b = await costs.reserve({ source: 'model', estimatedUsd: 0.1 });
    if (!b.ok) throw new Error('B must remain eligible');
    await costs.reconcile(b.reservationId, { usd: 0.01 });
    const preparation = await createFirestoreEstimatedCostQuotePreparer(store, {
      mutationsEnabled: () => true,
    }).prepare(actor, {
      operationId: 'operation-a',
      quoteRequestId: 'refresh-a',
    });
    if (!preparation.ok) throw new Error('Expected refreshed quote');
    expect(preparation.prepared.quote).toMatchObject({
      recordedDailyMicros: 10_000,
      totalHeldMicros: 800_000,
      pendingApprovalMicros: 500_000,
      dailyProjectedGrossMicros: 1_310_000,
    });
    expect(await storePreparedFirestoreQuote(store, preparation.prepared)).toMatchObject({
      ok: true,
      request: { status: 'pending' },
    });
  }, 30_000);
});
