import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_BUCKET,
  ARCHIVE_OBJECT,
  withHostedArchivedRuntimePack,
} from './owner-archived-runtime-hosted.js';

vi.mock('./owner-archived-runtime-input.js', () => ({
  loadReviewedArchivedRuntimePackAt: vi.fn(),
}));

import { loadReviewedArchivedRuntimePackAt } from './owner-archived-runtime-input.js';

const roles = ['agent', 'web'];
const firstPath = 'oci-layout';
const paths = [
  firstPath,
  'index.json',
  'native-binding.json',
  'trusted-root.json',
  ...roles.flatMap((role) =>
    ['parent.json', 'build-receipt.json', 'signature.sigstore.json', 'sbom.sigstore.json'].map(
      (name) => `historical/${role}-${name}`,
    ),
  ),
];

function archive(names = paths) {
  return Buffer.from(
    JSON.stringify({ format: 1, files: names.map((path) => ({ path, size: 1 })) }) +
      '\n' +
      'a'.repeat(names.length),
  );
}

let temp: string;
const token = 'a'.repeat(32);
function env(bytes: Buffer) {
  return {
    RUNNER_TEMP: temp,
    OWNER_ARCHIVED_RUNTIME_GENERATION: '9007199254740997',
    OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256: createHash('sha256').update(bytes).digest('hex'),
  };
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'hosted-runtime-test-'));
  vi.resetAllMocks();
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('hosted archive intake', () => {
  it('downloads only the fixed generation and verifies before producing a bounded result', async () => {
    const bytes = archive();
    const fetcher = vi.fn(async () => new Response(new Uint8Array(bytes)));
    const verify = vi.mocked(loadReviewedArchivedRuntimePackAt);
    verify.mockImplementation(async (directory) => {
      expect(await readFile(join(directory, firstPath), 'utf8')).toBe('a');
      return { sha256: 'checked' } as Awaited<ReturnType<typeof verify>>;
    });
    const result = await withHostedArchivedRuntimePack(
      env(bytes),
      token,
      async (pack, binding) => ({ sha: pack.sha256, ...binding }),
      fetcher,
    );
    expect(result).toEqual({
      generation: '9007199254740997',
      objectSha256: env(bytes).OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256,
      sha: 'checked',
    });
    const firstCall = (fetcher.mock.calls as unknown as [URL, RequestInit][])[0];
    if (!firstCall) throw new Error('missing intake request');
    const [url, request] = firstCall;
    expect(url.origin).toBe('https://storage.googleapis.com');
    expect(url.pathname).toBe(
      `/download/storage/v1/b/${ARCHIVE_BUCKET}/o/${encodeURIComponent(ARCHIVE_OBJECT)}`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      alt: 'media',
      generation: '9007199254740997',
      ifGenerationMatch: '9007199254740997',
    });
    expect(request).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(await readdir(temp)).toEqual([]);
  });

  it.each([
    'invalid-generation',
    'redirect',
    'wrong-hash',
    'duplicate-member',
    'traversal',
    'trailing',
  ] as const)('rejects %s without reaching the verifier or observer', async (failure) => {
    const bytes =
      failure === 'duplicate-member'
        ? archive([...paths, firstPath])
        : failure === 'traversal'
          ? archive([...paths, '../outside'])
          : failure === 'trailing'
            ? Buffer.concat([archive(), Buffer.from('trailing')])
            : archive();
    const settings = env(bytes);
    if (failure === 'invalid-generation') settings.OWNER_ARCHIVED_RUNTIME_GENERATION = '0';
    if (failure === 'wrong-hash') settings.OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256 = '0'.repeat(64);
    const fetcher = vi.fn(async () =>
      failure === 'redirect'
        ? new Response(null, { status: 302 })
        : new Response(new Uint8Array(bytes)),
    );
    const observe = vi.fn();
    await expect(
      withHostedArchivedRuntimePack(settings, token, observe, fetcher),
    ).rejects.toThrow();
    if (failure === 'invalid-generation') expect(fetcher).not.toHaveBeenCalled();
    expect(loadReviewedArchivedRuntimePackAt).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(await readdir(temp)).toEqual([]);
  });

  it('removes the staged archive even if signature verification rejects', async () => {
    const bytes = archive();
    vi.mocked(loadReviewedArchivedRuntimePackAt).mockRejectedValueOnce(
      new Error('signature rejected'),
    );
    const observe = vi.fn();
    await expect(
      withHostedArchivedRuntimePack(
        env(bytes),
        token,
        observe,
        async () => new Response(new Uint8Array(bytes)),
      ),
    ).rejects.toThrow('signature rejected');
    expect(observe).not.toHaveBeenCalled();
    expect(await readdir(temp)).toEqual([]);
  });
});
