import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
const CHUNK_BYTES = 64 * 1024;

function components(relativePath: string): string[] {
  if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error('unsafe relative file path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('unsafe relative file path');
  }
  return parts;
}

/**
 * Read a regular file beneath root through directory descriptors. Opening
 * each component with O_NOFOLLOW makes path replacement with a symlink fail
 * without following it; the final descriptor is size-checked and read with a
 * hard byte ceiling (including files that grow after fstat).
 */
export async function readBoundedRegularFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid file byte limit');
  const parts = components(relativePath);
  const canonicalRoot = await realpath(root);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let current = canonicalRoot;
    for (const part of parts.slice(0, -1)) {
      if (signal?.aborted) throw signal.reason ?? new Error('file read cancelled');
      current = path.join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('path contains a non-directory or symbolic link');
      if ((await realpath(current)) !== current)
        throw new Error('path resolves through a symbolic link');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('file read cancelled');
    const target = path.join(current, parts.at(-1) as string);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('expected a regular file');
    file = await open(target, FILE_FLAGS);
    const info = await file.stat();
    if (!info.isFile()) throw new Error('expected a regular file');
    if (info.dev !== before.dev || info.ino !== before.ino)
      throw new Error('file changed while it was being opened');
    const resolved = await realpath(target);
    if (
      resolved !== target ||
      !(resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${path.sep}`))
    )
      throw new Error('file resolves outside the configured root');
    if (info.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      if (signal?.aborted) throw signal.reason ?? new Error('file read cancelled');
      const wanted = Math.min(CHUNK_BYTES, maxBytes + 1 - total);
      if (wanted <= 0) break;
      const chunk = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await file.read(chunk, 0, wanted, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    // Re-check the namespace after reading. The descriptor pins the bytes,
    // while this detects a parent or leaf being swapped during the read.
    const after = await lstat(target);
    const resolvedAfter = await realpath(target);
    if (
      after.isSymbolicLink() ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      resolvedAfter !== target ||
      !(resolvedAfter === canonicalRoot || resolvedAfter.startsWith(`${canonicalRoot}${path.sep}`))
    ) {
      throw new Error('file path changed while it was being read');
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('invalid response byte limit');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('response read cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
    if (signal?.aborted) throw signal.reason ?? new Error('response read cancelled');
    return Buffer.concat(chunks, total);
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
    if (total > maxBytes || signal?.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
