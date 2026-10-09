import { describe, expect, it } from 'vitest';
import { readBoundedBytes, readBoundedFormData, readBoundedJson } from './http-body.js';

function streamedRequest(input: {
  chunks: Uint8Array[];
  headers?: Record<string, string>;
  cancel?: () => void | Promise<void>;
  start?: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
}) {
  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: input.headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (input.start) input.start(controller);
        else {
          for (const chunk of input.chunks) controller.enqueue(chunk);
          controller.close();
        }
      },
      cancel: input.cancel,
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('bounded HTTP body readers', () => {
  it('parses multipart data only after the complete aggregate body fits the bound', async () => {
    const body = new FormData();
    body.set('title', 'plan');
    body.set('file', new File(['archive contents'], 'notes.txt', { type: 'text/plain' }));
    const request = new Request('http://localhost/upload', { method: 'POST', body });
    const result = await readBoundedFormData(request, 4096);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.get('title')).toBe('plan');
      expect(result.value.get('file')).toMatchObject({ name: 'notes.txt', size: 16 });
    }
  });

  it('rejects a declared overage before reading even when the actual stream is short', async () => {
    let cancelled = false;
    const request = streamedRequest({
      chunks: [new TextEncoder().encode('tiny')],
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '100' },
      cancel: () => {
        cancelled = true;
      },
    });
    await expect(readBoundedFormData(request, 10)).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
    expect(cancelled).toBe(true);
  });

  it('counts aggregate multipart fields and file bytes when length is short or absent', async () => {
    const payload = new TextEncoder().encode(
      '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\n' +
        'a'.repeat(60) +
        '\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\n' +
        'small\r\n--x--\r\n',
    );
    const headerCases: Array<Record<string, string>> = [
      { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1' },
      { 'content-type': 'multipart/form-data; boundary=x' },
    ];
    for (const headers of headerCases) {
      const result = await readBoundedFormData(streamedRequest({ chunks: [payload], headers }), 32);
      expect(result).toMatchObject({ ok: false, status: 413 });
    }
  });

  it('times out and returns promptly when stream cancellation does not settle', async () => {
    const request = streamedRequest({
      chunks: [],
      start() {},
      cancel: () => new Promise<void>(() => {}),
    });
    await expect(readBoundedFormData(request, 1024, 5)).resolves.toMatchObject({
      ok: false,
      status: 408,
    });
  });

  it('keeps cancellation non-blocking after streamed overflow', async () => {
    const request = streamedRequest({
      chunks: [new Uint8Array(100)],
      cancel: () => new Promise<void>(() => {}),
    });
    await expect(readBoundedBytes(request, 4, 100)).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it('preserves strict UTF-8 and JSON validation through the shared byte reader', async () => {
    await expect(
      readBoundedJson(
        new Request('http://localhost', {
          method: 'POST',
          body: new Uint8Array([0xff]),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      readBoundedJson(new Request('http://localhost', { method: 'POST', body: '{' })),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });
});
