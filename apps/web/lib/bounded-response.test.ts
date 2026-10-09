import { describe, expect, it } from 'vitest';
import { readBoundedResponseBody } from './bounded-response.js';

describe('readBoundedResponseBody', () => {
  it('returns the streamed bytes when within the limit', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    await expect(readBoundedResponseBody(response, 3)).resolves.toMatchObject({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  it('rejects a lying content length and cancels a chunked overflow', async () => {
    const declared = new Response(new Uint8Array([1]), {
      headers: { 'content-length': '10' },
    });
    await expect(readBoundedResponseBody(declared, 2)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });

    let cancelled = false;
    const chunked = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readBoundedResponseBody(chunked, 2)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(cancelled).toBe(true);
  });

  it('maps a broken upstream stream to a bounded read failure', async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('upstream broke'));
        },
      }),
    );
    await expect(readBoundedResponseBody(response, 10)).resolves.toEqual({
      ok: false,
      reason: 'read-failed',
    });
  });
});
