import type { AppendMessageInput, CostTotals } from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { expect, it, vi } from 'vitest';
import { postBudgetPauseNotice } from './notices.js';
import type { ExecutorDeps } from './types.js';

const task = taskFixture({
  id: 'paused-task',
  agentId: 'fixture-owner',
  conversationId: 'fixture-chat',
  reminderId: '',
});

function fixture() {
  const append = vi.fn(async (_message: AppendMessageInput) => {});
  const totals = vi.fn<() => Promise<CostTotals>>();
  const deps = {
    persistence: {
      costs: { kind: 'cost-repository', totals },
      messages: { kind: 'message-repository', append },
    },
  } as unknown as ExecutorDeps;
  return { deps, append, totals };
}

it('preserves the approved action and known monthly scope when the ledger read fails', async () => {
  const { deps, append, totals } = fixture();
  totals.mockRejectedValue(new Error('fixture ledger offline'));

  await postBudgetPauseNotice(deps, task, {
    reason: 'monthly budget cannot cover this reservation',
    budgetRetry: { scope: 'monthly', nextAttemptMicros: 400_000, critical: false },
    approvedAction: true,
  });

  const summary =
    'The approved action could not fit within the monthly limit. Spending details are unavailable.';
  expect(append).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      taskId: task.id,
      text: `${summary} Review or raise the limit in [Costs](/costs).`,
      parts: expect.arrayContaining([
        expect.objectContaining({
          notice: 'parked',
          presentation: expect.objectContaining({ summary }),
        }),
      ]),
    }),
  );
});

it.each([
  'reservation already closed; do not repeat provider work',
  'task ledger storage capacity cannot cover this reservation',
  'task budget cannot cover this reservation',
])(
  'publishes the specific cause without suggesting a period cap increase for %s',
  async (reason) => {
    const { deps, append, totals } = fixture();

    await postBudgetPauseNotice(deps, task, { reason });

    expect(totals).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        taskId: task.id,
        text: reason,
        parts: expect.arrayContaining([
          expect.objectContaining({
            notice: 'parked',
            presentation: expect.objectContaining({ summary: reason }),
          }),
        ]),
      }),
    );
  },
);

it('uses recorded period amounts and never substitutes all unresolved holds', async () => {
  const { deps, append, totals } = fixture();
  const ledger = {
    dailySpentUsd: 0.25,
    dailyHeldUsd: 0.75,
    dailyLimitUsd: 1,
    monthlySpentUsd: 2,
    monthlyLimitUsd: 10,
    heldUsd: 5,
    softPct: 80,
  };
  totals.mockResolvedValue(ledger);
  await postBudgetPauseNotice(deps, task, { reason: 'daily budget exhausted', scope: 'daily' });
  await postBudgetPauseNotice(deps, task, { reason: 'monthly budget exhausted', scope: 'monthly' });

  expect(append).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      text: 'The daily limit paused this work. $0.25 recorded as spend and $0.75 held. Review or raise the limit in [Costs](/costs).',
    }),
  );
  expect(append).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      text: 'The monthly limit paused this work. $2.00 recorded as spend. Holds unavailable. Review or raise the limit in [Costs](/costs).',
    }),
  );
});
