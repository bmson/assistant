import { describe, expect, it } from 'vitest';
import { readBoundedJson } from './bounded-json.js';

describe('readBoundedJson', () => {
  it('reads valid JSON within the limit', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save' }),
    });
    await expect(readBoundedJson(request)).resolves.toEqual({
      ok: true,
      value: { action: 'save' },
    });
  });

  it('rejects declared and streamed bodies over the limit', async () => {
    const declared = new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-length': '20' },
      body: '{}',
    });
    await expect(readBoundedJson(declared, 4)).resolves.toMatchObject({ ok: false, status: 413 });

    const streamed = new Request('http://localhost', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"x":"long"}'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBoundedJson(streamed, 4)).resolves.toMatchObject({ ok: false, status: 413 });
  });

  it('rejects malformed JSON and invalid UTF-8', async () => {
    await expect(
      readBoundedJson(new Request('http://localhost', { method: 'POST', body: '{' })),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    const invalid = new Request('http://localhost', {
      method: 'POST',
      body: new Uint8Array([0xff]),
    });
    await expect(readBoundedJson(invalid)).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('cancels a slow request body at the time bound', async () => {
    let cancelled = false;
    const request = new Request('http://localhost', {
      method: 'POST',
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBoundedJson(request, 1024, 5)).resolves.toMatchObject({
      ok: false,
      status: 408,
    });
    expect(cancelled).toBe(true);
  });
});

it.each(['timeout', 'declared', 'streamed'] as const)(
  'returns promptly when %s cancellation never resolves',
  async (mode) => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: mode === 'declared' ? { 'content-length': '100' } : undefined,
      body: new ReadableStream({
        start(controller) {
          if (mode === 'streamed') controller.enqueue(new Uint8Array(100));
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBoundedJson(request, 4, 5)).resolves.toMatchObject({
      ok: false,
      status: mode === 'timeout' ? 408 : 413,
    });
  },
);

it('rejects an empty body instead of treating it as an empty object', async () => {
  await expect(
    readBoundedJson(new Request('http://localhost', { method: 'POST', body: '' })),
  ).resolves.toMatchObject({ ok: false, status: 400 });
});
