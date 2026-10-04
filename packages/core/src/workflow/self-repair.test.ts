import { randomUUID } from 'node:crypto';
import {
  type RepairIssue,
  repairTransition,
  type SelfRepairRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { RepairDispatchRejected } from './repair-github.js';
import {
  isRepairFeedback,
  type RepairCycleDeps,
  repairFingerprint,
  repairPathBlocked,
  runRepairCycle,
} from './self-repair.js';

const now = new Date('2026-09-30T00:00:00Z');

describe('owner correction detection', () => {
  it.each([
    "That's wrong.",
    'No, that’s incorrect.',
    "That didn't save.",
    'You made that up.',
    "I don't see the change you said you made.",
    'Please fix this bug.',
    'Could you fix the issue?',
    'Report a bug in reminders.',
    'Thanks for checking. That did not work.',
    'Why did not the reminder send?',
  ])('records direct owner feedback: %s', (text) => expect(isRepairFeedback(text)).toBe(true));
  it.each([
    'Explain how to report a bug.',
    'How should I say "That\'s wrong" politely?',
    'My coworker wrote "That did not work" in an email.',
    '> That did not work\nSummarize this feedback.',
    'Example:\n```text\nReport a bug\n```',
    'Discuss when an assistant should fix this bug automatically.',
    'You were right.',
    'That saved correctly.',
    "That's wrong, don't report it.",
    "That didn't save; please don't open an issue.",
  ])('does not treat quoted examples or discussion as authorization: %s', (text) =>
    expect(isRepairFeedback(text)).toBe(false),
  );
});
function fixture(status: RepairIssue['status'] = 'reported'): RepairIssue {
  return {
    id: randomUUID(),
    agentId: 'owner',
    fingerprint: 'key',
    status,
    version: 0,
    data: {
      source: 'feedback',
      title: 'Reminder was not delivered',
      summary: 'The scheduled reminder never arrived',
      history: [{ status, at: now.toISOString(), detail: '' }],
    },
    createdAt: now,
    updatedAt: now,
  };
}
function setup(issue = fixture()) {
  const rows = new Map([[issue.id, issue]]);
  const repository: SelfRepairRepository = {
    report: vi.fn(async () => issue),
    list: vi.fn(async () => [...rows.values()]),
    failures: vi.fn(async () => []),
    claim: vi.fn(async () => {
      const row = rows.get(issue.id);
      if (row?.status !== 'reported') return null;
      const next = repairTransition(row, 'investigating', {}, now);
      rows.set(row.id, next);
      return next;
    }),
    update: vi.fn(async (row, status, patch, at) => {
      if (rows.get(row.id)?.version !== row.version) return null;
      const next = repairTransition(row, status, patch, at);
      rows.set(row.id, next);
      return next;
    }),
  };
  const object = vi.fn(async (_role?: unknown, _options?: { prompt: string }) => ({
    ok: true,
    object: {
      category: 'bug',
      diagnosis: 'A completion guard loses the reminder',
      targetPaths: ['packages/core/src/chat.ts'],
      reproduction: 'Create a synthetic one-time reminder and advance the clock',
      acceptance: 'Deliver exactly once',
    },
  }));
  const deps: RepairCycleDeps = {
    repository,
    audit: { task: vi.fn(async () => null), read: vi.fn(async () => []) },
    router: {
      object,
      route: vi.fn(async (_role: unknown, opts?: { forceFallback?: boolean }) => ({
        ok: true,
        modelId: opts?.forceFallback ? 'test/fallback' : 'test/primary',
      })),
    } as unknown as ModelRouter,
    worker: {
      dispatch: vi.fn(async () => {}),
      inspect: vi.fn(async () => null),
      deployed: vi.fn(async () => false),
    },
    enabled: true,
    allowExecutor: false,
    dailyLimit: 2,
    notify: vi.fn(async () => {}),
  };
  return { deps, rows, issue, object };
}
describe('issue-to-PR flow', () => {
  it('dispatches a requested feature with a missing-behavior acceptance test', async () => {
    const { deps, object, rows, issue } = setup();
    object.mockResolvedValueOnce({
      ok: true,
      object: {
        category: 'feature',
        diagnosis: 'Review cards lack the requested conversion interaction',
        targetPaths: ['apps/web/app/improvements/proposal-card.tsx'],
        reproduction:
          'Render a synthetic advisory card and verify the conversion interaction is absent',
        acceptance:
          'Owner can convert the advisory into a report using existing authenticated APIs',
      },
    } as never);
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('fixing');
    expect(deps.worker?.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ category: 'feature' }) }),
    );
  });
  it('surfaces a definite dispatch rejection immediately without automatic retries', async () => {
    const { deps, rows, issue } = setup();
    if (!deps.worker) throw new Error('Missing worker');
    vi.mocked(deps.worker.dispatch).mockRejectedValueOnce(
      new RepairDispatchRejected('GitHub rejected credentials'),
    );
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('failed');
    expect(rows.get(issue.id)?.data.lastError).toBe('GitHub rejected credentials');
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(rows.get(issue.id)?.data.notifiedStatus).toBe('failed');
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(deps.worker.dispatch).toHaveBeenCalledTimes(1);
  });
  it('queues a new investigation when the same symptom recurs after deployment', async () => {
    const issue = fixture('monitoring');
    issue.data.symptomKey = 'reminder-error';
    issue.data.monitoringAt = new Date(now.getTime() - 60000).toISOString();
    issue.data.mergeSha = 'a'.repeat(40);
    const { deps, rows } = setup(issue);
    vi.mocked(deps.repository.failures).mockResolvedValueOnce([
      {
        taskId: 'failed-task',
        title: 'Reminder failed',
        symptomKey: 'reminder-error',
        observedAt: now.toISOString(),
      },
    ]);
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('failed');
    expect(deps.repository.report).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({
        parentIssueId: issue.id,
        fingerprint: repairFingerprint('failure', `reminder-error:after:${issue.data.mergeSha}`),
      }),
    );
  });
  it('captures corrections and why-it-failed questions without treating unrelated prose as bugs', () => {
    for (const text of [
      'You were wrong',
      "that didn't work",
      "Why didn't it work?",
      'Report a bug',
    ])
      expect(isRepairFeedback(text)).toBe(true);
    for (const text of ['The weather is nice', 'I was wrong about the date', 'Fix dinner at six'])
      expect(isRepairFeedback(text)).toBe(false);
    expect(repairFingerprint('failure', 'one')).toBe(repairFingerprint('failure', 'one'));
  });
  it('claims before dispatch and sends actionable code investigations to the worker', async () => {
    const { deps, rows, issue } = setup();
    expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(1);
    expect(rows.get(issue.id)?.status).toBe('fixing');
    expect(deps.worker?.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'fixing' }),
    );
  });
  it.each(['provider', 'configuration'])(
    'keeps %s diagnoses out of the coding runner',
    async (category) => {
      const { deps, object, rows, issue } = setup();
      object.mockResolvedValueOnce({
        ok: true,
        object: {
          category,
          diagnosis: 'Not a code defect',
          targetPaths: [],
          reproduction: '',
          acceptance: '',
        },
      } as never);
      await runRepairCycle(deps, 'owner', 'task', now);
      expect(rows.get(issue.id)?.status).toBe('blocked');
      expect(deps.worker?.dispatch).not.toHaveBeenCalled();
      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(rows.get(issue.id)?.data.notifiedStatus).toBe('blocked');
    },
  );
  it('investigates a capability denial even when preliminary triage labels it a bad answer', async () => {
    const { deps, object, rows, issue } = setup();
    object.mockResolvedValueOnce({
      ok: true,
      object: {
        category: 'answer',
        diagnosis:
          'Voice denied calendar access despite enabled capabilities; routing needs inspection',
        targetPaths: [],
        reproduction: 'Ask a synthetic voice session to list test calendar events',
        acceptance: 'Expose installed calendar tools and report the test events',
      },
    } as never);
    expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(1);
    expect(rows.get(issue.id)?.status).toBe('fixing');
    expect(deps.worker?.dispatch).toHaveBeenCalledOnce();
    expect(deps.notify).not.toHaveBeenCalled();
  });
  it.each(['bug', 'feature', 'unknown', 'answer'])(
    'requires an actionable brief for %s investigation',
    async (category) => {
      const { deps, object, rows, issue } = setup();
      object.mockResolvedValue({
        ok: true,
        object: {
          category,
          diagnosis: 'Incomplete evidence',
          targetPaths: [],
          reproduction: '',
          acceptance: '',
        },
      } as never);
      await runRepairCycle(deps, 'owner', 'task', now);
      expect(rows.get(issue.id)?.status).toBe('blocked');
      expect(deps.worker?.dispatch).not.toHaveBeenCalled();
      expect(rows.get(issue.id)?.data.lastError).toContain('More details');
    },
  );
  it('lets the repository worker investigate an actionable unknown cause without guessed paths', async () => {
    const { deps, object, rows, issue } = setup();
    deps.diagnostics = {
      persistenceDriver: 'firestore',
      modules: ['calendar'],
      calendarReaderAvailable: true,
    };
    object.mockResolvedValueOnce({
      ok: true,
      object: {
        category: 'unknown',
        diagnosis: 'Calendar capability is unexpectedly absent in voice',
        targetPaths: [],
        reproduction: 'Start a synthetic voice session and request a test event',
        acceptance: 'Voice should expose installed calendar capabilities',
      },
    } as never);
    expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(1);
    expect(rows.get(issue.id)?.status).toBe('fixing');
    expect(deps.worker?.dispatch).toHaveBeenCalledOnce();
    const prompt = JSON.parse(object.mock.calls[0]?.[1]?.prompt ?? '{}');
    expect(prompt.runtime).toEqual(deps.diagnostics);
  });
  it.each([410, 429])(
    'uses one distinct configured fallback when triage provider returns %s',
    async (statusCode) => {
      const { deps, object, rows, issue } = setup();
      const terminal = Object.assign(new Error('Upstream rate limit'), {
        name: 'AI_APICallError',
        statusCode,
      });
      object.mockRejectedValueOnce(
        Object.assign(new Error('Retry exhausted'), { name: 'AI_RetryError', lastError: terminal }),
      );
      expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(1);
      expect(object).toHaveBeenCalledTimes(2);
      expect(object.mock.calls[1]?.[1]).toMatchObject({ forceFallback: true });
      expect(rows.get(issue.id)?.status).toBe('fixing');
    },
  );
  it.each(['placeholder', 'invented paths', 'wildcard paths'])(
    'uses a distinct fallback for unusable %s output',
    async (kind) => {
      const { deps, object, rows, issue } = setup();
      object.mockResolvedValueOnce({
        ok: true,
        object: {
          category: 'bug',
          diagnosis: kind === 'placeholder' ? '...' : 'Review potential issues',
          targetPaths:
            kind === 'invented paths'
              ? ['improvement/page', 'auto-solve/trigger']
              : kind === 'wildcard paths'
                ? ['apps/**/components/**/Card*', 'packages/**/ui/**/card*']
                : [],
          reproduction: kind === 'placeholder' ? '' : 'Open the review page',
          acceptance: 'Start the investigation',
        },
      } as never);
      expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(1);
      expect(object).toHaveBeenCalledTimes(2);
      expect(object.mock.calls[1]?.[1]).toMatchObject({ forceFallback: true });
      expect(rows.get(issue.id)?.status).toBe('fixing');
    },
  );
  it('bounds primary triage and uses a fresh deadline for timeout fallback', async () => {
    const { deps, object } = setup();
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    object.mockRejectedValueOnce(
      Object.assign(new Error('Deadline exceeded'), { name: 'TimeoutError' }),
    );
    try {
      expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(1);
      expect(deadline.mock.calls).toEqual([[60000], [60000]]);
    } finally {
      deadline.mockRestore();
    }
  });
  it('keeps the protected-path gate after retrying wildcard hints', async () => {
    const { deps, object, rows, issue } = setup();
    const brief = {
      category: 'bug',
      diagnosis: 'Review a possible UI defect',
      reproduction: 'Open a synthetic card',
      acceptance: 'Text should be left aligned',
    };
    object
      .mockResolvedValueOnce({
        ok: true,
        object: { ...brief, targetPaths: ['apps/**/components/**/Card*'] },
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        object: { ...brief, targetPaths: ['packages/tools/src/dispatcher.ts'] },
      } as never);
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(object).toHaveBeenCalledTimes(2);
    expect(rows.get(issue.id)?.status).toBe('blocked');
    expect(deps.worker?.dispatch).not.toHaveBeenCalled();
  });
  it('does not repeat triage when the fallback is the same model', async () => {
    const { deps, object, rows, issue } = setup();
    vi.mocked(deps.router.route).mockResolvedValue({ ok: true, modelId: 'same' } as never);
    object.mockRejectedValueOnce(
      Object.assign(new Error('Unavailable'), { name: 'AI_APICallError', statusCode: 503 }),
    );
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(object).toHaveBeenCalledOnce();
    expect(rows.get(issue.id)?.status).toBe('failed');
  });
  it('does not use a provider fallback for invalid credentials', async () => {
    const { deps, object } = setup();
    object.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials'), { name: 'AI_APICallError', statusCode: 401 }),
    );
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(object).toHaveBeenCalledOnce();
    expect(deps.worker?.dispatch).not.toHaveBeenCalled();
  });
  it('retries failed notifications next tick without rerunning the investigation', async () => {
    const { deps, object, rows, issue } = setup();
    object.mockResolvedValueOnce({
      ok: true,
      object: {
        category: 'provider',
        diagnosis: 'Provider quota exhausted',
        targetPaths: [],
        reproduction: '',
        acceptance: '',
      },
    } as never);
    vi.mocked(deps.notify).mockRejectedValueOnce(new Error('Notification unavailable'));
    await expect(runRepairCycle(deps, 'owner', 'task', now)).rejects.toThrow(
      'Notification unavailable',
    );
    expect(rows.get(issue.id)?.data.notifiedStatus).toBeUndefined();
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.data.notifiedStatus).toBe('blocked');
    expect(object).toHaveBeenCalledTimes(1);
    expect(deps.worker?.dispatch).not.toHaveBeenCalled();
  });
  it.each(['bug', 'answer'])('rejects protected targets for a %s diagnosis', async (category) => {
    const { deps, object, rows, issue } = setup();
    object.mockResolvedValueOnce({
      ok: true,
      object: {
        category,
        diagnosis: 'Change security',
        targetPaths: ['packages/tools/src/dispatcher.ts'],
        reproduction: 'Synthetic case',
        acceptance: 'Pass',
      },
    } as never);
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('blocked');
    expect(deps.worker?.dispatch).not.toHaveBeenCalled();
  });
  it('does not blindly redispatch after an ambiguous external failure', async () => {
    const { deps, rows, issue } = setup();
    vi.mocked(deps.worker!.dispatch).mockRejectedValueOnce(new Error('Timeout after acceptance'));
    await runRepairCycle(deps, 'owner', 'task', now);
    await runRepairCycle(deps, 'owner', 'task', new Date(now.getTime() + 60000));
    expect(rows.get(issue.id)?.status).toBe('fixing');
    expect(deps.worker?.dispatch).toHaveBeenCalledTimes(1);
  });
  it('reconciles a PR and notifies once per status', async () => {
    const { deps, rows, issue } = setup(fixture('fixing'));
    vi.mocked(deps.worker!.inspect).mockResolvedValue({
      status: 'pr_open',
      patch: { prUrl: 'https://github.com/owner/repo/pull/1', prNumber: 1 },
    });
    await runRepairCycle(deps, 'owner', 'task', now);
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('pr_open');
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
  it('does not equate merge or deployment with a verified fix', async () => {
    const { deps, rows, issue } = setup(fixture('pr_open'));
    vi.mocked(deps.worker!.inspect).mockResolvedValue({
      status: 'merged',
      patch: { mergeSha: 'a'.repeat(40) },
    });
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('merged');
    vi.mocked(deps.worker!.deployed).mockResolvedValue(true);
    await runRepairCycle(deps, 'owner', 'task', now);
    expect(rows.get(issue.id)?.status).toBe('monitoring');
  });
  it('does no provider or storage work when disabled', async () => {
    const { deps } = setup();
    deps.enabled = false;
    expect(await runRepairCycle(deps, 'owner', 'task', now)).toBe(0);
    expect(deps.repository.list).not.toHaveBeenCalled();
  });
  it('fences expired investigations', async () => {
    const { deps, rows, issue } = setup(fixture('investigating'));
    await runRepairCycle(deps, 'owner', 'task', new Date(now.getTime() + 31 * 60000));
    expect(rows.get(issue.id)?.status).toBe('failed');
    expect(deps.worker?.dispatch).not.toHaveBeenCalled();
  });
});
describe('repair patch fence', () => {
  it.each([
    '../../etc/passwd',
    '/tmp/file',
    'apps/web/auth.ts',
    'apps/web/.env.local',
    'packages/core/src/workflow/executor/step-loop.ts',
    'packages/core/src/workflow/self-repair.ts',
    'scripts/test.ts',
    'packages/db/src/schema.ts',
    '.github/workflows/ci.yml',
    'apps/web/package.json',
    'apps/web/app/api/mobile/v1/repairs/[id]/route.ts',
    'packages/tools/src/approval-policy.ts',
    'packages/core/src/credential-store.ts',
    'apps/web/AGENTS.md',
    'apps/web/src/../auth.ts',
    'apps/web/x\\auth.ts',
  ])('blocks %s', (path) => expect(repairPathBlocked(path)).toBe(true));
  it('allows ordinary source and regression tests', () => {
    for (const path of [
      'packages/core/src/chat.ts',
      'packages/core/src/chat.test.ts',
      'apps/ios/Assistant/Views/WorkspaceView.swift',
      'apps/web/app/api/mobile/v1/calendar/[id]/route.ts',
    ])
      expect(repairPathBlocked(path)).toBe(false);
  });
  it('executor opt-in never grants access to executor security or self-repair controls', () => {
    expect(repairPathBlocked('packages/core/src/workflow/executor/step-loop.ts', true)).toBe(false);
    expect(repairPathBlocked('packages/core/src/workflow/executor/tool-context.ts', true)).toBe(
      true,
    );
    expect(repairPathBlocked('packages/core/src/workflow/self-repair.ts', true)).toBe(true);
  });
});

it('persists hosted dispatch identity and cleans up terminal sessions without redispatching', async () => {
  const { deps, rows, issue } = setup();
  if (!deps.worker) throw new Error('Worker fixture missing');
  deps.worker.provider = 'openai_hosted';
  deps.worker.dispatch = vi.fn(async () => ({
    hostedSessionId: 'sess_saved',
    hostedCleanupPending: true,
  }));
  await runRepairCycle(deps, 'owner', undefined, now);
  expect(rows.get(issue.id)?.data).toMatchObject({
    workerProvider: 'openai_hosted',
    hostedSessionId: 'sess_saved',
    hostedCleanupPending: true,
  });
  const saved = rows.get(issue.id);
  if (!saved) throw new Error('Saved hosted fixture missing');
  rows.set(issue.id, repairTransition(saved, 'failed', {}, now));
  deps.worker.cleanup = vi.fn(async () => ({ hostedCleanupPending: false }));
  await runRepairCycle(deps, 'owner', undefined, now);
  expect(rows.get(issue.id)?.data.hostedCleanupPending).toBe(false);
  expect(deps.worker.cleanup).toHaveBeenCalledOnce();
  expect(deps.worker.dispatch).toHaveBeenCalledOnce();
});
