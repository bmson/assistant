import { FirestoreMcpConnectionReadRepository } from '@assistant/firestore';
import { expect, it, vi } from 'vitest';
import type { AgentDeps } from './deps.js';
import { repairRepositoryReader } from './repair-repository.js';

function setup(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'connection',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    enabled: true,
    status: 'ready',
    tools: [{ name: 'get_file_contents' }],
    bearerTokenEncrypted: 'encrypted',
    manualCredentialAvailable: true,
    ...overrides,
  };
  const where = vi.fn(async () => [row]);
  const deps = {
    config: {
      SELF_REPAIR_ENABLED: true,
      GITHUB_REPO: 'owner/assistant',
      SELF_REPAIR_ALLOW_EXECUTOR: false,
    },
    db: { select: () => ({ from: () => ({ where }) }) },
  } as unknown as AgentDeps;
  const invoke = vi.fn(async () => ({ content: [{ type: 'text', text: 'source'.repeat(2000) }] }));
  return { deps, row, where, invoke, reader: repairRepositoryReader(deps, invoke) };
}

it('reads only bounded permitted paths through the saved GitHub MCP connection', async () => {
  const h = setup();
  const result = await h.reader('owner-id', [
    'packages/application/src/workspace-improvements.ts',
    '../secrets',
    'packages/config/src/index.ts',
    'packages/application/src/workspace-improvements.ts',
  ]);
  expect(result).toMatchObject({ source: 'github_mcp', connectionId: 'connection' });
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.excerpt.length).toBeLessThanOrEqual(4000);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    'https://api.githubcopilot.com/mcp/',
    'get_file_contents',
    {
      owner: 'owner',
      repo: 'assistant',
      path: 'packages/application/src/workspace-improvements.ts',
    },
    'encrypted',
  );
});
it.each([
  { enabled: false },
  { status: 'error' },
  { endpoint: 'https://other.example/mcp/' },
  { tools: [{ name: 'push_files' }] },
  { manualCredentialAvailable: false },
])('does not use disabled, changed, or incompatible connections: %j', async (change) => {
  const h = setup(change);
  expect(await h.reader('owner-id', [])).toMatchObject({ source: 'unavailable', files: [] });
  expect(h.invoke).not.toHaveBeenCalled();
});
it('uses repository documentation when triage has no known source path', async () => {
  const h = setup();
  await h.reader('owner-id', []);
  expect(h.invoke).toHaveBeenCalledWith(
    expect.any(String),
    'get_file_contents',
    { owner: 'owner', repo: 'assistant', path: 'README.md' },
    'encrypted',
  );
});
it('does not turn a missing source or a failed MCP request into repository evidence', async () => {
  const h = setup();
  h.invoke.mockRejectedValue(new Error('not found'));
  expect(await h.reader('owner-id', ['apps/example.ts'])).toMatchObject({
    source: 'unavailable',
    files: [],
  });
});

it('rechecks PostgreSQL mode between file requests and never falls back after OAuth installation', async () => {
  const h = setup();
  h.invoke.mockImplementationOnce(async () => {
    h.where.mockResolvedValue([{ ...h.row, manualCredentialAvailable: false }]);
    return { content: [{ type: 'text', text: 'first' }] };
  });
  const result = await h.reader('owner-id', ['README.md', 'apps/example.ts']);
  expect(result.files.map((file) => file.path)).toEqual(['README.md']);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it('rechecks Firestore mode before invoking a previously eligible manual connection', async () => {
  const h = setup();
  const id = 'e1f5d01b-8e13-4809-8337-63ee9fbd74b4';
  const ownerId = 'owner-id';
  const row = { ...h.row, id, name: 'Source', serverName: null };
  const list = vi.spyOn(FirestoreMcpConnectionReadRepository.prototype, 'list').mockResolvedValue([
    {
      ...row,
      instructions: null,
      serverVersion: null,
      hasBearerToken: true,
      lastCheckedAt: null,
      lastError: null,
      status: 'ready',
    },
  ]);
  const get = vi
    .spyOn(FirestoreMcpConnectionReadRepository.prototype, 'getForTools')
    .mockResolvedValueOnce(row)
    .mockResolvedValueOnce({
      ...row,
      oauthState: { version: 1, ownerId, connectionId: id, grant: {} },
    });
  try {
    const reader = repairRepositoryReader({ ...h.deps, firestoreStore: {} } as AgentDeps, h.invoke);
    expect(await reader(ownerId, ['README.md'])).toMatchObject({
      source: 'unavailable',
      files: [],
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(h.invoke).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
    get.mockRestore();
  }
});
