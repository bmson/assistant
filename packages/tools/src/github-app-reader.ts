import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { boundedProviderResponse, providerTransaction } from './bounded-provider-response.js';

const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const DEADLINE_MS = 15_000;
const id = z.number().int().positive();
const fullName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  .refine((value) => !value.endsWith('/.') && !value.endsWith('/..'));
const instant = z.iso.datetime({ offset: true });
const tokenResponse = z.object({
  token: z
    .string()
    .max(16_384)
    .regex(/^ghs_[A-Za-z0-9_.-]+$/),
  expires_at: instant,
  repository_selection: z.literal('selected'),
  repositories: z.tuple([z.object({ id })]),
  permissions: z
    .object({
      metadata: z.literal('read').optional(),
      pull_requests: z.literal('read').optional(),
    })
    .strict(),
});
const installationRepositories = z.object({
  total_count: z.literal(1),
  repositories: z.tuple([
    z.object({
      id,
      full_name: fullName,
      private: z.boolean(),
      default_branch: z.string().min(1).max(1024),
      archived: z.boolean(),
    }),
  ]),
});
const pullRequestResponse = z.object({
  number: id,
  title: z.string().min(1).max(1024),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean(),
  updated_at: instant,
  base: z.object({ repo: z.object({ id }) }),
});

const messages = {
  invalid_configuration: 'GitHub App reader configuration is invalid.',
  invalid_input: 'Use positive integer repository IDs and pull request numbers.',
  repository_not_selected: 'This repository is not selected for GitHub App reads.',
  access_unavailable: 'GitHub did not confirm access to the selected repository or pull request.',
  unexpected_response: 'GitHub returned an unexpected response. No data was returned.',
  request_failed: 'The GitHub App read could not be completed.',
} as const;

export class GitHubAppReadError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'GitHubAppReadError';
  }
}

export interface GitHubAppReaderConfig {
  appClientId: string;
  installationId: number;
  privateKey: string | KeyObject;
  selectedRepositoryIds: readonly number[];
}

export function githubAppJwt(key: KeyObject, issuer: string, now: number) {
  const seconds = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: issuer,
    iat: seconds - 60,
    exp: seconds + 300,
  })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}

function parseResponse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitHubAppReadError('unexpected_response');
  return result.data;
}

/** Shared server-only key validation; token permissions remain local to each adapter. */
export function githubAppPrivateKey(config: GitHubAppReaderConfig): KeyObject {
  const { appClientId, installationId } = config;
  const selected = new Set(config.selectedRepositoryIds);
  let key: KeyObject;
  try {
    key =
      typeof config.privateKey === 'string'
        ? createPrivateKey(config.privateKey)
        : config.privateKey;
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(appClientId) ||
      !id.safeParse(installationId).success ||
      !selected.size ||
      [...selected].some((repoId) => !id.safeParse(repoId).success) ||
      key.type !== 'private' ||
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
  } catch {
    throw new GitHubAppReadError('invalid_configuration');
  }

  return key;
}

/** Server-only reader. One operation uses one fresh, single-repository installation token. */
export function createGitHubAppReader(
  config: GitHubAppReaderConfig,
  options: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const { appClientId, installationId } = config;
  const selected = new Set(config.selectedRepositoryIds);
  const key = githubAppPrivateKey(config);

  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function request(
    path: string,
    bearer: string,
    signal: AbortSignal,
    expectedStatus: number,
    body?: object,
  ): Promise<unknown> {
    const response = await boundedProviderResponse(
      fetcher,
      `${API}${path}`,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${bearer}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'assistant-github-app-reader',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal,
      },
      { timeoutMs: DEADLINE_MS, maxBytes: 512 * 1024, label: 'GitHub App read' },
    );
    if (response.status !== expectedStatus) {
      const limited =
        response.headers.has('retry-after') ||
        response.headers.get('x-ratelimit-remaining') === '0';
      if (!limited && [401, 403, 404, 422].includes(response.status))
        throw new GitHubAppReadError('access_unavailable');
      throw new GitHubAppReadError('request_failed');
    }
    if (
      !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new GitHubAppReadError('unexpected_response');
    try {
      return await response.json();
    } catch {
      throw new GitHubAppReadError('unexpected_response');
    }
  }

  async function confirmMembership(repoId: number, token: string, signal: AbortSignal) {
    const membership = await request('/installation/repositories?per_page=2', token, signal, 200);
    const parsed = installationRepositories.safeParse(membership);
    if (!parsed.success || parsed.data.repositories[0].id !== repoId)
      throw new GitHubAppReadError('access_unavailable');
    return parsed.data.repositories[0];
  }

  async function withRepository<T>(
    repoId: number,
    pullRequests: boolean,
    caller: AbortSignal | undefined,
    read: (
      repository: z.infer<typeof installationRepositories>['repositories'][0],
      bearer: string,
      signal: AbortSignal,
    ) => T | Promise<T>,
  ): Promise<T> {
    if (!id.safeParse(repoId).success) throw new GitHubAppReadError('invalid_input');
    if (!selected.has(repoId)) throw new GitHubAppReadError('repository_not_selected');
    try {
      return await providerTransaction(caller, DEADLINE_MS, 'GitHub App read', async (signal) => {
        const token = parseResponse(
          tokenResponse,
          await request(
            `/app/installations/${installationId}/access_tokens`,
            githubAppJwt(key, appClientId, now()),
            signal,
            201,
            {
              repository_ids: [repoId],
              permissions: pullRequests
                ? { metadata: 'read', pull_requests: 'read' }
                : { metadata: 'read' },
            },
          ),
        );
        if (
          token.repositories[0].id !== repoId ||
          token.permissions.pull_requests !== (pullRequests ? 'read' : undefined) ||
          Date.parse(token.expires_at) <= now()
        )
          throw new GitHubAppReadError('access_unavailable');

        return read(await confirmMembership(repoId, token.token, signal), token.token, signal);
      });
    } catch (error) {
      if (error instanceof GitHubAppReadError) throw error;
      throw new GitHubAppReadError('request_failed');
    }
  }

  return {
    getRepository(repoId: number, signal?: AbortSignal) {
      return withRepository(repoId, false, signal, (repository) => ({
        id: repoId,
        fullName: repository.full_name,
        private: repository.private,
        archived: repository.archived,
        defaultBranch: repository.default_branch,
        url: `https://github.com/${repository.full_name}`,
      }));
    },
    async getPullRequest(repoId: number, number: number, signal?: AbortSignal) {
      if (!id.safeParse(number).success) throw new GitHubAppReadError('invalid_input');
      return withRepository(repoId, true, signal, async (repository, token, readSignal) => {
        const result = parseResponse(
          pullRequestResponse,
          await request(`/repos/${repository.full_name}/pulls/${number}`, token, readSignal, 200),
        );
        if (result.number !== number || result.base.repo.id !== repoId)
          throw new GitHubAppReadError('access_unavailable');
        // A public PR may still be visible after installation access changed.
        const current = await confirmMembership(repoId, token, readSignal);
        if (current.full_name !== repository.full_name)
          throw new GitHubAppReadError('access_unavailable');
        return {
          repositoryId: repoId,
          number,
          title: result.title,
          state: result.state,
          draft: result.draft,
          merged: result.merged,
          updatedAt: result.updated_at,
          url: `https://github.com/${current.full_name}/pull/${number}`,
        };
      });
    },
  };
}
