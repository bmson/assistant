import { randomUUID } from 'node:crypto';
import { agents, costEvents, costReservations, createDb, type Db } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
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
});
