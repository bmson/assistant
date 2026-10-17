import { Buffer } from 'node:buffer';
import type { RepairIssue } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { repairBranch } from './repair-github.js';
import { createHostedRepairWorker } from './repair-hosted.js';

const source = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const stamp = '2026-10-01T20:00:00.000Z';
const issue: RepairIssue = {
  id: '00000000-0000-4000-a000-000000000001',
  agentId: 'owner',
  fingerprint: 'x',
  version: 2,
  status: 'fixing',
  createdAt: new Date(stamp),
  updatedAt: new Date(stamp),
  data: {
    source: 'feedback',
    title: 'PRIVATE OWNER TITLE',
    summary: 'PRIVATE CALENDAR CONTENT',
    category: 'feature',
    diagnosis: 'Add a synthetic interaction',
    reproduction: 'Open a fake proposal',
    acceptance: 'Create an owned report',
    targetPaths: [],
    history: [],
    dispatchedAt: stamp,
    workerProvider: 'openai_hosted',
    hostedSessionId: 'sess_test',
    hostedTurnId: 'turn_test',
    hostedSourceSha: source,
  },
};
function harness() {
  const state = {
    now: '2026-10-01T20:05:00Z',
    turn: 'completed',
    session: 'idle',
    pr: false,
    ready: false,
    changedHeadOnRefresh: false,
    checks: false,
    failedCheck: false,
    failedDuplicate: false,
    oversizedDiff: false,
    deleteConflict: false,
    downloadFailure: false,
    wrongTurn: false,
    invalidLegacyCredential: false,
    result: {
      baseSha: source,
      reproduced: true,
      regressionTest: 'apps/web/lib/example.test.ts',
      changes: [
        {
          path: 'apps/web/lib/example.test.ts',
          content: Buffer.from('test("synthetic", () => {});').toString('base64'),
          mode: '100644',
        },
      ],
    },
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const pr = () => ({
    number: 123,
    node_id: 'PR_test',
    state: 'open',
    draft: !state.ready,
    merged_at: null,
    merge_commit_sha: null,
    head: {
      ref: repairBranch(issue, 'openai_hosted'),
      sha: commit,
      repo: { full_name: 'owner/repo' },
    },
  });
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (
      state.invalidLegacyCredential &&
      u.startsWith('https://api.github.com/') &&
      new Headers(init?.headers).get('authorization') === 'Bearer read-token'
    )
      return new Response(null, { status: 401 });
    if (u === 'https://assistant.example/api/health') return Response.json({ sha: source });
    if (u.endsWith(`/compare/${source}...${source}`)) return Response.json({ status: 'identical' });
    if (u === 'https://api.github.com/repos/owner/repo')
      return Response.json({ private: false, default_branch: 'main' });
    if (u.endsWith('/commits/main')) return Response.json({ sha: source });
    if (u.endsWith('/sessions') && init?.method === 'POST')
      return Response.json({ id: 'sess_test' });
    if (u.includes('/sessions?'))
      return Response.json({
        has_more: false,
        data: [
          {
            id: 'sess_test',
            metadata: { repair_attempt: `${issue.id}:${stamp}`, source_repo: 'owner/repo' },
          },
        ],
      });
    if (u.endsWith('/sessions/sess_test') && init?.method === 'DELETE') {
      if (state.deleteConflict) {
        state.deleteConflict = false;
        return new Response(null, { status: 409 });
      }
      return Response.json({ deleted: true });
    }
    if (u.endsWith('/events')) return Response.json({});
    if (u.endsWith('/sessions/sess_test'))
      return Response.json({
        status: state.session,
        error: null,
        required_actions: [],
        metadata: {
          repair_attempt: `${issue.id}:${stamp}`,
          source_repo: 'owner/repo',
          source_sha: source,
          base_branch: 'main',
        },
      });
    if (u.includes('/turns?'))
      return Response.json({
        has_more: false,
        data: [{ id: 'turn_test', subagent_id: null, status: state.turn }],
      });
    if (u.includes('/artifacts?'))
      return Response.json({
        has_more: false,
        data: [
          {
            id: 'artifact_test',
            turn_id: state.wrongTurn ? 'other_turn' : 'turn_test',
            path: '/workspace/outputs/repair.json',
            size_bytes: JSON.stringify(state.result).length,
          },
        ],
      });
    if (u.endsWith('/artifacts/artifact_test/content'))
      return state.downloadFailure
        ? new Response(null, { status: 503 })
        : Response.json(state.result);
    if (u.includes('/files?'))
      return Response.json(state.result.changes.map((c) => ({ filename: c.path })));
    if (u.includes('/pulls?')) return Response.json(state.pr ? [pr()] : []);
    if (u.endsWith('/pulls/123')) {
      const latest = pr();
      if (state.changedHeadOnRefresh) latest.head.sha = 'f'.repeat(40);
      return Response.json(latest);
    }
    if (u.includes('/check-runs?'))
      return Response.json({
        total_count: 5,
        check_runs: [
          'checks',
          'verify',
          'firestore',
          'build-smoke',
          'Build and test the iOS app',
          ...(state.failedDuplicate ? ['verify'] : []),
        ].map((name, i) => ({
          name,
          head_sha: commit,
          status: state.checks ? 'completed' : 'in_progress',
          conclusion: state.checks
            ? (state.failedCheck && i === 1) || (state.failedDuplicate && i === 5)
              ? 'failure'
              : i === 4
                ? 'skipped'
                : 'success'
            : null,
          app: { slug: 'github-actions' },
        })),
      });
    if (u.includes('/compare/'))
      return Response.json({
        files: state.result.changes.map((c) => ({
          filename: c.path,
          patch: state.oversizedDiff ? 'x'.repeat(100001) : '@@ -1 +1 @@\n-old\n+new',
        })),
      });
    if (u.includes('/git/commits/') && init?.method === 'GET')
      return Response.json({ tree: { sha: 'c'.repeat(40) } });
    if (u.endsWith('/git/blobs')) return Response.json({ sha: 'd'.repeat(40) });
    if (u.endsWith('/git/trees')) return Response.json({ sha: 'e'.repeat(40) });
    if (u.endsWith('/git/commits')) return Response.json({ sha: commit });
    if (u.includes('/git/ref/heads/')) return new Response(null, { status: 404 });
    if (u.endsWith('/git/refs')) return Response.json({});
    if (u.endsWith('/pulls') && init?.method === 'POST') {
      state.pr = true;
      return Response.json(pr());
    }
    if (u.endsWith('/graphql')) {
      state.ready = true;
      return Response.json({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      });
    }
    throw new Error(`Unexpected test endpoint: ${u}`);
  });
  const reviewPatch = vi.fn(
    async () =>
      ({
        approved: true,
        modelId: 'independent-model',
        summary: 'No actionable defects found.',
      }) as { approved: boolean; modelId: string; summary: string } | null,
  );
  const worker = createHostedRepairWorker({
    apiKey: 'coding-key',
    publisherToken: 'publish-token',
    repo: 'owner/repo',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    allowExecutor: false,
    deploymentUrl: 'https://assistant.example',
    now: () => new Date(state.now),
    fetch: fetch as typeof globalThis.fetch,
    reviewPatch,
  });
  return { worker, calls, state, reviewPatch };
}
it('keeps the draft when an independent reviewer rejects the exact commit', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.reviewPatch.mockResolvedValue({
    approved: false,
    modelId: 'reviewer',
    summary: 'Missing boundary coverage.',
  });
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { hostedReview: { approved: false, commitSha: commit } },
  });
  expect(h.reviewPatch).toHaveBeenCalledWith({ commitSha: commit, files: expect.any(Array) });
  expect(h.state.ready).toBe(false);
});
it('waits without promoting when independent review is unavailable', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.reviewPatch.mockResolvedValue(null);
  expect(await h.worker.inspect(issue)).toMatchObject({ status: 'testing' });
  expect(h.state.ready).toBe(false);
});
it('reuses a durable review only for the same commit', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  const reviewed = {
    ...issue,
    data: {
      ...issue.data,
      hostedReview: {
        commitSha: commit,
        approved: true,
        modelId: 'reviewer',
        summary: 'Reviewed',
        reviewedAt: stamp,
      },
    },
  };
  expect(await h.worker.inspect(reviewed)).toMatchObject({ status: 'pr_open' });
  expect(h.reviewPatch).not.toHaveBeenCalled();
});
it('does not accept a review of a different commit', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.reviewPatch.mockResolvedValue(null);
  const reviewed = {
    ...issue,
    data: {
      ...issue.data,
      hostedReview: {
        commitSha: source,
        approved: true,
        modelId: 'reviewer',
        summary: 'Old review',
        reviewedAt: stamp,
      },
    },
  };
  expect(await h.worker.inspect(reviewed)).toMatchObject({ status: 'testing' });
  expect(h.reviewPatch).toHaveBeenCalledOnce();
  expect(h.state.ready).toBe(false);
});
it('does not promote a PR whose head changes while independent review is running', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.state.changedHeadOnRefresh = true;
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { lastError: expect.stringContaining('changed during independent review') },
  });
  expect(h.state.ready).toBe(false);
});
it('starts a detached hosted turn pinned to public source, without credentials or owner data in its sandbox', async () => {
  const h = harness();
  expect(await h.worker.dispatch(issue)).toMatchObject({
    hostedSessionId: 'sess_test',
    hostedSourceSha: source,
  });
  const create = h.calls.find((c) => c.url.endsWith('/sessions'));
  const body = JSON.parse(String(create?.init?.body));
  expect(body.agent).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'medium' } });
  expect(body.environment.type).toBe('openai_hosted');
  expect(body.environment.env).toBeUndefined();
  expect(body.environment.setup_commands[0].command).toContain(source);
  expect(body.metadata.repair_attempt).toBe(`${issue.id}:${stamp}`);
  expect(body.stream).toBe(false);
  for (const privateText of [
    'PRIVATE OWNER',
    'PRIVATE CALENDAR',
    'coding-key',
    'read-token',
    'publish-token',
  ])
    expect(String(create?.init?.body)).not.toContain(privateText);
  expect(h.calls.some((c) => c.url.includes('/actions/'))).toBe(false);
});
it('dispatches, reconciles and checks deployment when the legacy GitHub credential is invalid', async () => {
  const h = harness();
  h.state.invalidLegacyCredential = true;
  expect(await h.worker.dispatch(issue)).toMatchObject({ hostedSessionId: 'sess_test' });
  expect(await h.worker.inspect(issue)).toMatchObject({ status: 'testing' });
  expect(await h.worker.deployed(source)).toBe(true);
  const github = h.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
  expect(github.length).toBeGreaterThan(0);
  expect(
    github.every(
      (c) => new Headers(c.init?.headers).get('authorization') === 'Bearer publish-token',
    ),
  ).toBe(true);
});
it('does not mistake an idle session for a successful turn', async () => {
  const h = harness();
  h.state.turn = 'in_progress';
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'fixing',
    patch: { hostedTurnId: 'turn_test' },
  });
  expect(h.calls.some((c) => c.url.endsWith('/git/blobs'))).toBe(false);
});
it('reconciles a lost creation response by repair-attempt metadata without starting another turn', async () => {
  const h = harness();
  h.state.turn = 'in_progress';
  const uncertain = {
    ...issue,
    data: { ...issue.data, hostedSessionId: undefined, hostedTurnId: undefined },
  };
  expect(await h.worker.inspect(uncertain)).toMatchObject({
    status: 'fixing',
    patch: { hostedSessionId: 'sess_test' },
  });
  expect(h.calls.some((c) => c.url.endsWith('/sessions') && c.init?.method === 'POST')).toBe(false);
});
it('publishes a draft from validated file blobs, cleans up, then waits for independent CI before notifying readiness', async () => {
  const h = harness();
  const result = await h.worker.inspect(issue);
  expect(result).toMatchObject({
    status: 'testing',
    patch: {
      prUrl: 'https://github.com/owner/repo/pull/123',
      hostedCommitSha: commit,
      hostedCleanupPending: false,
    },
  });
  const create = h.calls.find((c) => c.url.endsWith('/pulls') && c.init?.method === 'POST');
  expect(JSON.parse(String(create?.init?.body)).draft).toBe(true);
  expect(String(create?.init?.body)).not.toContain('PRIVATE');
  for (const c of h.calls.filter(
    (c) => c.init?.method === 'POST' && c.url.startsWith('https://api.github.com'),
  ))
    expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer publish-token');
  const published = { ...issue, data: { ...issue.data, ...result?.patch } };
  expect(await h.worker.inspect(published)).toMatchObject({ status: 'testing' });
  h.state.checks = true;
  expect(await h.worker.inspect(published)).toMatchObject({
    status: 'pr_open',
    patch: { lastError: '' },
  });
  expect(h.state.ready).toBe(true);
});
it('keeps a failed CI draft out of the ready queue', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.state.failedCheck = true;
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { lastError: expect.stringContaining('verify') },
  });
  expect(h.state.ready).toBe(false);
});
it.each([
  'packages/config/src/index.ts',
  '../outside.ts',
  'apps/web/.env',
  'packages/core/src/workflow/repair-hosted.ts',
])('rejects protected or escaping path %s before any write to GitHub', async (path) => {
  const h = harness();
  h.state.result.changes.push({ path, content: 'eA==', mode: '100644' });
  expect(await h.worker.inspect(issue)).toMatchObject({ status: 'failed' });
  expect(h.calls.some((c) => c.url.endsWith('/git/blobs'))).toBe(false);
});
it('rejects a result artifact from another turn', async () => {
  const h = harness();
  h.state.wrongTurn = true;
  expect(await h.worker.inspect(issue)).toMatchObject({ status: 'failed' });
  expect(h.calls.some((c) => c.url.endsWith('/git/blobs'))).toBe(false);
});
it('cancels overdue work and retries deletion after an active-session conflict', async () => {
  const h = harness();
  h.state.turn = 'in_progress';
  h.state.deleteConflict = true;
  h.state.now = '2026-10-01T21:00:00Z';
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { hostedCleanupPending: false, lastError: expect.stringContaining('20-minute') },
  });
  expect(
    h.calls.some(
      (c) =>
        c.url.endsWith('/events') && String(c.init?.body).includes('agent.session.input.cancel'),
    ),
  ).toBe(true);
});
it('retains a completed artifact after a transient download outage rather than losing the repair', async () => {
  const h = harness();
  h.state.downloadFailure = true;
  // Explicit result download errors must also remain retryable.
  await expect(h.worker.inspect(issue)).rejects.toThrow('Hosted result download failed (503)');
  expect(h.calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
});

it('does not accept skipped iOS verification when the repair changes iPhone code', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.state.result.changes.push({
    path: 'apps/ios/Assistant/Views/WorkspaceView.swift',
    content: 'eA==',
    mode: '100644',
  });
  expect(await h.worker.inspect(issue)).toMatchObject({ status: 'testing' });
  expect(h.state.ready).toBe(false);
});
it('uses a fresh branch for each retry without overwriting an earlier draft', () => {
  const retry = { ...issue, data: { ...issue.data, dispatchedAt: '2026-10-02T20:00:00Z' } };
  expect(repairBranch(retry, 'openai_hosted')).not.toBe(repairBranch(issue, 'openai_hosted'));
  expect(repairBranch(issue)).toBe(`codex/self-repair-${issue.id}`);
});
it('rejects oversized source contents and missing regression tests before publication', async () => {
  for (const kind of ['oversized', 'missing-test']) {
    const h = harness();
    if (kind === 'oversized') {
      const change = h.state.result.changes[0];
      if (!change) throw new Error('Missing changed test fixture');
      change.content = Buffer.alloc(100 * 1024 + 1, 120).toString('base64');
    } else h.state.result.regressionTest = 'apps/web/lib/missing.test.ts';
    expect(await h.worker.inspect(issue)).toMatchObject({ status: 'failed' });
    expect(h.calls.some((c) => c.url.endsWith('/git/blobs'))).toBe(false);
  }
});
it('surfaces a failed turn and releases its sandbox without creating a PR', async () => {
  const h = harness();
  h.state.turn = 'failed';
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { hostedCleanupPending: false },
  });
  expect(h.calls.some((c) => c.url.endsWith('/git/blobs'))).toBe(false);
});

it('requires every matching CI run to pass when push and PR checks share a name', async () => {
  const h = harness();
  h.state.pr = true;
  h.state.checks = true;
  h.state.failedDuplicate = true;
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { lastError: expect.stringContaining('verify') },
  });
  expect(h.state.ready).toBe(false);
});

it('bounds the authoritative patch before creating a branch, including large deletions', async () => {
  const h = harness();
  h.state.oversizedDiff = true;
  expect(await h.worker.inspect(issue)).toMatchObject({
    status: 'failed',
    patch: { lastError: expect.stringContaining('100 KB patch fence') },
  });
  expect(h.calls.some((c) => c.url.endsWith('/git/refs'))).toBe(false);
});
