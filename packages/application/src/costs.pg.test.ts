import { randomUUID } from 'node:crypto';
import {
  agents,
  costEvents,
  costReservations,
  createDb,
  createPostgresCostRepository,
  type Db,
  modelCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { addMicros, usdDecimalToMicros } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { getCostsDashboard } from './costs.js';

const DATABASE_URL = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl: DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});
if (!DATABASE_URL) throw new Error('Missing allocated test database URL');

describe('PostgreSQL costs dashboard reservation exposure aggregate', () => {
  it('accounts for held, dispatching, and unknown exposure once without counting settled rows', async () => {
    const db = createDb(DATABASE_URL, { max: 1, statementTimeoutMs: 10_000 });

    try {
      const owners = await db.select({ id: agents.id }).from(agents).limit(2);
      expect(owners).toHaveLength(1);

      const spentEventId = randomUUID();
      const unknownReservationId = randomUUID();
      const heldReservationId = randomUUID();
      const dispatchingReservationId = randomUUID();
      const reconciledReservationId = randomUUID();
      const releasedReservationId = randomUUID();
      const unknownDescription = `unknown-cost-${randomUUID()}`;
      const heldDescription = `held-cost-${randomUUID()}`;
      const rollback = new Error('rollback synthetic cost dashboard fixture');
      let before: Awaited<ReturnType<typeof getCostsDashboard>> | undefined;
      let after: Awaited<ReturnType<typeof getCostsDashboard>> | undefined;
      let rollbackObserved = false;

      try {
        await db.transaction(
          async (tx) => {
            before = await getCostsDashboard(tx as unknown as Db);
            await tx.insert(costEvents).values({
              id: spentEventId,
              source: 'model',
              usd: '0.070000',
              description: `spent-cost-${spentEventId}`,
            });
            await tx.insert(costReservations).values([
              {
                id: unknownReservationId,
                source: 'model',
                estimatedUsd: '0.030000',
                status: 'unknown',
                unknownReason: 'synthetic PostgreSQL aggregate fixture',
                description: unknownDescription,
              },
              {
                id: heldReservationId,
                source: 'model',
                estimatedUsd: '0.010000',
                status: 'held',
                description: heldDescription,
              },
              {
                id: dispatchingReservationId,
                source: 'model',
                estimatedUsd: '0.020000',
                status: 'dispatching',
                description: `dispatching-cost-${dispatchingReservationId}`,
              },
              {
                id: reconciledReservationId,
                source: 'model',
                estimatedUsd: '0.040000',
                status: 'reconciled',
                description: `reconciled-cost-${reconciledReservationId}`,
              },
              {
                id: releasedReservationId,
                source: 'model',
                estimatedUsd: '0.050000',
                status: 'released',
                description: `released-cost-${releasedReservationId}`,
              },
            ]);
            after = await getCostsDashboard(tx as unknown as Db);
            throw rollback;
          },
          { isolationLevel: 'repeatable read' },
        );
      } catch (error) {
        if (error !== rollback) throw error;
        rollbackObserved = true;
      }

      expect(rollbackObserved).toBe(true);
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      if (!before || !after) throw new Error('Synthetic dashboard snapshots were not captured');

      expect(after.unknownAttempts.count - before.unknownAttempts.count).toBe(1);
      expect(after.unknownAttempts.countComplete).toBe(true);
      expect(after.unknownAttempts.estimateComplete).toBe(true);
      expect(
        Number(after.unknownAttempts.estimatedUsd) - Number(before.unknownAttempts.estimatedUsd),
      ).toBeCloseTo(0.03, 6);
      expect(after.dispatchingAttempts.count - before.dispatchingAttempts.count).toBe(1);
      expect(after.dispatchingAttempts.countComplete).toBe(true);
      expect(after.dispatchingAttempts.estimateComplete).toBe(true);
      expect(
        Number(after.dispatchingAttempts.estimatedUsd) -
          Number(before.dispatchingAttempts.estimatedUsd),
      ).toBeCloseTo(0.02, 6);
      expect(after.totals.monthlySpentUsd - before.totals.monthlySpentUsd).toBeCloseTo(0.07, 6);
      expect(after.totals.heldUsd - before.totals.heldUsd).toBeCloseTo(0.06, 6);
      expect(
        Number(after.held.find((row) => row.id === heldReservationId)?.estimatedUsd ?? 0) +
          Number(after.dispatchingAttempts.estimatedUsd) -
          Number(before.dispatchingAttempts.estimatedUsd) +
          Number(after.unknownAttempts.estimatedUsd) -
          Number(before.unknownAttempts.estimatedUsd),
      ).toBeCloseTo(0.06, 6);
      expect(after.held.some((row) => row.id === heldReservationId)).toBe(true);
      expect(after.held.some((row) => row.id === unknownReservationId)).toBe(false);
      expect(after.held.some((row) => row.description === unknownDescription)).toBe(false);
      expect(after.held.some((row) => row.description === heldDescription)).toBe(true);
      expect(after.held.some((row) => row.id === dispatchingReservationId)).toBe(false);
      expect(after.held.some((row) => row.id === reconciledReservationId)).toBe(false);
      expect(after.held.some((row) => row.id === releasedReservationId)).toBe(false);
    } finally {
      await db.$client.end();
    }
  });

  it('groups only current-month model cost events by normalized evidence without folding retries', async () => {
    const db = createDb(DATABASE_URL, { max: 1, statementTimeoutMs: 10_000 });
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const model = `finance-model-${randomUUID()}`;
    const retryOne = randomUUID();
    const retryTwo = randomUUID();
    const rollback = new Error('rollback synthetic model evidence fixture');
    let before: Awaited<ReturnType<typeof getCostsDashboard>> | undefined;
    let after: Awaited<ReturnType<typeof getCostsDashboard>> | undefined;
    let rollbackObserved = false;

    try {
      try {
        await db.transaction(
          async (tx) => {
            before = await getCostsDashboard(tx as unknown as Db);
            await tx.insert(costReservations).values([
              {
                id: retryOne,
                source: 'model',
                estimatedUsd: '0.100000',
                description: 'first synthetic retry',
              },
              {
                id: retryTwo,
                source: 'model',
                estimatedUsd: '0.200000',
                description: 'second synthetic retry',
              },
            ]);
            await tx.insert(costEvents).values([
              {
                id: randomUUID(),
                source: 'model',
                evidence: { basis: 'token_rate', provider: 'openrouter', model },
                usd: '0.000001',
                description: 'estimated model event',
                createdAt: now,
              },
              {
                id: randomUUID(),
                source: 'model',
                evidence: {
                  basis: 'provider_reported',
                  provider: 'vertex',
                  model: `vertex:${model}`,
                },
                usd: '0.400000',
                description: 'other provider event',
                createdAt: now,
              },
              {
                id: randomUUID(),
                source: 'model',
                usd: '0.000000',
                description: 'legacy missing evidence',
                createdAt: now,
              },
              {
                id: randomUUID(),
                source: 'model',
                evidence: { basis: 'unexpected_basis', provider: ' ', model: '' } as never,
                usd: '0.000000',
                description: 'malformed legacy evidence',
                createdAt: now,
              },
              ...[
                { basis: 'provider_reported', provider: 17, model: true },
                { basis: 'provider_reported', provider: {}, model: ['not-a-model'] },
                { basis: 'provider_reported', provider: null, model: null },
              ].map((evidence) => ({
                id: randomUUID(),
                source: 'model' as const,
                evidence: evidence as never,
                usd: '0.000000',
                description: 'malformed typed model evidence dimension',
                createdAt: now,
              })),
              {
                id: randomUUID(),
                source: 'external_api',
                evidence: { basis: 'provider_reported', provider: 'openrouter', model },
                usd: '99.000000',
                description: 'non-model source decoy',
                createdAt: now,
              },
              {
                id: randomUUID(),
                source: 'model',
                evidence: { basis: 'provider_reported', provider: 'openrouter', model },
                usd: '80.000000',
                description: 'previous UTC month decoy',
                createdAt: new Date(monthStart.getTime() - 1),
              },
              {
                id: randomUUID(),
                source: 'model',
                evidence: { basis: 'provider_reported', provider: 'openrouter', model },
                usd: '70.000000',
                description: 'next UTC month decoy',
                createdAt: nextMonth,
              },
            ]);
            const costs = createPostgresCostRepository(tx as unknown as Db);
            const firstRetry = {
              usd: 0.1,
              evidence: {
                basis: 'provider_reported' as const,
                provider: 'openrouter',
                model,
                requestId: 'same-provider-request',
              },
            };
            await costs.reconcile(retryOne, firstRetry);
            await costs.reconcile(retryOne, firstRetry);
            await costs.reconcile(retryTwo, { ...firstRetry, usd: 0.2 });
            await tx.insert(modelCalls).values({
              id: randomUUID(),
              role: 'chat',
              model,
              inputTokens: 10,
              outputTokens: 10,
              costUsd: '60.000000',
              createdAt: now,
            });
            after = await getCostsDashboard(tx as unknown as Db);
            throw rollback;
          },
          { isolationLevel: 'repeatable read' },
        );
      } catch (error) {
        if (error !== rollback) throw error;
        rollbackObserved = true;
      }

      expect(rollbackObserved).toBe(true);
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      if (!before || !after) throw new Error('Synthetic dashboard snapshots were not captured');

      const fixtureRows = after.byModelEvidence.filter(
        (row) => row.model === model || (row.provider === null && row.model === null),
      );
      expect(fixtureRows).toContainEqual({
        provider: 'openrouter',
        model,
        basis: 'provider_reported',
        usd: '0.300000',
        count: 2,
      });
      expect(fixtureRows).toContainEqual({
        provider: 'openrouter',
        model,
        basis: 'token_rate',
        usd: '0.000001',
        count: 1,
      });
      expect(fixtureRows).toContainEqual({
        provider: 'vertex',
        model: `vertex:${model}`,
        basis: 'provider_reported',
        usd: '0.400000',
        count: 1,
      });
      const unknownBefore = before.byModelEvidence.find(
        (row) => row.provider === null && row.model === null && row.basis === 'unknown',
      );
      const unknownAfter = after.byModelEvidence.find(
        (row) => row.provider === null && row.model === null && row.basis === 'unknown',
      );
      expect(unknownAfter?.count).toBe((unknownBefore?.count ?? 0) + 2);
      expect(unknownAfter?.usd).toBe(unknownBefore?.usd ?? '0.000000');
      const malformedDimensions = after.byModelEvidence.find(
        (row) => row.provider === null && row.model === null && row.basis === 'provider_reported',
      );
      const malformedDimensionsBefore = before.byModelEvidence.find(
        (row) => row.provider === null && row.model === null && row.basis === 'provider_reported',
      );
      expect(malformedDimensions?.count).toBe((malformedDimensionsBefore?.count ?? 0) + 3);
      expect(malformedDimensions?.usd).toBe(malformedDimensionsBefore?.usd ?? '0.000000');

      const bySourceBefore = before.bySource.find((row) => row.source === 'model');
      const bySourceAfter = after.bySource.find((row) => row.source === 'model');
      expect((bySourceAfter?.count ?? 0) - (bySourceBefore?.count ?? 0)).toBe(10);
      expect(
        usdDecimalToMicros(bySourceAfter?.usd ?? '0') -
          usdDecimalToMicros(bySourceBefore?.usd ?? '0'),
      ).toBe(70_700_001);
      const modelRowsMicros = after.byModelEvidence.reduce(
        (sum, row) => addMicros(sum, usdDecimalToMicros(row.usd)),
        0,
      );
      const modelRowsMicrosBefore = before.byModelEvidence.reduce(
        (sum, row) => addMicros(sum, usdDecimalToMicros(row.usd)),
        0,
      );
      expect(modelRowsMicros - modelRowsMicrosBefore).toBe(700_001);
      const modelRowsCount = after.byModelEvidence.reduce((sum, row) => sum + row.count, 0);
      const modelRowsCountBefore = before.byModelEvidence.reduce((sum, row) => sum + row.count, 0);
      expect(modelRowsCount - modelRowsCountBefore).toBe(9);
      expect(modelRowsMicros).toBeLessThan(
        after.byEvidence.reduce((sum, row) => addMicros(sum, usdDecimalToMicros(row.usd)), 0),
      );
    } finally {
      await db.$client.end();
    }
  });
});
