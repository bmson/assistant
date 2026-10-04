import type { RepairIssue, SelfRepairRepository } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { decideRepairIssue, listRepairIssues, projectRepairIssue } from './self-repair.js';

const issue: RepairIssue = {
  id: 'issue',
  agentId: 'owner',
  fingerprint: 'x',
  status: 'monitoring',
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  data: {
    source: 'feedback',
    title: 'Fix',
    summary: 'Issue',
    prUrl: 'javascript:alert(1)',
    runUrl: 'https://other.example/run',
    history: [],
  },
};
it('only confirms deployed fixes and rejects stale/foreign issue decisions', async () => {
  const update = vi.fn(async () => issue);
  const repository = { list: async () => [issue], update } as unknown as SelfRepairRepository;
  await decideRepairIssue(repository, 'owner', 'issue', 'resolve');
  expect(update).toHaveBeenCalledWith(issue, 'resolved', expect.any(Object), expect.any(Date));
  await expect(decideRepairIssue(repository, 'owner', 'other', 'resolve')).rejects.toThrow(
    'not found',
  );
  issue.status = 'pr_open';
  await expect(decideRepairIssue(repository, 'owner', 'issue', 'resolve')).rejects.toThrow(
    'after the fix is deployed',
  );
  await expect(decideRepairIssue(repository, 'owner', 'issue', 'dismiss')).rejects.toThrow(
    'Active work',
  );
  issue.status = 'monitoring';
});
it('does not expose untrusted executable links', () => {
  expect(projectRepairIssue(issue)).toMatchObject({ prUrl: null, runUrl: null });
});

it('retries join the back of the queue and clear the previous investigation', async () => {
  const old = {
    ...issue,
    id: 'old',
    status: 'blocked' as const,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    data: {
      ...issue.data,
      diagnosis: 'Old diagnosis',
      category: 'unknown' as const,
      reproduction: 'Old steps',
      mergeSha: 'a'.repeat(40),
      monitoringAt: new Date(0).toISOString(),
    },
  };
  const fresh = { ...issue, id: 'fresh', status: 'reported' as const, updatedAt: new Date(1000) };
  let rows: RepairIssue[] = [old, fresh];
  const repository = {
    list: async () => rows,
    update: vi.fn<SelfRepairRepository['update']>(async (row, status, patch, now) => {
      const next = { ...row, status, data: { ...row.data, ...patch }, updatedAt: now };
      rows = rows.map((item) => (item.id === row.id ? next : item));
      return next;
    }),
  } as unknown as SelfRepairRepository;
  await decideRepairIssue(repository, 'owner', 'old', 'retry');
  const projected = await listRepairIssues(repository, 'owner');
  expect(projected.find((row) => row.id === 'fresh')?.queuePosition).toBe(1);
  expect(projected.find((row) => row.id === 'old')).toMatchObject({
    queuePosition: 2,
    diagnosis: '',
    lastError: '',
    mergeSha: null,
  });
  expect(rows.find((row) => row.id === 'old')?.data.monitoringAt).toBeUndefined();
  rows.push({ ...issue, status: 'pr_open' });
  expect(
    (await listRepairIssues(repository, 'owner')).find((row) => row.id === 'old')?.waitingReason,
  ).toContain('PR review');
});

it('shows the daily allowance blocker instead of implying an imminent start', async () => {
  const rows: RepairIssue[] = [
    {
      ...issue,
      status: 'failed',
      data: {
        ...issue.data,
        history: [{ status: 'fixing', at: new Date().toISOString(), detail: '' }],
      },
    },
    { ...issue, id: 'waiting', status: 'reported' },
  ];
  const repository = { list: async () => rows } as unknown as SelfRepairRepository;
  expect(
    (await listRepairIssues(repository, 'owner', 1)).find((row) => row.id === 'waiting')
      ?.waitingReason,
  ).toContain('Daily coding allowance used: 1 of 1');
  expect(
    (await listRepairIssues(repository, 'owner', 2)).find((row) => row.id === 'waiting')
      ?.waitingReason,
  ).toContain('next minute check');
});

it('records one owner-authorized manual run and refuses active or completed work', async () => {
  let saved: RepairIssue = { ...issue, status: 'reported', data: { ...issue.data } };
  const update = vi.fn<SelfRepairRepository['update']>(async (row, status, patch, now) => {
    saved = { ...row, status, data: { ...row.data, ...patch }, updatedAt: now };
    return saved;
  });
  const repository = { list: async () => [saved], update } as unknown as SelfRepairRepository;
  await decideRepairIssue(repository, 'owner', saved.id, 'run_now');
  expect(saved.data.manualRunRequestedAt).toEqual(expect.any(String));
  await decideRepairIssue(repository, 'owner', saved.id, 'run_now');
  expect(update).toHaveBeenCalledTimes(1);
  expect((await listRepairIssues(repository, 'owner', 0))[0]).toMatchObject({
    manualRunRequested: true,
    waitingReason: 'Manual run requested. Starts on the next minute check.',
  });
  saved = { ...saved, status: 'fixing' };
  await expect(decideRepairIssue(repository, 'owner', saved.id, 'run_now')).rejects.toThrow(
    'Only queued',
  );
});

it('prevents a retry from forgetting an active hosted session awaiting cleanup', async () => {
  const pending = {
    ...issue,
    status: 'failed' as const,
    data: { ...issue.data, hostedCleanupPending: true, hostedSessionId: 'sess_saved' },
  };
  const update = vi.fn();
  const repository = { list: async () => [pending], update } as unknown as SelfRepairRepository;
  await expect(decideRepairIssue(repository, 'owner', pending.id, 'run_now')).rejects.toThrow(
    'previous coding session',
  );
  expect(update).not.toHaveBeenCalled();
});

it.each(['retry', 'run_now'] as const)(
  'does not reuse a prior GitHub PR for a new %s attempt',
  async (action) => {
    const old = {
      ...issue,
      status: 'failed' as const,
      data: { ...issue.data, prNumber: 42, mergeSha: 'a'.repeat(40) },
    };
    const update = vi.fn();
    const repository = { list: async () => [old], update } as unknown as SelfRepairRepository;
    await expect(decideRepairIssue(repository, 'owner', old.id, action)).rejects.toThrow(
      'already has a pull request',
    );
    expect(update).not.toHaveBeenCalled();
  },
);

it('allows a cleaned-up hosted retry with a fresh branch and no previous deployment evidence', async () => {
  const old = {
    ...issue,
    status: 'failed' as const,
    data: {
      ...issue.data,
      workerProvider: 'openai_hosted' as const,
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      mergeSha: 'a'.repeat(40),
      monitoringAt: new Date(0).toISOString(),
      hostedCleanupPending: false,
    },
  };
  const update = vi.fn(async () => old);
  const repository = { list: async () => [old], update } as unknown as SelfRepairRepository;
  await decideRepairIssue(repository, 'owner', old.id, 'retry');
  expect(update).toHaveBeenCalledWith(
    old,
    'reported',
    expect.objectContaining({
      prNumber: undefined,
      mergeSha: undefined,
      monitoringAt: undefined,
      dispatchedAt: undefined,
    }),
    expect.any(Date),
  );
});
