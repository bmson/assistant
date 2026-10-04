import type { RepairIssue } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { createGitHubRepairWorker } from './repair-github.js';

const issue: RepairIssue = {
  id: '00000000-0000-4000-a000-000000000001',
  agentId: 'owner',
  fingerprint: 'x',
  version: 0,
  status: 'fixing',
  createdAt: new Date(),
  updatedAt: new Date(),
  data: {
    source: 'feedback',
    title: 'PRIVATE TITLE',
    summary: 'PRIVATE OWNER FEEDBACK',
    diagnosis: 'Synthetic reminder case',
    targetPaths: ['packages/core/src/chat.ts'],
    reproduction: 'Create a fake reminder',
    acceptance: 'Deliver once',
    history: [],
  },
};
function worker(fetch: typeof globalThis.fetch) {
  return createGitHubRepairWorker({
    token: 'private-token',
    repo: 'owner/repo',
    workflow: 'self-repair.yml',
    ref: 'main',
    deploymentUrl: 'https://assistant.example',
    fetch,
  });
}
it.each([
  ['success', 'No code change: '],
  ['success', 'No confirmed defect: '],
  ['failure', 'No code change: '],
])('distinguishes a no-defect investigation from a failed run (%s)', async (conclusion, prefix) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({
        workflow_runs: [
          { id: 10, display_title: `self-repair:${issue.id}`, status: 'completed', conclusion },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        jobs: [
          {
            name: 'code',
            steps: [
              {
                name: `${prefix}Synthetic checks passed; no code defect found.`,
                conclusion: 'success',
              },
            ],
          },
        ],
      }),
    );
  const observed = await worker(fetch).inspect(issue);
  expect(observed?.status).toBe(conclusion === 'success' ? 'blocked' : 'failed');
  expect(observed?.patch.runUrl).toContain('/actions/runs/10');
  expect(observed?.patch.lastError).toContain(
    conclusion === 'success' ? 'Synthetic checks passed' : 'Coding run finished (failure)',
  );
});
it('dispatches a technical brief without exporting owner feedback or source audit', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ private: true }))
    .mockResolvedValueOnce(Response.json({ default_branch: 'main' }))
    .mockResolvedValueOnce(Response.json({ sha: 'a'.repeat(40) }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await worker(fetch).dispatch({ ...issue, data: { ...issue.data, category: 'feature' } });
  const [url, init] = fetch.mock.calls[3] ?? [];
  expect(url).toContain('/actions/workflows/self-repair.yml/dispatches');
  expect(init.body).not.toContain('PRIVATE');
  expect(JSON.parse(init.body).inputs.repair_id).toBe(issue.id);
  expect(JSON.parse(JSON.parse(init.body).inputs.brief).kind).toBe('feature');
});
it('refuses diagnostic export to a public repository', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ private: false }));
  await expect(worker(fetch).dispatch(issue)).rejects.toThrow('private repository');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reads exact PR merge state and never merges automatically', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        {
          number: 1,
          head: { ref: `codex/self-repair-${issue.id}`, repo: { full_name: 'owner/repo' } },
        },
      ]),
    )
    .mockResolvedValueOnce(
      Response.json({
        number: 1,
        state: 'closed',
        merged_at: '2026-09-30',
        merge_commit_sha: 'a'.repeat(40),
      }),
    );
  expect(await worker(fetch).inspect(issue)).toMatchObject({
    status: 'merged',
    patch: { mergeSha: 'a'.repeat(40) },
  });
  expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});

it('ignores an earlier attempt PR even when the legacy issue branch matches', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        {
          number: 1,
          created_at: '2026-09-01T00:00:00Z',
          head: { ref: `codex/self-repair-${issue.id}`, repo: { full_name: 'owner/repo' } },
        },
      ]),
    )
    .mockResolvedValueOnce(
      Response.json({
        workflow_runs: [
          {
            id: 20,
            display_title: `self-repair:${issue.id}`,
            status: 'in_progress',
            created_at: '2026-10-03T00:00:01Z',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ jobs: [{ name: 'code', status: 'in_progress' }] }));
  const observed = await worker(fetch).inspect({
    ...issue,
    data: { ...issue.data, dispatchedAt: '2026-10-03T00:00:00.123Z' },
  });
  expect(observed).toMatchObject({ status: 'fixing', patch: { runId: 20 } });
  expect(observed?.patch.mergeSha).toBeUndefined();
  expect(observed?.patch.prNumber).toBeUndefined();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/pulls/1'))).toBe(false);
});

it('accepts a current PR created in the dispatch second despite GitHub timestamp precision', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        {
          number: 2,
          created_at: '2026-10-03T00:00:00Z',
          head: { ref: `codex/self-repair-${issue.id}`, repo: { full_name: 'owner/repo' } },
        },
      ]),
    )
    .mockResolvedValueOnce(
      Response.json({ number: 2, state: 'open', merged_at: null, merge_commit_sha: null }),
    );
  expect(
    await worker(fetch).inspect({
      ...issue,
      data: { ...issue.data, dispatchedAt: '2026-10-03T00:00:00.123Z' },
    }),
  ).toMatchObject({ status: 'pr_open', patch: { prNumber: 2 } });
});
it('waits for successful health and verifies that deployment includes the merged commit', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sha: 'b'.repeat(40) }))
    .mockResolvedValueOnce(Response.json({ status: 'behind' }));
  expect(await worker(fetch).deployed('a'.repeat(40))).toBe(false);
  fetch
    .mockResolvedValueOnce(Response.json({ sha: 'b'.repeat(40) }))
    .mockResolvedValueOnce(Response.json({ status: 'ahead' }));
  expect(await worker(fetch).deployed('a'.repeat(40))).toBe(true);
});
it('tracks verify jobs as testing rather than claiming a PR exists', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({
        workflow_runs: [
          { id: 10, display_title: `self-repair:${issue.id}`, status: 'in_progress' },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ jobs: [{ name: 'verify', status: 'in_progress' }] }));
  expect(await worker(fetch).inspect(issue)).toMatchObject({ status: 'testing' });
});

it('sends diagnostics and run queries only to the private worker while PRs and deployment stay on source', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ private: true }))
    .mockResolvedValueOnce(Response.json({ default_branch: 'main' }))
    .mockResolvedValueOnce(Response.json({ sha: 'a'.repeat(40) }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const split = createGitHubRepairWorker({
    token: 'token',
    repo: 'owner/public',
    workerRepo: 'owner/private-worker',
    workflow: 'self-repair.yml',
    ref: 'main',
    fetch,
  });
  await split.dispatch(issue);
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/owner/private-worker');
  expect(fetch.mock.calls[1]?.[0]).toBe('https://api.github.com/repos/owner/public');
  const dispatch = fetch.mock.calls[3];
  expect(dispatch?.[0]).toContain('owner/private-worker/actions/workflows');
  expect(JSON.parse(dispatch?.[1].body).inputs.source_sha).toBe('a'.repeat(40));
  fetch.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(
    Response.json({
      workflow_runs: [{ id: 10, display_title: `self-repair:${issue.id}`, status: 'queued' }],
    }),
  );
  const observed = await split.inspect(issue);
  expect(fetch.mock.calls[4]?.[0]).toContain('owner/public/pulls');
  expect(fetch.mock.calls[5]?.[0]).toContain('owner/private-worker/actions');
  expect(observed?.patch.runUrl).toBe('https://github.com/owner/private-worker/actions/runs/10');
});
