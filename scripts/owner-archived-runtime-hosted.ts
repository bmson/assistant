import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadReviewedArchivedRuntimePackAt } from './owner-archived-runtime-input.js';

export const ARCHIVE_BUCKET = 'bmson-assistant-reviewed-release-evidence';
export const ARCHIVE_OBJECT = 'owner-archived-runtime/44263661117/v1.pack';
export const MAX_BUNDLE = 256 * 1024 * 1024;
const HEADER_LIMIT = 32 * 1024;
export const FIXED_METADATA = new Set([
  'oci-layout',
  'index.json',
  'native-binding.json',
  'trusted-root.json',
  ...['agent', 'web'].flatMap((role) =>
    ['parent.json', 'build-receipt.json', 'signature.sigstore.json', 'sbom.sigstore.json'].map(
      (name) => `historical/${role}-${name}`,
    ),
  ),
]);

function check(value: unknown): asserts value {
  if (!value) throw new Error('archived runtime hosted intake rejected');
}

export function verifyArchiveObjectBinding(env: NodeJS.ProcessEnv) {
  const generation = env.OWNER_ARCHIVED_RUNTIME_GENERATION;
  const objectSha256 = env.OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256;
  check(typeof generation === 'string' && /^[1-9][0-9]{0,19}$/.test(generation));
  check(typeof objectSha256 === 'string' && /^[a-f0-9]{64}$/.test(objectSha256));
  return { generation, objectSha256 };
}

type ArchiveMember = { path: string; size: number };

function memberList(bytes: Buffer): ArchiveMember[] {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const header = JSON.parse(source) as { format: unknown; files: unknown };
  check(header && header.format === 1 && Array.isArray(header.files));
  check(header.files.length <= 256);
  const paths = new Set<string>();
  const members = header.files.map((file) => {
    check(file && typeof file === 'object');
    const { path, size } = file;
    check(
      typeof path === 'string' &&
        (FIXED_METADATA.has(path) || /^blobs\/sha256\/[a-f0-9]{64}$/.test(path)),
    );
    check(!paths.has(path) && Number.isSafeInteger(size) && size > 0 && size <= MAX_BUNDLE);
    paths.add(path);
    return { path, size } as ArchiveMember;
  });
  check([...FIXED_METADATA].every((path) => paths.has(path)));
  // Canonical JSON also rejects duplicate keys, extra fields, and ambiguous metadata.
  check(source === JSON.stringify({ format: 1, files: members }));
  return members;
}

export async function unpackArchiveBundle(bundle: string, target: string, byteCount: number) {
  const file = await open(bundle, 'r');
  let members: ArchiveMember[];
  let offset: number;
  try {
    const buffer = Buffer.alloc(HEADER_LIMIT);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    check(newline > 0);
    members = memberList(buffer.subarray(0, newline));
    offset = newline + 1;
    check(members.reduce((size, entry) => size + entry.size, offset) === byteCount);
  } finally {
    await file.close();
  }
  await mkdir(target, { mode: 0o700 });
  for (const { path, size } of members) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await pipeline(
      createReadStream(bundle, { start: offset, end: offset + size - 1 }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    offset += size;
  }
}

async function downloadBundle(
  env: NodeJS.ProcessEnv,
  accessToken: string,
  scratch: string,
  fetcher: typeof fetch,
) {
  const binding = verifyArchiveObjectBinding(env);
  check(/^[A-Za-z0-9._~-]{20,8192}$/.test(accessToken));
  const archive = join(scratch, 'bundle');
  const url = new URL(
    `https://storage.googleapis.com/download/storage/v1/b/${ARCHIVE_BUCKET}/o/${encodeURIComponent(ARCHIVE_OBJECT)}`,
  );
  url.search = new URLSearchParams({
    alt: 'media',
    generation: binding.generation,
    ifGenerationMatch: binding.generation,
  }).toString();
  const signal = AbortSignal.timeout(100_000);
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Encoding': 'identity' },
    redirect: 'error',
    signal,
  });
  check(response.status === 200 && response.body && !response.headers.get('content-encoding'));
  let size = 0;
  const hash = createHash('sha256');
  await pipeline(
    Readable.from(response.body),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_BUNDLE) return callback(new Error('archived runtime bundle size limit'));
        hash.update(chunk);
        return callback(null, chunk);
      },
    }),
    createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  check(hash.digest('hex') === binding.objectSha256);
  return { archive, size, binding };
}

export async function withHostedArchivedRuntimePack<T>(
  env: NodeJS.ProcessEnv,
  accessToken: string,
  consume: (
    pack: Awaited<ReturnType<typeof loadReviewedArchivedRuntimePackAt>>,
    binding: ReturnType<typeof verifyArchiveObjectBinding>,
    directory: string,
  ) => Promise<T>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const runner = env.RUNNER_TEMP;
  check(runner);
  const scratch = await mkdtemp(join(runner, 'owner-archive-intake-'));
  try {
    const { archive, size, binding } = await downloadBundle(env, accessToken, scratch, fetcher);
    const directory = join(scratch, 'pack');
    await unpackArchiveBundle(archive, directory, size);
    return await consume(await loadReviewedArchivedRuntimePackAt(directory), binding, directory);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}
