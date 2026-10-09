import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ requireOwner: vi.fn() }));

import type { WebFetchResponse } from '@assistant/application/public-web';
import { createCardImageHandler } from './handler.js';

function upstream(
  chunks: Uint8Array[] = [Buffer.from('png')],
  options: {
    status?: number;
    contentType?: string;
    contentEncoding?: string;
    contentLength?: string;
    fail?: boolean;
  } = {},
): WebFetchResponse & { cancel: ReturnType<typeof vi.fn<() => void>> } {
  return {
    status: options.status ?? 200,
    headers: {
      contentType: options.contentType ?? 'image/png',
      contentEncoding: options.contentEncoding ?? '',
      contentLength: options.contentLength,
    },
    body: (async function* () {
      if (options.fail) throw new Error('socket reset');
      yield* chunks;
    })(),
    cancel: vi.fn<() => void>(),
  };
}

function request(url = 'https://assets.example/image.png') {
  return new Request(`https://assistant.test/api/card-image?url=${encodeURIComponent(url)}`);
}

function handler(
  fetchPublic: (
    url: string,
    signal: AbortSignal,
    headers: Record<string, string>,
  ) => Promise<WebFetchResponse>,
  timeoutMs?: number,
) {
  return createCardImageHandler({
    requireOwner: async () => undefined,
    fetchPublic,
    timeoutMs,
  });
}

describe('card image proxy', () => {
  it('requests the image through the public pinned transport without forwarding credentials', async () => {
    const response = upstream();
    const fetchPublic = vi.fn(
      async (_url: string, _signal: AbortSignal, _headers: Record<string, string>) => response,
    );
    const result = await handler(fetchPublic)(request());

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([112, 110, 103]));
    expect(fetchPublic).toHaveBeenCalledOnce();
    expect(fetchPublic.mock.calls[0]?.[0]).toBe('https://assets.example/image.png');
    expect(fetchPublic.mock.calls[0]?.[2]).toEqual({
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
    });
  });

  it.each([
    'http://assets.example/image.png',
    'https://user:secret@assets.example/image.png',
    'https://assets.example:443/image.png',
    'https://assets.example:8443/image.png',
  ])('rejects unsafe URL authority %s before connecting', async (url) => {
    const fetchPublic = vi.fn(
      async (_url: string, _signal: AbortSignal, _headers: Record<string, string>) => upstream(),
    );
    expect((await handler(fetchPublic)(request(url))).status).toBe(400);
    expect(fetchPublic).not.toHaveBeenCalled();
  });

  it('rejects redirects and never follows their location', async () => {
    const response = upstream([], { status: 302 });
    const fetchPublic = vi.fn(
      async (_url: string, _signal: AbortSignal, _headers: Record<string, string>) => response,
    );
    expect((await handler(fetchPublic)(request())).status).toBe(502);
    expect(fetchPublic).toHaveBeenCalledOnce();
    expect(response.cancel).toHaveBeenCalledOnce();
  });

  it('rejects unsupported MIME types and compressed bodies', async () => {
    const html = upstream([], { contentType: 'text/html' });
    const getHtml = vi.fn(
      async (_url: string, _signal: AbortSignal, _headers: Record<string, string>) => html,
    );
    expect((await handler(getHtml)(request())).status).toBe(415);
    expect(html.cancel).toHaveBeenCalledOnce();

    const compressed = upstream([], { contentEncoding: 'gzip' });
    const getCompressed = vi.fn(
      async (_url: string, _signal: AbortSignal, _headers: Record<string, string>) => compressed,
    );
    expect((await handler(getCompressed)(request())).status).toBe(415);
    expect(compressed.cancel).toHaveBeenCalledOnce();
  });

  it('cancels a chunked body immediately after the actual bytes exceed 5 MiB', async () => {
    const response = upstream([new Uint8Array(5 * 1024 * 1024 + 1)]);
    const fetchPublic = vi.fn(
      async (_url: string, _signal: AbortSignal, _headers: Record<string, string>) => response,
    );
    expect((await handler(fetchPublic)(request())).status).toBe(413);
    expect(response.cancel).toHaveBeenCalledOnce();
  });

  it('counts actual bytes even when the declared length is understated', async () => {
    const response = upstream([new Uint8Array(5 * 1024 * 1024 + 1)], { contentLength: '3' });
    expect((await handler(async () => response)(request())).status).toBe(413);
    expect(response.cancel).toHaveBeenCalledOnce();
  });

  it('maps body stream failures to a controlled gateway response', async () => {
    const response = upstream([], { fail: true });
    expect((await handler(async () => response)(request())).status).toBe(502);
  });

  it('applies a deadline signal to the upstream request', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchPublic = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<WebFetchResponse>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
        }),
    );

    expect((await handler(fetchPublic, 5)(request())).status).toBe(502);
    expect(observedSignal?.aborted).toBe(true);
  });
});
