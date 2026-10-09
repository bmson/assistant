import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBoundedRegularFile, readBoundedResponse } from './safe-file.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-runner-safe-file-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded descriptor reads', () => {
  it('reads only regular files below the configured root and enforces the byte cap', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'small.txt'), 'safe');
    await expect(readBoundedRegularFile(root, 'small.txt', 4)).resolves.toEqual(
      Buffer.from('safe'),
    );

    await writeFile(path.join(root, 'large.txt'), '12345');
    await expect(readBoundedRegularFile(root, 'large.txt', 4)).rejects.toThrow(/exceeds 4 bytes/);
  });

  it('rejects final and parent symlinks instead of following them', async () => {
    const root = await tempRoot();
    const outside = path.join(root, 'outside');
    const outsideDirectory = path.join(root, 'outside-dir');
    const inside = path.join(root, 'inside');
    await mkdir(outsideDirectory);
    await mkdir(inside);
    await writeFile(outside, 'secret');
    await writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret');
    await symlink(outside, path.join(inside, 'final-link'));
    await symlink(outsideDirectory, path.join(inside, 'parent-link'));

    await expect(readBoundedRegularFile(inside, 'final-link', 100)).rejects.toThrow();
    await expect(readBoundedRegularFile(inside, 'parent-link/secret.txt', 100)).rejects.toThrow();
  });

  it('caps streamed HTTP bodies without trusting Content-Length', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(3));
          controller.enqueue(new Uint8Array(3));
          controller.close();
        },
      }),
    );
    await expect(readBoundedResponse(response, 4)).rejects.toThrow(/exceeds 4 bytes/);
  });

  it('cancels an in-progress HTTP body read when its signal aborts', async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array([1]));
        },
      }),
    );
    const reading = readBoundedResponse(response, 10, controller.signal);
    controller.abort(new Error('test cancellation'));
    await expect(reading).rejects.toThrow(/test cancellation/);
  });
});
