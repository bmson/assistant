import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppIssueCreator,
  GitHubAppIssueCreateError,
  type GitHubIssueCreateInput,
} from './github-app-issue-creator.js';
import { configuredGitHubAppIssueCreator } from './github-app-issue-creator-config.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Date.parse('2026-11-19T10:00:00Z');
const repoId = 123;
const repository = { id: repoId, full_name: 'synthetic-owner/selected-repo', archived: false };
const input = {
  repositoryFullName: repository.full_name,
  title: 'Synthetic approved issue',
  body: 'Only the approved details.\nSecond line.',
};
const issue = {
  id: 701,
  number: 7,
  title: input.title,
  body: input.body,
  state: 'open',
  html_url: `https://github.com/${repository.full_name}/issues/7`,
  repository_url: `https://api.github.com/repos/${repository.full_name}`,
  repository: { id: repoId },
  user: { login: 'not projected' },
  providerSecret: 'not projected',
};
const membership = () => Response.json({ total_count: 1, repositories: [repository] });
const issued = (patch: Record<string, unknown> = {}) =>
  Response.json(
    {
      token: 'ghs_SYNTHETIC.NOT.LIVE',
      expires_at: '2026-11-19T11:00:00Z',
      repository_selection: 'selected',
      repositories: [{ id: repoId }],
      permissions: { metadata: 'read', issues: 'write' },
      ...patch,
    },
    { status: 201 },
  );
const config = {
  privateKey,
  appClientId: 'Iv1.synthetic',
  installationId: 42,
  selectedRepositoryIds: [repoId],
};
function harness() {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(issued())
    .mockResolvedValueOnce(membership())
    .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
    .mockResolvedValueOnce(Response.json(issue))
    .mockResolvedValueOnce(membership());
  return {
    fetcher,
    creator: createGitHubAppIssueCreator(config, { fetch: fetcher, now: () => now }),
  };
}
function writes(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetcher.mock.calls.filter(
    ([url, init]) => init?.method === 'POST' && String(url).endsWith('/issues'),
  );
}
afterEach(() => vi.useRealTimers());

describe('single selected GitHub issue provider', () => {
  it('scopes one fresh token to exactly one repo and confirms the exact issue by readback', async () => {
    const { creator, fetcher } = harness();
    const preflight = vi.fn(async () => {});
    await expect(creator.createIssue(repoId, input, undefined, preflight)).resolves.toEqual({
      repositoryId: repoId,
      repositoryFullName: repository.full_name,
      id: issue.id,
      number: 7,
      title: input.title,
      body: input.body,
      state: 'open',
      url: issue.html_url,
      verified: true,
    });
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      repository_ids: [repoId],
      permissions: { metadata: 'read', issues: 'write' },
    });
    expect(JSON.parse(String(writes(fetcher)[0]?.[1]?.body))).toEqual({
      title: input.title,
      body: input.body,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/app/installations/42/access_tokens',
      'https://api.github.com/installation/repositories?per_page=2',
      `https://api.github.com/repos/${repository.full_name}/issues`,
      `https://api.github.com/repos/${repository.full_name}/issues/7`,
      'https://api.github.com/installation/repositories?per_page=2',
    ]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.github.com');
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    }
  });

  it.each([
    { ...input, title: '' },
    { ...input, title: '  ' },
    { ...input, title: 'bad\nline' },
    { ...input, title: 'bad\u0000value' },
    { ...input, body: 'bad\u007fvalue' },
    { ...input, body: 'x'.repeat(60_001) },
    { ...input, labels: ['not allowed'] },
    { ...input, repositoryFullName: '../other' },
  ])('rejects invalid or extended payload before credentials', async (payload) => {
    const { creator, fetcher } = harness();
    await expect(
      creator.createIssue(repoId, payload as GitHubIssueCreateInput),
    ).rejects.toMatchObject({ code: 'invalid_input', effectStatus: 'not_executed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unselected IDs before requesting a token', async () => {
    const { creator, fetcher } = harness();
    await expect(creator.createIssue(456, input)).rejects.toMatchObject({
      code: 'repository_not_selected',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { permissions: { metadata: 'read', issues: 'read' } },
    { permissions: { metadata: 'read', issues: 'write', contents: 'write' } },
    { permissions: { issues: 'write' } },
    { repository_selection: 'all' },
    { repositories: [{ id: repoId }, { id: 456 }] },
    { repositories: [{ id: 456 }] },
    { expires_at: '2026-11-19T09:00:00Z' },
  ])('rejects unverifiable token scope/expiry before any issue write', async (patch) => {
    const { creator, fetcher } = harness();
    fetcher.mockReset().mockResolvedValueOnce(issued(patch));
    await expect(creator.createIssue(repoId, input)).rejects.toBeInstanceOf(
      GitHubAppIssueCreateError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(writes(fetcher)).toHaveLength(0);
  });

  it('checks approved repository name against the live selected numeric ID before posting', async () => {
    const { creator, fetcher } = harness();
    await expect(
      creator.createIssue(repoId, { ...input, repositoryFullName: 'other-owner/other-repo' }),
    ).rejects.toMatchObject({ code: 'access_unavailable', effectStatus: 'not_executed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(writes(fetcher)).toHaveLength(0);
  });

  it.each([
    { total_count: 0, repositories: [] },
    { total_count: 1, repositories: [{ ...repository, id: 456 }] },
    { total_count: 1, repositories: [{ ...repository, archived: true }] },
    { total_count: 2, repositories: [repository, { ...repository, id: 456 }] },
  ])('refuses unconfirmed live installation membership before any issue POST', async (value) => {
    const { creator, fetcher } = harness();
    fetcher.mockReset().mockResolvedValueOnce(issued()).mockResolvedValueOnce(Response.json(value));
    await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
      effectStatus: 'not_executed',
    });
    expect(writes(fetcher)).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rechecks token expiry after asynchronous authorization before POST', async () => {
    const { fetcher } = harness();
    let clock = now;
    let checks = 0;
    const creator = createGitHubAppIssueCreator(config, { fetch: fetcher, now: () => clock });
    await expect(
      creator.createIssue(repoId, input, undefined, async () => {
        if (++checks === 2) clock = Date.parse('2026-11-19T11:00:00Z');
      }),
    ).rejects.toMatchObject({ effectStatus: 'not_executed' });
    expect(writes(fetcher)).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts case-insensitive approved slug but uses GitHub canonical resource URLs', async () => {
    const { creator } = harness();
    await expect(
      creator.createIssue(repoId, {
        ...input,
        repositoryFullName: repository.full_name.toUpperCase(),
      }),
    ).resolves.toMatchObject({ repositoryFullName: repository.full_name, verified: true });
  });

  it('rechecks execution authorization after token and membership I/O before posting', async () => {
    const { creator, fetcher } = harness();
    const preflight = vi.fn(async () => {
      if (preflight.mock.calls.length === 2) throw new Error('withdrawn synthetic approval');
    });
    await expect(creator.createIssue(repoId, input, undefined, preflight)).rejects.toMatchObject({
      effectStatus: 'not_executed',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(writes(fetcher)).toHaveLength(0);
  });

  it('uses a snapshot without silently rewriting approved whitespace or accepting asynchronous mutation', async () => {
    const { creator, fetcher } = harness();
    const original = { ...input };
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockImplementationOnce(async () => {
        original.title = 'different';
        return membership();
      })
      .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
      .mockResolvedValueOnce(Response.json(issue))
      .mockResolvedValueOnce(membership());
    await expect(creator.createIssue(repoId, original)).resolves.toMatchObject({
      title: input.title,
    });
    expect(JSON.parse(String(writes(fetcher)[0]?.[1]?.body))).toEqual({
      title: input.title,
      body: input.body,
    });
  });

  it.each(['id', 'number', 'title', 'body', 'html_url', 'repository_url', 'repository'] as const)(
    'marks mismatched readback %s unknown without retrying',
    async (field) => {
      const wrong = {
        ...issue,
        [field]:
          field === 'repository'
            ? { id: 456 }
            : field === 'id' || field === 'number'
              ? 999
              : 'mismatch',
      };
      const { creator, fetcher } = harness();
      fetcher
        .mockReset()
        .mockResolvedValueOnce(issued())
        .mockResolvedValueOnce(membership())
        .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
        .mockResolvedValueOnce(Response.json(wrong));
      await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
        code: 'outcome_unknown',
        effectStatus: 'unknown',
      });
      expect(writes(fetcher)).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    { title: 'wrong' },
    { body: null },
    { number: 8 },
    { html_url: 'https://evil.example/issue/7' },
    { repository_url: 'https://api.github.com/repos/other/repo' },
    { repository: { id: 456 } },
    { pull_request: { url: 'not an issue' } },
  ])('never confirms malformed or mismatched creation metadata', async (patch) => {
    const { creator, fetcher } = harness();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(Response.json({ ...issue, ...patch }, { status: 201 }));
    await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
      effectStatus: 'unknown',
    });
    expect(writes(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('treats null body as empty only for an approved empty body', async () => {
    const { creator, fetcher } = harness();
    const empty = { ...issue, body: null };
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(Response.json(empty, { status: 201 }))
      .mockResolvedValueOnce(Response.json(empty))
      .mockResolvedValueOnce(membership());
    await expect(creator.createIssue(repoId, { ...input, body: '' })).resolves.toMatchObject({
      body: '',
      verified: true,
    });
  });

  it.each([400, 401, 403, 404, 409, 410, 422, 429])(
    'preserves definitive HTTP %s rejection without a second POST',
    async (status) => {
      const { creator, fetcher } = harness();
      fetcher
        .mockReset()
        .mockResolvedValueOnce(issued())
        .mockResolvedValueOnce(membership())
        .mockResolvedValueOnce(
          Response.json({ message: 'synthetic private provider detail' }, { status }),
        );
      await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
        code: 'provider_rejected',
        effectStatus: 'not_executed',
      });
      expect(writes(fetcher)).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    () => Promise.reject(new Error('Bearer synthetic-secret')),
    () => Promise.resolve(new Response(null, { status: 503 })),
    () =>
      Promise.resolve(
        new Response(null, { status: 301, headers: { location: 'https://evil.example' } }),
      ),
    () =>
      Promise.resolve(
        new Response('{broken', { status: 201, headers: { 'content-type': 'application/json' } }),
      ),
  ])('records an unconfirmed submitted write as unknown with no blind retry', async (response) => {
    const { creator, fetcher } = harness();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(membership())
      .mockImplementationOnce(response);
    const error = await creator.createIssue(repoId, input).catch((e) => e);
    expect(error).toMatchObject({ code: 'outcome_unknown', effectStatus: 'unknown' });
    expect(error.message).not.toContain('synthetic-secret');
    expect(writes(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('suppresses confirmed metadata if final membership or final authorization was withdrawn', async () => {
    for (const useFence of [false, true]) {
      const { creator, fetcher } = harness();
      if (!useFence)
        fetcher
          .mockReset()
          .mockResolvedValueOnce(issued())
          .mockResolvedValueOnce(membership())
          .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
          .mockResolvedValueOnce(Response.json(issue))
          .mockResolvedValueOnce(Response.json({ total_count: 0, repositories: [] }));
      let checks = 0;
      await expect(
        creator.createIssue(repoId, input, undefined, async () => {
          if (useFence && ++checks === 3) throw new Error('withdrawn');
        }),
      ).rejects.toMatchObject({ effectStatus: 'unknown' });
      expect(writes(fetcher)).toHaveLength(1);
    }
  });

  it('bounds an oversized creation response as unknown without a second POST', async () => {
    const { creator, fetcher } = harness();
    let cancelled = false;
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(512 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );
    await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
      effectStatus: 'unknown',
    });
    expect(writes(fetcher)).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it('cannot confirm a submitted issue when its readback exceeds the shared deadline', async () => {
    vi.useFakeTimers();
    const { creator, fetcher } = harness();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const outcome = creator.createIssue(repoId, input).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await outcome).toMatchObject({ effectStatus: 'unknown' });
    expect(writes(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not resume into a late POST after preflight exceeded the shared deadline', async () => {
    vi.useFakeTimers();
    const { creator, fetcher } = harness();
    let checks = 0;
    let release = () => {};
    const outcome = creator
      .createIssue(repoId, input, undefined, async () => {
        if (++checks === 2)
          await new Promise<void>((r) => {
            release = r;
          });
      })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await outcome).toMatchObject({ effectStatus: 'not_executed' });
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(writes(fetcher)).toHaveLength(0);
  });

  it('reports a timed-out write as unknown even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const { creator, fetcher } = harness();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(membership())
      .mockImplementationOnce(() => new Promise(() => {}));
    const outcome = creator.createIssue(repoId, input).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await outcome).toMatchObject({ effectStatus: 'unknown' });
    expect(writes(fetcher)).toHaveLength(1);
  });
});

async function configuredHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-issue-provider-'));
  const keyPath = join(directory, 'key.pem');
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED: 'true',
    ASSISTANT_GITHUB_APP_CLIENT_ID: config.appClientId,
    ASSISTANT_GITHUB_APP_INSTALLATION_ID: '42',
    ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS: String(repoId),
  };
  const { fetcher } = harness();
  return {
    directory,
    keyPath,
    env,
    fetcher,
    load: () => configuredGitHubAppIssueCreator(env, { fetch: fetcher, now: () => now }),
  };
}
describe('configured issue creator scope and signing-key fences', () => {
  it('is optional and refuses disabled configuration without loading provider credentials', async () => {
    await expect(configuredGitHubAppIssueCreator({})).resolves.toBeNull();
  });
  it.each([
    'ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS',
    'ASSISTANT_GITHUB_APP_INSTALLATION_ID',
    'ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED',
    'ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE',
  ])('fences %s changed during membership I/O before POST', async (field) => {
    const h = await configuredHarness();
    try {
      const creator = await h.load();
      if (!creator) throw new Error('Missing synthetic creator');
      h.fetcher
        .mockReset()
        .mockResolvedValueOnce(issued())
        .mockImplementationOnce(async () => {
          h.env[field] =
            field === 'ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS'
              ? '456'
              : field === 'ASSISTANT_GITHUB_APP_INSTALLATION_ID'
                ? '99'
                : field === 'ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED'
                  ? 'false'
                  : '/missing-key';
          return membership();
        });
      await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
        effectStatus: 'not_executed',
      });
      expect(writes(h.fetcher)).toHaveLength(0);
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });
  it.each([
    'ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS',
    'ASSISTANT_GITHUB_APP_INSTALLATION_ID',
    'ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED',
  ])('suppresses post-write results when %s is withdrawn', async (field) => {
    const h = await configuredHarness();
    try {
      const creator = await h.load();
      if (!creator) throw new Error('Missing synthetic creator');
      h.fetcher
        .mockReset()
        .mockResolvedValueOnce(issued())
        .mockResolvedValueOnce(membership())
        .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
        .mockImplementationOnce(async () => {
          h.env[field] =
            field === 'ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS'
              ? '456'
              : field === 'ASSISTANT_GITHUB_APP_INSTALLATION_ID'
                ? '99'
                : 'false';
          return Response.json(issue);
        })
        .mockResolvedValueOnce(membership());
      await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
        effectStatus: 'unknown',
      });
      expect(writes(h.fetcher)).toHaveLength(1);
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });

  it.each([
    { RESTORE_REHEARSAL: 'true' },
    { ASSISTANT_RELEASE_WRITES_PAUSED: 'true' },
    { PERSISTENCE_DRIVER: 'postgres', POSTGRES_SOURCE_WRITES_FENCED: 'true' },
  ])('does not load an enabled creator while maintenance holds apply', async (hold) => {
    const h = await configuredHarness();
    try {
      Object.assign(h.env, hold);
      await expect(h.load()).resolves.toBeNull();
      expect(h.fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });

  it('checks signing-key identity after network I/O and before write', async () => {
    const h = await configuredHarness();
    try {
      const creator = await h.load();
      if (!creator) throw new Error('Missing synthetic creator');
      h.fetcher
        .mockReset()
        .mockResolvedValueOnce(issued())
        .mockImplementationOnce(async () => {
          await writeFile(h.keyPath, 'invalid replacement', { mode: 0o600 });
          return membership();
        });
      await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
        effectStatus: 'not_executed',
      });
      expect(writes(h.fetcher)).toHaveLength(0);
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });
  it('marks key withdrawal after submitted write unknown rather than returning private metadata', async () => {
    const h = await configuredHarness();
    try {
      const creator = await h.load();
      if (!creator) throw new Error('Missing synthetic creator');
      h.fetcher
        .mockReset()
        .mockResolvedValueOnce(issued())
        .mockResolvedValueOnce(membership())
        .mockResolvedValueOnce(Response.json(issue, { status: 201 }))
        .mockImplementationOnce(async () => {
          await rm(h.keyPath);
          return Response.json(issue);
        })
        .mockResolvedValueOnce(membership());
      await expect(creator.createIssue(repoId, input)).rejects.toMatchObject({
        effectStatus: 'unknown',
      });
      expect(writes(h.fetcher)).toHaveLength(1);
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });
});
