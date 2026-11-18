import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  configuredGitHubAppReader,
  configuredGitHubAppSelection,
} from './github-app-reader-config.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

let directory: string;
let env: NodeJS.ProcessEnv;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'assistant-github-reader-'));
  const key = join(directory, 'fixture.pem');
  await writeFile(key, pem, { mode: 0o600 });
  env = {
    ASSISTANT_GITHUB_APP_CLIENT_ID: 'Iv1.synthetic',
    ASSISTANT_GITHUB_APP_INSTALLATION_ID: '42',
    ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE: key,
    ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS: '123, 456',
  };
  fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it('leaves the reader off when absent, incomplete, malformed or oversized', async () => {
  await expect(configuredGitHubAppReader({})).resolves.toBeNull();
  for (const name of Object.keys(env)) {
    await expect(configuredGitHubAppReader({ ...env, [name]: undefined })).resolves.toBeNull();
  }
  for (const invalid of [
    '123,',
    '123,123',
    '001',
    '9007199254740992',
    '1'.repeat(4097),
    Array.from({ length: 101 }, (_, index) => index + 1).join(','),
  ]) {
    await expect(
      configuredGitHubAppReader({
        ...env,
        ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS: invalid,
      }),
    ).resolves.toBeNull();
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('refuses symlinks, broad permissions, nonfiles, oversized files and malformed keys', async () => {
  const key = join(directory, 'fixture.pem');
  const alias = join(directory, 'alias.pem');
  await symlink(key, alias);
  for (const path of [alias, directory, join(directory, 'missing.pem'), 'relative.pem']) {
    await expect(
      configuredGitHubAppReader({
        ...env,
        ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE: path,
      }),
    ).resolves.toBeNull();
  }
  await chmod(key, 0o640);
  await expect(configuredGitHubAppReader(env)).resolves.toBeNull();
  await chmod(key, 0o600);
  await writeFile(key, Buffer.alloc(16 * 1024 + 1));
  await expect(configuredGitHubAppReader(env)).resolves.toBeNull();
  await writeFile(key, 'synthetic key material that is invalid');
  await expect(configuredGitHubAppReader(env)).resolves.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('checks the current selection before network traffic, including removal during key loading', async () => {
  const reader = await configuredGitHubAppReader(env);
  assert(reader);
  const beforeRemoval = reader.getRepository(123);
  env.ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS = '456';
  await expect(beforeRemoval).rejects.toMatchObject({ code: 'repository_not_selected' });
  await expect(reader.getPullRequest(123, 7)).rejects.toMatchObject({
    code: 'repository_not_selected',
  });
  expect(fetcher).not.toHaveBeenCalled();

  const repository = {
    id: 456,
    full_name: 'fixture/selected',
    private: true,
    archived: false,
    default_branch: 'main',
  };
  fetcher
    .mockResolvedValueOnce(
      Response.json(
        {
          token: 'ghs_SYNTHETIC',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          repository_selection: 'selected',
          repositories: [repository],
          permissions: { metadata: 'read' },
        },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(Response.json({ total_count: 1, repositories: [repository] }));
  await expect(reader.getRepository(456)).resolves.toMatchObject({
    id: 456,
    fullName: 'fixture/selected',
  });
  const exchange = fetcher.mock.calls[0];
  expect(exchange?.[0]).toBe('https://api.github.com/app/installations/42/access_tokens');
  expect(JSON.parse(String(exchange?.[1]?.body))).toEqual({
    repository_ids: [456],
    permissions: { metadata: 'read' },
  });
});

it('fails closed when configuration or key is withdrawn and exposes only the fixed error', async () => {
  const reader = await configuredGitHubAppReader(env);
  assert(reader);
  const key = join(directory, 'fixture.pem');
  await writeFile(key, 'synthetic-secret-key-content');
  await expect(reader.getRepository(123)).rejects.toMatchObject({
    code: 'invalid_configuration',
    message: 'GitHub App reader configuration is invalid.',
  });
  delete env.ASSISTANT_GITHUB_APP_INSTALLATION_ID;
  await expect(reader.getRepository(123)).rejects.toMatchObject({ code: 'invalid_configuration' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ['ASSISTANT_GITHUB_APP_CLIENT_ID', 'Iv1.replacement'],
  ['ASSISTANT_GITHUB_APP_INSTALLATION_ID', '88'],
])('never reuses a reader after %s changes', async (name, value) => {
  const reader = await configuredGitHubAppReader(env);
  assert(reader);
  expect(reader.selection).toEqual({
    appClientId: 'Iv1.synthetic',
    installationId: 42,
    selectedRepositoryIds: [123, 456],
  });
  env[name] = value;
  await expect(reader.getRepository(123)).rejects.toMatchObject({ code: 'invalid_configuration' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ['key withdrawal', 'invalid_configuration'],
  ['identity change', 'invalid_configuration'],
  ['selection removal', 'repository_not_selected'],
])('discards a successful response after in-flight %s', async (withdrawal, code) => {
  const reader = await configuredGitHubAppReader(env);
  assert(reader);
  const repository = {
    id: 123,
    full_name: 'private-fixture/selected',
    private: true,
    archived: false,
    default_branch: 'main',
  };
  let markMembershipStarted = () => {};
  const membershipStarted = new Promise<void>((resolve) => {
    markMembershipStarted = resolve;
  });
  let releaseMembership = () => {};
  const holdMembership = new Promise<void>((resolve) => {
    releaseMembership = resolve;
  });
  fetcher
    .mockResolvedValueOnce(
      Response.json(
        {
          token: 'ghs_SYNTHETIC',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          repository_selection: 'selected',
          repositories: [repository],
          permissions: { metadata: 'read' },
        },
        { status: 201 },
      ),
    )
    .mockImplementationOnce(async () => {
      markMembershipStarted();
      await holdMembership;
      return Response.json({ total_count: 1, repositories: [repository] });
    });

  const pending = reader.getRepository(123);
  try {
    await membershipStarted;
    if (withdrawal === 'key withdrawal') await rm(join(directory, 'fixture.pem'));
    if (withdrawal === 'identity change') env.ASSISTANT_GITHUB_APP_INSTALLATION_ID = '88';
    if (withdrawal === 'selection removal') env.ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS = '456';
  } finally {
    releaseMembership();
  }
  await expect(pending).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('exposes the current selection without exposing the signing-key path', () => {
  expect(configuredGitHubAppSelection(env)).toEqual({
    appClientId: 'Iv1.synthetic',
    installationId: 42,
    selectedRepositoryIds: [123, 456],
  });
  env.ASSISTANT_GITHUB_SELECTED_REPOSITORY_IDS = '456';
  expect(configuredGitHubAppSelection(env)?.selectedRepositoryIds).toEqual([456]);
  delete env.ASSISTANT_GITHUB_APP_PRIVATE_KEY_FILE;
  expect(configuredGitHubAppSelection(env)).toBeNull();
});
