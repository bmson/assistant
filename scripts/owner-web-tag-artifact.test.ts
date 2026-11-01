import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedWebTagArtifactReader,
  readProtectedGitHubTokenFile,
} from './owner-web-tag-artifact.js';

const runId = 123456789;
const attempt = 1;
const source = 'a'.repeat(40);
const token = 'ghs_secret_token_for_test';
const archive = Buffer.from('bounded test archive bytes');
const artifactName = `owner-web-tag-creation-${source}-${runId}-${attempt}`;
const tempDirs: string[] = [];

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
function baseFixture(options: { archiveBytes?: Uint8Array; artifacts?: unknown[] } = {}) {
  const bytes = Buffer.from(options.archiveBytes ?? archive);
  const run = {
    id: runId,
    run_attempt: attempt,
    head_sha: source,
    repository: { full_name: 'bmson/assistant' },
    head_repository: { full_name: 'bmson/assistant' },
    path: '.github/workflows/deploy.yml',
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
  };
  const artifact = {
    id: 987,
    name: artifactName,
    expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size_in_bytes: bytes.byteLength,
    workflow_run: { id: runId, head_sha: source },
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith(`/attempts/${attempt}`))
      return json(run);
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith('/artifacts'))
      return json({ artifacts: options.artifacts ?? [artifact] });
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith('/zip'))
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://productionresultssa0.blob.core.windows.net/a/zip' },
      });
    if (parsed.hostname === 'productionresultssa0.blob.core.windows.net')
      return new Response(bytes, { status: 200 });
    throw new Error(`Unexpected request with ${token}`);
  };
  const read = createProtectedWebTagArtifactReader({ token, request });
  return { read, calls, artifact, run, bytes };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('protected web-tag artifact transport', () => {
  it('reads exact run metadata and one digest-bound archive; never forwards auth to blob storage', async () => {
    const f = baseFixture();
    const result = await f.read(runId, attempt);
    expect(result.runMetadata).toEqual(f.run);
    expect(result.artifactMetadata).toEqual(f.artifact);
    expect(result.archiveBytes).toEqual(archive);
    expect(f.calls).toHaveLength(4);
    for (const call of f.calls.slice(0, 3)) {
      expect(new URL(call.url).origin).toBe('https://api.github.com');
      expect(new Headers(call.init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    }
    const [redirect, blob] = f.calls.slice(2);
    expect(redirect?.init.redirect).toBe('manual');
    expect(blob?.init.redirect).toBe('error');
    expect(new Headers(blob?.init.headers).has('Authorization')).toBe(false);
  });

  it('supports fractional monotonic-clock remainder without an invalid AbortSignal timeout', async () => {
    const f = baseFixture();
    let clock = 0.5;
    const read = createProtectedWebTagArtifactReader({
      token,
      now: () => {
        const instant = clock;
        clock += 0.25;
        return instant;
      },
      request: async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.github.com') clock += 14_999.99;
        if (url.pathname.includes('/attempts/')) return json(f.run);
        if (url.pathname.endsWith('/artifacts')) return json({ artifacts: [f.artifact] });
        if (url.pathname.endsWith('/zip'))
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://productionresultssa0.blob.core.windows.net/archive' },
          });
        return new Response(f.bytes, { status: 200 });
      },
    });
    expect((await read(runId, attempt)).archiveBytes).toEqual(f.bytes);
    expect(clock).toBeGreaterThan(45_000);
    expect(clock).toBeLessThan(60_000);
  });

  it.each([
    ['non-GitHub blob host', 'https://evil.example/archive.zip'],
    ['HTTP blob URL', 'http://productionresultssa0.blob.core.windows.net/archive.zip'],
    ['unrecognized Azure host', 'https://productionresultssa.blob.core.windows.net/archive.zip'],
    [
      'blob URL with credentials',
      'https://user:pass@productionresultssa0.blob.core.windows.net/archive.zip',
    ],
    [
      'blob URL with custom port',
      'https://productionresultssa0.blob.core.windows.net:444/archive.zip',
    ],
  ])('rejects %s before making an unauthenticated blob request', async (_name, location) => {
    const f = baseFixture();
    const original = f.read;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const read = createProtectedWebTagArtifactReader({
      token,
      request: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        const parsed = new URL(url);
        if (parsed.pathname.endsWith(`/attempts/${attempt}`)) return json(f.run);
        if (parsed.pathname.endsWith('/artifacts')) return json({ artifacts: [f.artifact] });
        if (parsed.pathname.endsWith('/zip'))
          return new Response(null, { status: 302, headers: { Location: location } });
        return new Response(archive, { status: 200 });
      },
    });
    await expect(read(runId, attempt)).rejects.toThrow('Artifact download host is not allowed');
    expect(calls).toHaveLength(3);
    expect(original).toBeTypeOf('function');
  });

  it('rejects any redirect from the approved blob host', async () => {
    const f = baseFixture();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const read = createProtectedWebTagArtifactReader({
      token,
      request: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes('/attempts/')) return json(f.run);
        if (url.includes('/artifacts?')) return json({ artifacts: [f.artifact] });
        if (url.endsWith('/zip'))
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://productionresultssa0.blob.core.windows.net/a' },
          });
        return new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } });
      },
    });
    await expect(read(runId, attempt)).rejects.toThrow();
    expect(calls[3]?.init.redirect).toBe('error');
    expect(new Headers(calls[3]?.init.headers).has('Authorization')).toBe(false);
  });

  it('rejects malformed run identities, missing or duplicate artifacts, and digest mismatch', async () => {
    const readInvalidRun = createProtectedWebTagArtifactReader({
      token,
      request: async () => {
        return json({ id: runId, run_attempt: 2, head_sha: source });
      },
    });
    await expect(readInvalidRun(runId, attempt)).rejects.toThrow(
      'Protected creation run identity mismatch',
    );

    await expect(baseFixture({ artifacts: [] }).read(runId, attempt)).rejects.toThrow(
      'Creation artifact missing or ambiguous',
    );
    const wrongWorkflowRun = baseFixture({
      artifacts: [{ ...baseFixture().artifact, workflow_run: { id: runId + 1, head_sha: source } }],
    });
    await expect(wrongWorkflowRun.read(runId, attempt)).rejects.toThrow();
    const duplicate = baseFixture({ artifacts: [baseFixture().artifact, baseFixture().artifact] });
    await expect(duplicate.read(runId, attempt)).rejects.toThrow(
      'Creation artifact missing or ambiguous',
    );

    const wrongDigest = baseFixture();
    await expect(
      createProtectedWebTagArtifactReader({
        token,
        request: async (input) => {
          const url = String(input);
          if (url.includes('/attempts/')) return json(wrongDigest.run);
          if (url.includes('/artifacts?'))
            return json({
              artifacts: [{ ...wrongDigest.artifact, digest: `sha256:${'0'.repeat(64)}` }],
            });
          if (url.endsWith('/zip'))
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://productionresultssa0.blob.core.windows.net/a' },
            });
          return new Response(archive, { status: 200 });
        },
      })(runId, attempt),
    ).rejects.toThrow('Creation artifact archive digest or size mismatch');
  });

  it('caps metadata and archive body sizes', async () => {
    const f = baseFixture();
    const hugeMetadata = createProtectedWebTagArtifactReader({
      token,
      request: async () => new Response('x'.repeat(512 * 1024 + 1), { status: 200 }),
    });
    await expect(hugeMetadata(runId, attempt)).rejects.toThrow();

    const oversizedArchive = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    await expect(
      createProtectedWebTagArtifactReader({
        token,
        request: async (input) => {
          const url = String(input);
          if (url.includes('/attempts/')) return json(f.run);
          if (url.includes('/artifacts?'))
            return json({
              artifacts: [
                {
                  ...f.artifact,
                  size_in_bytes: oversizedArchive.length,
                  digest: `sha256:${createHash('sha256').update(oversizedArchive).digest('hex')}`,
                },
              ],
            });
          if (url.endsWith('/zip'))
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://productionresultssa0.blob.core.windows.net/a' },
            });
          return new Response(oversizedArchive, { status: 200 });
        },
      })(runId, attempt),
    ).rejects.toThrow();
  });

  it('bounds listing pagination and the shared read deadline', async () => {
    let pages = 0;
    const tooManyPages = createProtectedWebTagArtifactReader({
      token,
      request: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/attempts/'))
          return json({
            id: runId,
            run_attempt: attempt,
            head_sha: source,
            repository: { full_name: 'bmson/assistant' },
            head_repository: { full_name: 'bmson/assistant' },
            path: '.github/workflows/deploy.yml',
          });
        pages++;
        return json({ artifacts: Array.from({ length: 100 }, () => ({})) });
      },
    });
    await expect(tooManyPages(runId, attempt)).rejects.toThrow(
      'Creation artifact missing or ambiguous',
    );
    expect(pages).toBe(8);

    let clock = 0;
    let requests = 0;
    const timedReader = createProtectedWebTagArtifactReader({
      token,
      now: () => clock,
      request: async () => {
        requests++;
        clock = 60_001;
        return json({
          id: runId,
          run_attempt: attempt,
          head_sha: source,
          repository: { full_name: 'bmson/assistant' },
          head_repository: { full_name: 'bmson/assistant' },
          path: '.github/workflows/deploy.yml',
        });
      },
    });
    await expect(timedReader(runId, attempt)).rejects.toThrow(
      'Protected artifact read exceeded its time bound',
    );
    expect(requests).toBe(1);
  });

  it('uses sanitized failures and refuses token files with unsafe permissions or symlinks', () => {
    const secretFailure = createProtectedWebTagArtifactReader({
      token,
      request: async () => {
        throw new Error(`request failed with ${token}`);
      },
    });
    return expect(secretFailure(runId, attempt))
      .rejects.toThrow('Protected creation artifact read unavailable')
      .then(() => {
        const directory = mkdtempSync(join(tmpdir(), 'web-tag-token-'));
        tempDirs.push(directory);
        const secure = join(directory, 'secure-token');
        writeFileSync(secure, `${token}\n`, { mode: 0o600 });
        expect(readProtectedGitHubTokenFile(secure)).toBe(token);
        const open = join(directory, 'open-token');
        writeFileSync(open, token, { mode: 0o644 });
        chmodSync(open, 0o644);
        expect(() => readProtectedGitHubTokenFile(open)).toThrow(
          'Invalid protected GitHub token file',
        );
        const link = join(directory, 'token-link');
        symlinkSync(secure, link);
        expect(() => readProtectedGitHubTokenFile(link)).toThrow();
        expect(() => readProtectedGitHubTokenFile(join(directory, 'missing'))).toThrow();
      });
  });
});
