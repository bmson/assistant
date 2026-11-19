import { z } from 'zod';
import { boundedProviderResponse, providerTransaction } from './bounded-provider-response.js';
import {
  type GitHubAppReaderConfig,
  githubAppJwt,
  githubAppPrivateKey,
} from './github-app-reader.js';

const API = 'https://api.github.com';
const DEADLINE_MS = 15_000;
const id = z.number().int().positive();
const fullName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  .refine((v) => !v.endsWith('/.') && !v.endsWith('/..'));
function hasDisallowedControls(value: string, allowWhitespace: boolean): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    const allowed = allowWhitespace && [9, 10, 13].includes(code);
    return (code < 32 && !allowed) || (code >= 127 && code <= 159);
  });
}

export const GitHubIssueCreateInputSchema = z
  .object({
    repositoryFullName: fullName,
    title: z
      .string()
      .min(1)
      .max(256)
      .refine((v) => v.trim().length > 0 && !hasDisallowedControls(v, false)),
    body: z
      .string()
      .max(60_000)
      .refine((v) => !hasDisallowedControls(v, true)),
  })
  .strict();
export type GitHubIssueCreateInput = z.infer<typeof GitHubIssueCreateInputSchema>;
const tokenSchema = z.object({
  token: z
    .string()
    .max(16_384)
    .regex(/^ghs_[A-Za-z0-9_.-]+$/),
  expires_at: z.iso.datetime({ offset: true }),
  repository_selection: z.literal('selected'),
  repositories: z.tuple([z.object({ id })]),
  permissions: z.object({ metadata: z.literal('read'), issues: z.literal('write') }).strict(),
});
const membershipSchema = z.object({
  total_count: z.literal(1),
  repositories: z.tuple([z.object({ id, full_name: fullName, archived: z.boolean() })]),
});
const issueSchema = z.object({
  id,
  number: id,
  title: z.string(),
  body: z.string().nullable(),
  state: z.literal('open'),
  html_url: z.string(),
  repository_url: z.string(),
  repository: z.object({ id }).optional(),
  pull_request: z.never().optional(),
});
const messages = {
  invalid_configuration: 'GitHub issue creation configuration is invalid.',
  invalid_input:
    'Use a selected repository ID and name, a nonempty title, and a bounded issue body.',
  repository_not_selected: 'This repository is not selected for GitHub issue creation.',
  access_unavailable: 'GitHub did not confirm the approved repository and issue-write scope.',
  unexpected_response: 'GitHub returned an unexpected issue-creation response.',
  request_failed: 'GitHub issue creation could not be started.',
  provider_rejected: 'GitHub rejected the issue creation request. No issue was confirmed.',
  outcome_unknown:
    'The GitHub issue may have been created, but its result was not confirmed. Do not retry blindly.',
} as const;
export class GitHubAppIssueCreateError extends Error {
  readonly effectStatus: 'unknown' | 'not_executed';
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'GitHubAppIssueCreateError';
    this.effectStatus = code === 'outcome_unknown' ? 'unknown' : 'not_executed';
  }
}
export interface CreatedGitHubIssue {
  repositoryId: number;
  repositoryFullName: string;
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open';
  url: string;
  verified: true;
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitHubAppIssueCreateError('unexpected_response');
  return result.data;
}

/** One explicitly approved issue; no retries, updates, PRs, labels, or broad installation tokens. */
export function createGitHubAppIssueCreator(
  config: GitHubAppReaderConfig,
  options: { fetch?: typeof fetch; now?: () => number } = {},
) {
  let key: ReturnType<typeof githubAppPrivateKey>;
  try {
    key = githubAppPrivateKey(config);
  } catch {
    throw new GitHubAppIssueCreateError('invalid_configuration');
  }
  const { appClientId, installationId } = config;
  const selected = new Set(config.selectedRepositoryIds);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  async function request(
    path: string,
    bearer: string,
    signal: AbortSignal,
    status: number,
    body?: object,
    issueWrite = false,
  ) {
    const response = await boundedProviderResponse(
      fetcher,
      API + path,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${bearer}`,
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'assistant-github-app-issue-creator',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal,
      },
      { timeoutMs: DEADLINE_MS, maxBytes: 512 * 1024, label: 'GitHub issue creation' },
    );
    if (response.status !== status) {
      if (issueWrite && [400, 401, 403, 404, 409, 410, 422, 429].includes(response.status))
        throw new GitHubAppIssueCreateError('provider_rejected');
      throw new GitHubAppIssueCreateError('request_failed');
    }
    if (
      !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new GitHubAppIssueCreateError('unexpected_response');
    try {
      return await response.json();
    } catch {
      throw new GitHubAppIssueCreateError('unexpected_response');
    }
  }
  async function membership(repoId: number, expected: string, bearer: string, signal: AbortSignal) {
    const value = parse(
      membershipSchema,
      await request('/installation/repositories?per_page=2', bearer, signal, 200),
    );
    const repo = value.repositories[0];
    if (
      repo.id !== repoId ||
      repo.archived ||
      repo.full_name.toLowerCase() !== expected.toLowerCase()
    )
      throw new GitHubAppIssueCreateError('access_unavailable');
    return repo;
  }
  return {
    async createIssue(
      repoId: number,
      input: GitHubIssueCreateInput,
      signal?: AbortSignal,
      preflight?: () => Promise<void>,
    ): Promise<CreatedGitHubIssue> {
      const validated = GitHubIssueCreateInputSchema.safeParse(input);
      if (!Number.isSafeInteger(repoId) || repoId < 1 || !validated.success) {
        throw new GitHubAppIssueCreateError('invalid_input');
      }
      if (!selected.has(repoId)) throw new GitHubAppIssueCreateError('repository_not_selected');
      // Zod clones the approved payload before asynchronous callbacks can mutate its source.
      const approved = validated.data;
      let submitted = false;
      try {
        return await providerTransaction(
          signal,
          DEADLINE_MS,
          'GitHub issue creation',
          async (operationSignal) => {
            const fence = async () => {
              operationSignal.throwIfAborted();
              await preflight?.();
              operationSignal.throwIfAborted();
            };
            await fence();
            const token = parse(
              tokenSchema,
              await request(
                `/app/installations/${installationId}/access_tokens`,
                githubAppJwt(key, appClientId, now()),
                operationSignal,
                201,
                { repository_ids: [repoId], permissions: { metadata: 'read', issues: 'write' } },
              ),
            );
            if (token.repositories[0].id !== repoId || Date.parse(token.expires_at) <= now())
              throw new GitHubAppIssueCreateError('access_unavailable');
            const repo = await membership(
              repoId,
              approved.repositoryFullName,
              token.token,
              operationSignal,
            );
            await fence();
            if (Date.parse(token.expires_at) <= now()) {
              throw new GitHubAppIssueCreateError('access_unavailable');
            }
            const path = `/repos/${repo.full_name}/issues`;
            submitted = true;
            const created = parse(
              issueSchema,
              await request(
                path,
                token.token,
                operationSignal,
                201,
                { title: approved.title, body: approved.body },
                true,
              ),
            );
            const matches = (issue: z.infer<typeof issueSchema>) =>
              issue.title === approved.title &&
              (issue.body ?? '') === approved.body &&
              issue.html_url === `https://github.com/${repo.full_name}/issues/${created.number}` &&
              issue.repository_url === `${API}/repos/${repo.full_name}` &&
              issue.id === created.id &&
              issue.number === created.number &&
              (!issue.repository || issue.repository.id === repoId);
            if (!matches(created)) throw new GitHubAppIssueCreateError('outcome_unknown');
            const readback = parse(
              issueSchema,
              await request(`${path}/${created.number}`, token.token, operationSignal, 200),
            );
            if (!matches(readback)) throw new GitHubAppIssueCreateError('outcome_unknown');
            const current = await membership(repoId, repo.full_name, token.token, operationSignal);
            if (current.full_name !== repo.full_name)
              throw new GitHubAppIssueCreateError('outcome_unknown');
            await fence();
            if (Date.parse(token.expires_at) <= now())
              throw new GitHubAppIssueCreateError('outcome_unknown');
            return {
              repositoryId: repoId,
              repositoryFullName: current.full_name,
              id: readback.id,
              number: readback.number,
              title: readback.title,
              body: readback.body ?? '',
              state: readback.state,
              url: readback.html_url,
              verified: true,
            };
          },
        );
      } catch (error) {
        if (submitted) {
          if (error instanceof GitHubAppIssueCreateError && error.code === 'provider_rejected')
            throw error;
          throw new GitHubAppIssueCreateError('outcome_unknown');
        }
        if (error instanceof GitHubAppIssueCreateError) throw error;
        throw new GitHubAppIssueCreateError('request_failed');
      }
    },
  };
}
