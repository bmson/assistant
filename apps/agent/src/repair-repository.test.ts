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
  return { deps, invoke, reader: repairRepositoryReader(deps, invoke) };
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
