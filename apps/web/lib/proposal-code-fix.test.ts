import type { RepairIssue, RepairReport } from '@assistant/persistence';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  enabled: true,
  open: true,
  kind: 'note',
  provider: 'github',
  token: 'test-only',
  acknowledge: vi.fn(),
  service: vi.fn(),
}));
vi.mock('@assistant/config', async (original) => ({
  ...(await original<typeof import('@assistant/config')>()),
  loadConfig: () => ({
    SELF_REPAIR_ENABLED: state.enabled,
    GITHUB_REPO: 'owner/repo',
    GITHUB_TOKEN: state.token,
    SELF_REPAIR_PROVIDER: state.provider,
  }),
}));
vi.mock('./server', () => ({ getSelfRepairService: state.service }));
vi.mock('./workspace-reviews', () => ({
  listOpenImprovements: async () =>
    state.open
      ? [
          {
            id: 'proposal',
            kind: state.kind,
            title: 'Add a missing interaction',
            rationale: 'Synthetic missing button',
            change: { suggestion: 'Create an owned code-fix report' },
            evidenceIds: ['00000000-0000-4000-a000-000000000001'],
          },
        ]
      : [],
  decideOwnerImprovement: state.acknowledge,
}));

import { proposalCodeFixReceipt, requestOwnerProposalCodeFix } from './proposal-code-fix';

let reports: Map<string, RepairIssue>;
beforeEach(() => {
  reports = new Map();
  state.enabled = true;
  state.open = true;
  state.kind = 'note';
  state.provider = 'github';
  state.token = 'test-only';
  state.acknowledge.mockReset().mockImplementation(async () => {
    state.open = false;
  });
  state.service.mockReset().mockResolvedValue({
    agentId: 'owner',
    repository: {
      list: async () => [...reports.values()],
      report: async (agentId: string, input: RepairReport) => {
        const existing = reports.get(input.fingerprint);
        if (existing) return existing;
        const row: RepairIssue = {
          id: 'repair',
          agentId,
          fingerprint: input.fingerprint,
          version: 0,
          status: 'reported',
          createdAt: new Date(),
          updatedAt: new Date(),
          data: { ...input, history: [] },
        };
        reports.set(input.fingerprint, row);
        return row;
      },
    },
  });
});
it('converts an owned advisory into a durable queued report and deduplicates concurrent and later clicks', async () => {
  const [first, second] = await Promise.all([
    requestOwnerProposalCodeFix('proposal'),
    requestOwnerProposalCodeFix('proposal'),
  ]);
  expect(first.id).toBe(second.id);
  expect(reports.size).toBe(1);
  expect(first.data).toMatchObject({
    source: 'proposal',
    proposalId: 'proposal',
    sourceTaskId: '00000000-0000-4000-a000-000000000001',
    title: 'Add a missing interaction',
  });
  expect(first.status).toBe('reported');
  expect(first.data.manualRunRequestedAt).toBeUndefined();
  expect(state.open).toBe(false);
  expect((await requestOwnerProposalCodeFix('proposal')).id).toBe(first.id);
});
it('recovers an acknowledgement failure without duplicating the already-created report', async () => {
  state.acknowledge.mockRejectedValueOnce(new Error('temporary failure'));
  await expect(requestOwnerProposalCodeFix('proposal')).rejects.toThrow('temporary failure');
  expect(reports.size).toBe(1);
  expect((await requestOwnerProposalCodeFix('proposal')).id).toBe('repair');
  expect(reports.size).toBe(1);
  expect(state.open).toBe(false);
});
it('accepts a hosted code-fix request without a legacy worker credential', async () => {
  state.provider = 'openai_hosted';
  state.token = '';
  expect(await requestOwnerProposalCodeFix('proposal')).toMatchObject({ status: 'reported' });
  expect(reports.size).toBe(1);
});
it('rejects unavailable, foreign/missing, and directly applyable proposals without creating a report', async () => {
  await expect(requestOwnerProposalCodeFix('foreign')).rejects.toThrow('not found');
  state.kind = 'model_role';
  await expect(requestOwnerProposalCodeFix('proposal')).rejects.toThrow('applied directly');
  state.enabled = false;
  await expect(requestOwnerProposalCodeFix('proposal')).rejects.toThrow('Configure');
  expect(reports.size).toBe(0);
  expect(state.acknowledge).not.toHaveBeenCalled();
});

it.each(['failed', 'blocked', 'resolved', 'dismissed', 'monitoring', 'pr_open'] as const)(
  'preserves an existing %s report without implying a new run',
  async (status) => {
    const first = await requestOwnerProposalCodeFix('proposal');
    first.status = status;
    const repeated = await requestOwnerProposalCodeFix('proposal');
    expect(repeated.status).toBe(status);
    expect(reports.size).toBe(1);
    expect(proposalCodeFixReceipt(repeated)).toMatchObject({
      outcome: 'code_fix_requested',
      enacted: false,
      repairIssueId: first.id,
      repairStatus: status,
    });
    expect(proposalCodeFixReceipt(repeated).detail).toContain('No new coding run');
    expect(proposalCodeFixReceipt(repeated).detail).not.toContain('queued');
  },
);
