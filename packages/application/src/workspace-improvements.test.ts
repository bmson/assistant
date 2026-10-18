import type { WorkspaceImprovementRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { listMobileWorkspaceImprovements } from './workspace-improvements.js';

describe('mobile workspace improvement projection', () => {
  it('retains the existing mobile payload and only marks model role changes applyable', async () => {
    const repository: WorkspaceImprovementRepository = {
      kind: 'workspace-improvement-repository',
      listOpen: async () => [
        {
          id: 'one',
          kind: 'model_role',
          title: 'Use another model',
          rationale: 'Retry cost',
          change: { suggestion: 'Switch the draft role' },
          evidenceIds: ['first', 'second'],
          createdAt: new Date('2026-09-22T00:00:00Z'),
        },
        {
          id: 'two',
          kind: 'note',
          title: 'Review workflow',
          rationale: 'Recurring failures',
          change: { suggestion: 12 },
          evidenceIds: [],
          createdAt: new Date('2026-09-21T00:00:00Z'),
        },
      ],
    };
    expect(await listMobileWorkspaceImprovements(repository, 'owner')).toEqual([
      {
        id: 'one',
        kind: 'model_role',
        title: 'Use another model',
        rationale: 'Retry cost',
        suggestion:
          "Change role '<omitted>': primary => <omitted>, fallback => <omitted>\n\nAdvisory: Switch the draft role",
        evidenceCount: 2,
        applyable: true,
        createdAt: '2026-09-22T00:00:00.000Z',
      },
      {
        id: 'two',
        kind: 'note',
        title: 'Review workflow',
        rationale: 'Recurring failures',
        suggestion: '',
        evidenceCount: 0,
        applyable: false,
        createdAt: '2026-09-21T00:00:00.000Z',
      },
    ]);
  });
});

describe('model role proposal suggestions', () => {
  it.each([
    {
      change: { role: 'test_role', primaryModel: 'model-A', fallbackModel: 'model-B' },
      expected: "Change role 'test_role': primary => model-A, fallback => model-B",
    },
    {
      change: { role: 'test_role', primaryModel: 'model-A' },
      expected: "Change role 'test_role': primary => model-A, fallback => <omitted>",
    },
    {
      change: { role: 'test_role', fallbackModel: 'model-B' },
      expected: "Change role 'test_role': primary => <omitted>, fallback => model-B",
    },
    {
      change: { role: 'test_role', primaryModel: '', fallbackModel: null },
      expected: "Change role 'test_role': primary => <empty>, fallback => <null>",
    },
    {
      change: {},
      expected: "Change role '<omitted>': primary => <omitted>, fallback => <omitted>",
    },
    {
      change: {
        role: 'test_role',
        primaryModel: 'model-A',
        fallbackModel: 'model-B',
        suggestion: 'Reduce retry cost',
      },
      expected:
        "Change role 'test_role': primary => model-A, fallback => model-B\n\nAdvisory: Reduce retry cost",
    },
  ])('returns a readable, read-only preview: $expected', async ({ change, expected }) => {
    const proposal = Object.freeze({
      id: 'routing-proposal',
      kind: 'model_role' as const,
      title: 'Change routing',
      rationale: 'Synthetic acceptance test',
      change: Object.freeze(change),
      evidenceIds: ['synthetic-evidence'],
      createdAt: new Date('2026-09-22T00:00:00Z'),
    });
    const before = JSON.stringify(proposal);
    const repository: WorkspaceImprovementRepository = {
      kind: 'workspace-improvement-repository',
      listOpen: vi.fn(async () => [proposal]),
    };

    const result = await listMobileWorkspaceImprovements(repository, 'owner');

    expect(result[0]?.suggestion).toBe(expected);
    expect(repository.listOpen).toHaveBeenCalledExactlyOnceWith('owner');
    expect(JSON.stringify(proposal)).toBe(before);
  });
});
