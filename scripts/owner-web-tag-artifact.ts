/** Fixed-origin, bounded reader for protected web-tag creation artifacts. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

const API_ROOT = 'https://api.github.com';
const REPOSITORY = 'bmson/assistant';
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const TOTAL_BUDGET_MS = 60_000;
const REQUEST_BUDGET_MS = 15_000;
const TOKEN_FILE = 'owner-web-tag-github-token';
const BLOB_HOST = /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;

function fail(message = 'Protected creation artifact read unavailable'): never {
  throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('Invalid artifact metadata');
  return value as Record<string, unknown>;
}
function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_METADATA_BYTES)
    return fail('Artifact metadata exceeds its bound');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('Invalid artifact metadata');
  }
}
async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return fail('Artifact response body missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) return fail('Artifact response exceeds its bound');
      chunks.push(part.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return fail();
  }
  return Buffer.concat(chunks, size);
}

export interface ProtectedArtifactReaderOptions {
  token: string;
  request?: typeof fetch;
  now?: () => number;
}

/** Injection seam for offline contract tests; production supplies only the token. */
export function createProtectedWebTagArtifactReader({
  token,
  request = fetch,
  now = () => performance.now(),
}: ProtectedArtifactReaderOptions) {
  if (!/^[A-Za-z0-9_]{1,4096}$/.test(token)) throw new Error('Invalid protected GitHub token');

  return async function readProtectedWebTagArtifact(runId: number, attempt: number) {
    if (
      !safePositiveInteger(runId) ||
      !safePositiveInteger(attempt) ||
      `${runId}-${attempt}`.length > 21
    )
      return fail('Invalid protected creation run');
    const deadline = now() + TOTAL_BUDGET_MS;
    async function fetchWithinBudget(url: string, init: RequestInit, limit: number) {
      const remaining = Math.min(REQUEST_BUDGET_MS, deadline - now());
      if (remaining <= 0) return fail('Protected artifact read exceeded its time bound');
      let response: Response;
      try {
        response = await request(url, { ...init, signal: AbortSignal.timeout(remaining) });
      } catch {
        return fail();
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return fail();
      }
      return readBoundedBody(response, limit);
    }
    async function fetchMetadata(path: string) {
      return fetchWithinBudget(
        `${API_ROOT}${path}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'error',
        },
        MAX_METADATA_BYTES,
      );
    }

    const runPath = `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`;
    const runMetadata = record(parseJson(await fetchMetadata(runPath)));
    if (
      runMetadata.id !== runId ||
      runMetadata.run_attempt !== attempt ||
      typeof runMetadata.head_sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(runMetadata.head_sha) ||
      record(runMetadata.repository).full_name !== REPOSITORY ||
      record(runMetadata.head_repository).full_name !== REPOSITORY ||
      runMetadata.path !== '.github/workflows/deploy.yml'
    )
      return fail('Protected creation run identity mismatch');
    const expectedName = `owner-web-tag-creation-${runMetadata.head_sha}-${runId}-${attempt}`;
    const matches: Record<string, unknown>[] = [];
    let complete = false;
    for (let page = 1; page <= 8; page++) {
      const path = `/repos/${REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`;
      const list = record(parseJson(await fetchMetadata(path)));
      if (!Array.isArray(list.artifacts) || list.artifacts.length > 100)
        return fail('Invalid creation artifact listing');
      for (const item of list.artifacts) {
        const metadata = record(item);
        if (metadata.name === expectedName) matches.push(metadata);
      }
      if (list.artifacts.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete || matches.length !== 1) return fail('Creation artifact missing or ambiguous');
    const artifactMetadata = matches[0];
    if (
      !artifactMetadata ||
      record(artifactMetadata.workflow_run).id !== runId ||
      record(artifactMetadata.workflow_run).head_sha !== runMetadata.head_sha ||
      !safePositiveInteger(artifactMetadata.id) ||
      artifactMetadata.expired !== false ||
      !safePositiveInteger(artifactMetadata.size_in_bytes) ||
      artifactMetadata.size_in_bytes > MAX_ARCHIVE_BYTES ||
      typeof artifactMetadata.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(artifactMetadata.digest)
    )
      return fail('Invalid creation artifact identity');

    const downloadPath = `/repos/${REPOSITORY}/actions/artifacts/${artifactMetadata.id}/zip`;
    const remaining = Math.min(REQUEST_BUDGET_MS, deadline - now());
    if (remaining <= 0) return fail('Protected artifact read exceeded its time bound');
    let redirect: Response;
    try {
      redirect = await request(`${API_ROOT}${downloadPath}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
      });
    } catch {
      return fail();
    }
    await redirect.body?.cancel().catch(() => undefined);
    if (redirect.status !== 302 && redirect.status !== 303)
      return fail('Artifact download redirect missing');
    const location = redirect.headers.get('location');
    if (!location) return fail('Artifact download location missing');
    let blobUrl: URL;
    try {
      blobUrl = new URL(location);
    } catch {
      return fail('Artifact download location invalid');
    }
    if (
      blobUrl.protocol !== 'https:' ||
      !BLOB_HOST.test(blobUrl.hostname) ||
      blobUrl.username !== '' ||
      blobUrl.password !== '' ||
      blobUrl.port !== '' ||
      blobUrl.hash !== ''
    )
      return fail('Artifact download host is not allowed');
    const archiveBytes = await fetchWithinBudget(
      blobUrl.href,
      { method: 'GET', redirect: 'error' },
      MAX_ARCHIVE_BYTES,
    );
    if (
      archiveBytes.byteLength !== artifactMetadata.size_in_bytes ||
      artifactMetadata.digest !== `sha256:${sha256(archiveBytes)}`
    )
      return fail('Creation artifact archive digest or size mismatch');
    return { runMetadata, artifactMetadata, archiveBytes };
  };
}

/** Read the ephemeral token from its fixed private runner-temp file; never from process env. */
export function readProtectedGitHubTokenFile(file: string): string {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(file);
  } catch {
    return fail('Protected GitHub token file unavailable');
  }
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600)
    return fail('Invalid protected GitHub token file');
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail('Protected GitHub token file unavailable');
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 8192)
      return fail('Invalid protected GitHub token file');
    const bytes = Buffer.alloc(8193);
    let length = 0;
    try {
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
    } catch {
      return fail('Protected GitHub token file unavailable');
    }
    if (length > 8192) return fail('Invalid protected GitHub token file');
    const token = bytes.subarray(0, length).toString('utf8').trim();
    if (!/^[A-Za-z0-9_]{1,4096}$/.test(token)) return fail('Invalid protected GitHub token file');
    return token;
  } finally {
    closeSync(descriptor);
  }
}

/** Production API is fixed: no caller-selected host, token source, request or redirect policy. */
export async function readProtectedWebTagArtifact(runId: number, attempt: number) {
  if (!process.env.RUNNER_TEMP) throw new Error('Protected temporary directory unavailable');
  const tokenPath = resolve(process.env.RUNNER_TEMP, TOKEN_FILE);
  return createProtectedWebTagArtifactReader({ token: readProtectedGitHubTokenFile(tokenPath) })(
    runId,
    attempt,
  );
}
