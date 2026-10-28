import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getFirestoreMobileCosts,
  summarizeUnknownAttemptEstimates,
  unknownAttemptSummary,
} from './mobile-costs.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore, seedBudget } from './test-store.js';

describe('unknown cost attempt summary', () => {
  it('reports exact empty coverage as zero', () => {
    expect(summarizeUnknownAttemptEstimates([], false)).toEqual({
      count: 0,
      countComplete: true,
      estimatedUsd: '0.000000',
      estimateComplete: true,
    });
  });

  it('reports exact coverage at the 500-row boundary', () => {
    const summary = summarizeUnknownAttemptEstimates(
      Array.from({ length: 500 }, () => '0.01'),
      false,
    );
    expect(summary).toEqual({
      count: 500,
      countComplete: true,
      estimatedUsd: '5.000000',
      estimateComplete: true,
    });
  });

  it('sums retained estimates only for a complete bounded snapshot', () => {
    expect(summarizeUnknownAttemptEstimates(['0.125000', '0.250000'], false)).toEqual({
      count: 2,
      countComplete: true,
      estimatedUsd: '0.375000',
      estimateComplete: true,
    });
  });

  it('suppresses the amount when the bounded snapshot may be partial', () => {
    expect(
      summarizeUnknownAttemptEstimates(
        Array.from({ length: 501 }, () => '1.00'),
        true,
      ),
    ).toEqual({
      count: 501,
      countComplete: false,
      estimatedUsd: null,
      estimateComplete: false,
    });
  });

  it('keeps the count while withholding the estimate if any value is invalid', () => {
    expect(summarizeUnknownAttemptEstimates(['0.10', 'NaN'], false)).toEqual({
      count: 2,
      countComplete: true,
      estimatedUsd: null,
      estimateComplete: false,
    });
  });

  it('withholds the estimate for blank or out-of-range values', () => {
    for (const estimate of ['', '999999999999999999999999']) {
      expect(summarizeUnknownAttemptEstimates([estimate], false)).toMatchObject({
        count: 1,
        countComplete: true,
        estimatedUsd: null,
        estimateComplete: false,
      });
    }
  });
});

describe('unknown reservation Firestore query', () => {
  it('uses one selected, bounded status query and returns a complete total below the limit', async () => {
    const calls: unknown[][] = [];
    const query = {
      where: (...args: unknown[]) => {
        calls.push(['where', ...args]);
        return query;
      },
      select: (...args: unknown[]) => {
        calls.push(['select', ...args]);
        return query;
      },
      limit: (...args: unknown[]) => {
        calls.push(['limit', ...args]);
        return query;
      },
      get: async () => {
        calls.push(['get']);
        return {
          size: 2,
          docs: [
            {
              get: (field: string) => {
                calls.push(['doc.get', field]);
                return '0.125000';
              },
            },
            {
              get: (field: string) => {
                calls.push(['doc.get', field]);
                return '0.250000';
              },
            },
          ],
        };
      },
    };
    const store = {
      collection: (name: string) => {
        calls.push(['collection', name]);
        return query;
      },
    };

    await expect(unknownAttemptSummary(store as unknown as InstallationStore)).resolves.toEqual({
      count: 2,
      countComplete: true,
      estimatedUsd: '0.375000',
      estimateComplete: true,
    });
    expect(calls).toEqual([
      ['collection', 'costReservations'],
      ['where', 'status', '==', 'unknown'],
      ['select', 'estimatedUsd'],
      ['limit', 501],
      ['get'],
      ['doc.get', 'estimatedUsd'],
      ['doc.get', 'estimatedUsd'],
    ]);
  });

  it('withholds amount at the limit because the snapshot may be truncated', async () => {
    let getCount = 0;
    const query = {
      where: () => query,
      select: () => query,
      limit: (amount: number) => {
        expect(amount).toBe(501);
        return query;
      },
      get: async () => {
        getCount += 1;
        return {
          size: 501,
          docs: Array.from({ length: 501 }, () => ({
            get: () => {
              throw new Error('Truncated snapshot must not read row values');
            },
          })),
        };
      },
    };
    const store = { collection: () => query };
    await expect(unknownAttemptSummary(store as unknown as InstallationStore)).resolves.toEqual({
      count: 501,
      countComplete: false,
      estimatedUsd: null,
      estimateComplete: false,
    });
    expect(getCount).toBe(1);
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore mobile cost dashboard', () => {
  let store: InstallationStore;
  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-09-22T12:00:00Z'));
    await seedBudget(store);
    await Promise.all([
      store.doc('coordination', 'budget-holds').set({ heldMicros: 20_000 }),
      store.doc('budgetPeriods', 'day:2026-09-22').set({ spentMicros: 50_200 }),
      store.doc('budgetPeriods', 'month:2026-09').set({ spentMicros: 50_200 }),
      store.doc('budgets', 'task_default').set({ scope: 'task_default', limitUsd: '0.50' }),
      store.doc('agents', 'owner').set({
        id: 'owner',
        name: 'Owner',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        signature: '',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      store.doc('agents', 'foreign').set({
        id: 'foreign',
        name: 'Foreign',
        timezone: 'Europe/London',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      store
        .doc('tasks', 'task-a')
        .set({ id: 'task-a', type: 'chat', progress: 'Running', status: 'waiting_budget' }),
      store.doc('costReservations', 'hold').set({
        id: 'hold',
        source: 'model',
        description: 'Next call',
        estimatedUsd: '0.020000',
        status: 'held',
        createdAt: new Date('2026-09-22T11:00:00Z'),
      }),
    ]);
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  it('reads every page and preserves owner-scoped dashboard totals', async () => {
    const batchOne = store.db.batch();
    const batchTwo = store.db.batch();
    for (let index = 0; index < 501; index++) {
      (index < 450 ? batchOne : batchTwo).set(store.doc('costEvents', `event-${index}`), {
        id: `event-${index}`,
        taskId: 'task-a',
        source: 'model',
        description: 'Model call',
        evidence: {
          basis: index === 0 ? 'token_rate' : 'provider_reported',
          provider: 'openrouter',
        },
        usd: '0.000100',
        createdAt: new Date(Date.UTC(2026, 8, 22, 0, 0, index)),
      });
    }
    batchTwo.set(store.doc('costEvents', 'other'), {
      id: 'other',
      taskId: null,
      source: 'external_api',
      description: 'Other charge',
      usd: '0.000100',
      createdAt: new Date('2026-09-22T11:00:00Z'),
    });
    batchTwo.set(store.doc('costEvents', 'old'), {
      id: 'old',
      taskId: null,
      source: 'model',
      description: 'Last month',
      usd: '99.000000',
      createdAt: new Date('2026-08-31T23:59:59Z'),
    });
    batchTwo.set(store.doc('modelCalls', 'model-one'), {
      id: 'model-one',
      model: 'gemini-2.5-flash',
      costUsd: '0.004000',
      createdAt: new Date('2026-09-22T09:00:00Z'),
    });
    await batchOne.commit();
    await batchTwo.commit();

    const dashboard = await getFirestoreMobileCosts(store, 'owner');
    expect(dashboard.timezone).toBe('America/Los_Angeles');
    expect(dashboard.totals).toMatchObject({ monthlySpentUsd: 0.0502, heldUsd: 0.02 });
    expect(dashboard.bySource).toEqual([
      { source: 'model', usd: '0.050100', count: 501 },
      { source: 'external_api', usd: '0.000100', count: 1 },
    ]);
    expect(dashboard.byEvidence).toEqual([
      { basis: 'provider_reported', usd: '0.050000', count: 500 },
      { basis: 'token_rate', usd: '0.000100', count: 1 },
      { basis: 'unknown', usd: '0.000100', count: 1 },
    ]);
    expect(dashboard.byModel).toEqual([{ model: 'gemini-2.5-flash', usd: '0.004000', count: 1 }]);
    expect(dashboard.topTasks).toEqual([
      { taskId: 'task-a', usd: '0.050100', type: 'chat', progress: 'Running' },
    ]);
    expect(dashboard.held).toEqual([
      { id: 'hold', source: 'model', description: 'Next call', estimatedUsd: '0.020000' },
    ]);
    expect(dashboard.recent[0]?.id).toBe('other');
    expect(dashboard.parkedTasks).toBe(1);
    expect(dashboard.taskDefaultLimit).toBe('0.50');
  }, 30_000);

  it('refuses a dashboard read while owner privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'active' });
    await expect(getFirestoreMobileCosts(store, 'owner')).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    await expect(getFirestoreMobileCosts(store, 'missing')).rejects.toThrow(
      'Cost dashboard owner is missing',
    );
  });
});
