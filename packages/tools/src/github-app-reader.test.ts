import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubAppReader } from './github-app-reader.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Date.parse('2026-11-18T10:00:00Z');
const token = 'ghs_SYNTHETIC.NOT.A.LIVE.TOKEN';
const repoId = 123;
const repository = {
  id: repoId,
  full_name: 'synthetic-owner/selected-repo',
  private: false,
  archived: false,
  default_branch: 'main',
  temp_clone_token: 'synthetic-extra-secret',
};
const membership = { total_count: 1, repositories: [repository] };
const pr = {
  number: 7,
  title: 'Example pull request',
  state: 'open',
  draft: true,
  merged: false,
  updated_at: '2026-11-18T08:00:00Z',
  base: { repo: { id: repoId } },
  head: { repo: { id: 999, full_name: 'other-org/unselected' } },
  body: 'not within this projection',
};
function issued(
  permissions: Record<string, string> = { metadata: 'read', pull_requests: 'read' },
  extra: Record<string, unknown> = {},
) {
  return Response.json(
    {
      token,
      expires_at: '2026-11-18T11:00:00Z',
      permissions,
      repository_selection: 'selected',
      repositories: [repository],
      ...extra,
    },
    { status: 201 },
  );
}
function harness() {
  const fetcher = vi.fn<typeof fetch>();
  const selectedRepositoryIds = [repoId];
  const reader = createGitHubAppReader(
    {
      privateKey,
      appClientId: 'Iv1.synthetic',
      installationId: 42,
      selectedRepositoryIds,
    },
    { fetch: fetcher, now: () => now },
  );
  return { fetcher, reader, selectedRepositoryIds };
}

describe('selected GitHub App reads', () => {
  it('blocks unselected repositories and invalid IDs before sending credentials', async () => {
    const { reader, fetcher, selectedRepositoryIds } = harness();
    selectedRepositoryIds.push(456);
    await expect(reader.getRepository(456)).rejects.toMatchObject({
      code: 'repository_not_selected',
    });
    await expect(reader.getPullRequest(456, 7)).rejects.toMatchObject({
      code: 'repository_not_selected',
    });
    await expect(reader.getPullRequest(repoId, -1)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(reader.getRepository(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses an RS256 app JWT, a metadata-only token and a safe repository projection', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(issued({ metadata: 'read' }))
      .mockResolvedValueOnce(Response.json(membership));
    expect(await reader.getRepository(repoId)).toEqual({
      id: repoId,
      fullName: repository.full_name,
      private: false,
      archived: false,
      defaultBranch: 'main',
      url: 'https://github.com/synthetic-owner/selected-repo',
    });
    const [exchange, membershipRead] = fetcher.mock.calls;
    if (!exchange || !membershipRead)
      throw new Error('Expected token exchange and membership read');
    const [url, init] = exchange;
    const [membersUrl, membersInit] = membershipRead;
    expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    expect(JSON.parse(String(init?.body))).toEqual({
      repository_ids: [repoId],
      permissions: { metadata: 'read' },
    });
    const jwt = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const [header, claims, signature = ''] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toEqual({
      iss: 'Iv1.synthetic',
      iat: now / 1000 - 60,
      exp: now / 1000 + 300,
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    expect(membersUrl).toBe('https://api.github.com/installation/repositories?per_page=2');
    expect(membersInit).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    expect(new Headers(membersInit?.headers).get('authorization')).toBe(`Bearer ${token}`);
  });

  it('reads only the selected PR and double-checks membership using the same scoped token', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(issued({ pull_requests: 'read' }))
      .mockResolvedValueOnce(Response.json(membership))
      .mockResolvedValueOnce(Response.json(pr))
      .mockResolvedValueOnce(Response.json(membership));
    expect(await reader.getPullRequest(repoId, 7)).toEqual({
      repositoryId: repoId,
      number: 7,
      title: pr.title,
      state: 'open',
      draft: true,
      merged: false,
      updatedAt: pr.updated_at,
      url: 'https://github.com/synthetic-owner/selected-repo/pull/7',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      repository_ids: [repoId],
      permissions: { metadata: 'read', pull_requests: 'read' },
    });
    expect(
      fetcher.mock.calls
        .slice(1)
        .map(([url, init]) => [url, init?.method, new Headers(init?.headers).get('authorization')]),
    ).toEqual([
      ['https://api.github.com/installation/repositories?per_page=2', 'GET', `Bearer ${token}`],
      [
        'https://api.github.com/repos/synthetic-owner/selected-repo/pulls/7',
        'GET',
        `Bearer ${token}`,
      ],
      ['https://api.github.com/installation/repositories?per_page=2', 'GET', `Bearer ${token}`],
    ]);
  });

  it.each([
    () => issued({ metadata: 'read', pull_requests: 'write' }),
    () => issued({ metadata: 'read', pull_requests: 'read', contents: 'read' }),
    () => issued(undefined, { repository_selection: 'all' }),
    () => issued(undefined, { repositories: [repository, { id: 456 }] }),
    () => issued(undefined, { repositories: [{ id: 456 }] }),
    () => issued(undefined, { expires_at: '2026-11-18T09:00:00Z' }),
  ])(
    'rejects over-scoped, mismatched, or expired token results before a data read',
    async (response) => {
      const { reader, fetcher } = harness();
      fetcher.mockResolvedValueOnce(response());
      await expect(reader.getPullRequest(repoId, 7)).rejects.toThrow('GitHub');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('does not reuse the previous token after an installation is revoked', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(issued({ metadata: 'read' }))
      .mockResolvedValueOnce(Response.json(membership))
      .mockResolvedValueOnce(
        Response.json({ message: `provider should not echo ${token}` }, { status: 404 }),
      );
    await expect(reader.getRepository(repoId)).resolves.toMatchObject({ id: repoId });
    await expect(reader.getRepository(repoId)).rejects.toMatchObject({
      code: 'access_unavailable',
      message: 'GitHub did not confirm access to the selected repository or pull request.',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      'https://api.github.com/app/installations/42/access_tokens',
    );
  });

  it('discards a public PR if live access is removed during the read', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(Response.json(membership))
      .mockResolvedValueOnce(Response.json(pr))
      .mockResolvedValueOnce(Response.json({ total_count: 0, repositories: [] }));
    await expect(reader.getPullRequest(repoId, 7)).rejects.toMatchObject({
      code: 'access_unavailable',
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('stops before the PR read when live membership no longer matches the selected ID', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(
        Response.json({ ...membership, repositories: [{ ...repository, id: 456 }] }),
      );
    await expect(reader.getPullRequest(repoId, 7)).rejects.toMatchObject({
      code: 'access_unavailable',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched PR base repository and does not follow provider URLs', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(Response.json(membership))
      .mockResolvedValueOnce(Response.json({ ...pr, base: { repo: { id: 456 } } }));
    await expect(reader.getPullRequest(repoId, 7)).rejects.toMatchObject({
      code: 'access_unavailable',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refuses a redirect and suppresses transport errors containing credentials', async () => {
    const { reader, fetcher } = harness();
    fetcher
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }),
      )
      .mockRejectedValueOnce(new Error(token));
    for (let i = 0; i < 2; i++)
      await expect(reader.getRepository(repoId)).rejects.toMatchObject({
        code: 'request_failed',
        message: 'The GitHub App read could not be completed.',
      });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      Array(2).fill('https://api.github.com/app/installations/42/access_tokens'),
    );
  });
});
