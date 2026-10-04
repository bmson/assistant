import { createHash } from 'node:crypto';
import type { RepairDetails, RepairIssue, RepairStatus } from '@assistant/persistence';
import { z } from 'zod';
export interface RepairWorker {
  provider?: 'github' | 'openai_hosted';
  dispatch(issue: RepairIssue): Promise<void> | Promise<Partial<RepairDetails>>;
  cleanup?(issue: RepairIssue): Promise<Partial<RepairDetails>>;
  inspect(
    issue: RepairIssue,
  ): Promise<{ status: RepairStatus; patch: Partial<RepairDetails> } | null>;
  deployed(mergeSha: string): Promise<boolean>;
}
/** A preflight or explicit API rejection means no coding run was accepted. */
export class RepairDispatchRejected extends Error {}
/** Hosted retries get a fresh branch; a failed draft must never be overwritten or reused. */
export function repairBranch(issue: RepairIssue, provider: RepairWorker['provider'] = 'github') {
  const suffix =
    provider === 'openai_hosted'
      ? `-${createHash('sha256')
          .update(issue.data.dispatchedAt ?? '')
          .digest('hex')
          .slice(0, 8)}`
      : '';
  return `codex/self-repair-${issue.id}${suffix}`;
}
/** Fixed GitHub origin and repository; audit contents cannot choose a network destination. */
export function createGitHubRepairWorker(input: {
  token: string;
  repo: string;
  workerRepo?: string;
  workflow: string;
  ref: string;
  deploymentUrl?: string;
  fetch?: typeof fetch;
}): RepairWorker {
  const workerRepo = input.workerRepo || input.repo;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repo) ||
    !/^[\w.-]+\/[\w.-]+$/.test(workerRepo) ||
    !/^[\w.-]+\.ya?ml$/.test(input.workflow)
  )
    throw new Error('Invalid self-repair repository/workflow');
  const transport = input.fetch ?? fetch;
  async function api(path: string, body?: unknown, repo = input.repo): Promise<unknown> {
    const response = await transport(`https://api.github.com/repos/${repo}${path}`, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const message = `Self-repair GitHub request failed (${response.status})`;
      if ([400, 401, 403, 404, 422].includes(response.status))
        throw new RepairDispatchRejected(message);
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }
  return {
    provider: 'github',
    async dispatch(issue) {
      const repo = z.object({ private: z.boolean() }).parse(await api('', undefined, workerRepo));
      if (repo.private !== true)
        throw new RepairDispatchRejected(
          'Self-repair requires a private repository for diagnostic briefs',
        );
      // No transcript, tool arguments, audit output, owner feedback, or credentials leave the store.
      const brief = {
        kind: issue.data.category === 'feature' ? 'feature' : 'bug',
        diagnosis: issue.data.diagnosis,
        targetPaths: issue.data.targetPaths,
        reproduction: issue.data.reproduction,
        acceptance: issue.data.acceptance,
      };
      const source = z.object({ default_branch: z.string() }).parse(await api(''));
      const commit = z
        .object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) })
        .parse(await api(`/commits/${encodeURIComponent(source.default_branch)}`));
      await api(
        `/actions/workflows/${input.workflow}/dispatches`,
        {
          ref: input.ref,
          inputs: {
            repair_id: issue.id,
            source_sha: commit.sha,
            brief: JSON.stringify(brief),
            allow_executor: String(
              issue.data.targetPaths?.some((path) => path.includes('workflow/executor/')) ?? false,
            ),
          },
        },
        workerRepo,
      );
    },
    async inspect(issue) {
      const branch = `codex/self-repair-${issue.id}`;
      const pulls = z
        .array(
          z.object({
            number: z.number().int().positive(),
            created_at: z.string().optional(),
            head: z.object({
              ref: z.string(),
              repo: z.object({ full_name: z.string() }).nullable(),
            }),
          }),
        )
        .parse(
          await api(
            `/pulls?state=all&head=${encodeURIComponent(`${input.repo.split('/')[0]}:${branch}`)}&per_page=10`,
          ),
        );
      const match = pulls.find(
        (row) =>
          row.head?.ref === branch &&
          row.head?.repo?.full_name === input.repo &&
          // GitHub dates have second precision. A retry must not adopt an old
          // PR from this legacy issue-scoped branch as evidence for new work.
          (!issue.data.dispatchedAt ||
            (row.created_at &&
              Number.isFinite(Date.parse(row.created_at)) &&
              Date.parse(row.created_at) >=
                Math.floor(Date.parse(issue.data.dispatchedAt) / 1000) * 1000)),
      );
      if (match) {
        const pr = z
          .object({
            number: z.number().int().positive(),
            state: z.string(),
            merged_at: z.string().nullable(),
            merge_commit_sha: z.string().nullable(),
          })
          .parse(await api(`/pulls/${match.number}`));
        const patch = {
          prNumber: pr.number,
          prUrl: `https://github.com/${input.repo}/pull/${pr.number}`,
          ...(pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}),
        };
        if (pr.merged_at) return { status: 'merged', patch };
        if (pr.state === 'closed')
          return {
            status: 'dismissed',
            patch: { ...patch, lastError: 'PR was closed without merging.' },
          };
        return { status: 'pr_open', patch };
      }
      const runs = z
        .object({
          workflow_runs: z.array(
            z.object({
              id: z.number().int().positive(),
              display_title: z.string(),
              status: z.string(),
              conclusion: z.string().nullable().optional(),
              created_at: z.string().optional(),
            }),
          ),
        })
        .parse(
          await api(
            `/actions/workflows/${input.workflow}/runs?event=workflow_dispatch&per_page=100`,
            undefined,
            workerRepo,
          ),
        );
      const run = runs.workflow_runs.find(
        (row) =>
          row.display_title === `self-repair:${issue.id}` &&
          (!issue.data.dispatchedAt ||
            (row.created_at && row.created_at >= issue.data.dispatchedAt)),
      );
      if (!run) return null;
      const patch = {
        runId: run.id,
        runUrl: `https://github.com/${workerRepo}/actions/runs/${run.id}`,
      };
      if (run.status === 'completed') {
        // Read the trusted workflow's result step, never execute or follow model-generated text.
        const jobs = z
          .object({
            jobs: z.array(
              z.object({
                name: z.string(),
                steps: z
                  .array(z.object({ name: z.string(), conclusion: z.string().nullable() }))
                  .optional(),
              }),
            ),
          })
          .parse(await api(`/actions/runs/${run.id}/jobs?per_page=100`, undefined, workerRepo));
        const noDefect = jobs.jobs
          .find((job) => job.name === 'code')
          ?.steps?.find(
            (step) =>
              step.conclusion === 'success' &&
              ['No code change: ', 'No confirmed defect: '].some((prefix) =>
                step.name.startsWith(prefix),
              ),
          );
        if (run.conclusion === 'success' && noDefect)
          return {
            status: 'blocked',
            patch: {
              ...patch,
              lastError: `No code change was made. ${noDefect.name.replace(/^(?:No code change|No confirmed defect): /, '').slice(0, 1500)}`,
            },
          };
        return {
          status: 'failed',
          patch: {
            ...patch,
            lastError: `Coding run finished (${run.conclusion ?? 'unknown'}) without a PR. Inspect the run for reproduction, test, or permission failures.`,
          },
        };
      }
      if (run.status === 'in_progress') {
        const jobs = z
          .object({ jobs: z.array(z.object({ name: z.string(), status: z.string() })) })
          .parse(await api(`/actions/runs/${run.id}/jobs?per_page=100`, undefined, workerRepo));
        const verifying = jobs.jobs.some(
          (job) =>
            ['verify', 'publish'].includes(job.name) &&
            ['in_progress', 'completed'].includes(job.status),
        );
        return { status: verifying ? 'testing' : 'fixing', patch };
      }
      return { status: 'fixing', patch };
    },
    async deployed(mergeSha) {
      if (!input.deploymentUrl || !/^[a-f0-9]{40}$/i.test(mergeSha)) return false;
      const url = new URL('/api/health', input.deploymentUrl);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') return false;
      const response = await transport(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return false;
      const health = (await response.json()) as { sha?: string; commit?: string; gitSha?: string };
      const sha = health.sha ?? health.commit ?? health.gitSha;
      if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) return false;
      const comparison = z
        .object({ status: z.string() })
        .parse(await api(`/compare/${mergeSha}...${sha}`));
      return ['identical', 'ahead'].includes(comparison.status);
    },
  };
}
