import { describe, expect, it, vi } from 'vitest';
import {
  AmbiguousGoogleMutationError,
  buildRawEmail,
  collectGmailAttachments,
  GoogleApiError,
  GoogleClient,
} from './client.js';

const API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function tokenResponse(token = 'access-token'): Response {
  return Response.json({ access_token: token, expires_in: 3600 });
}

function clientWith(
  fetchMock: typeof globalThis.fetch,
  options: {
    maxRetries?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    maxResponseBytes?: number;
  } = {},
) {
  return new GoogleClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    fetch: fetchMock,
    retryBaseDelayMs: 10,
    ...options,
  });
}

describe('GoogleClient resilience', () => {
  it('encrypts opaque cursors and rejects tampered or differently configured tokens', () => {
    const client = clientWith(vi.fn());
    const token = client.signOpaqueToken('cursor payload with calendar event details');
    const [version, nonce, ciphertext, tag] = token.split('.');
    const tampered = `${version}.${nonce}.${ciphertext}.${tag?.[0] === 'a' ? 'b' : 'a'}${tag?.slice(1)}`;

    expect(token).not.toContain('cursor payload');
    expect(client.verifyOpaqueToken(token)).toBe('cursor payload with calendar event details');
    expect(client.verifyOpaqueToken(tampered)).toBeNull();
    expect(
      new GoogleClient({
        clientId: 'different-client',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      }).verifyOpaqueToken(token),
    ).toBeNull();
  });

  it('retries safe reads on network errors, 429, and transient 5xx with bounded delays', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      )
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ historyId: '42' }));
    const client = clientWith(fetchMock, { maxRetries: 3, sleep });

    await expect(client.api<{ historyId: string }>(API_URL)).resolves.toEqual({ historyId: '42' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 2000, 40]);
  });

  it('retries refresh-token requests on ambiguous and transient failures', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('token network failure'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = clientWith(fetchMock, { maxRetries: 2, sleep });

    await expect(client.api(API_URL)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
  });

  it('does not retry a mutation after an ambiguous 5xx response', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('uncertain', { status: 503 }));
    const client = clientWith(fetchMock, { maxRetries: 3, sleep });

    await expect(
      client.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw: 'email' }),
      }),
    ).rejects.toBeInstanceOf(AmbiguousGoogleMutationError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry mutations after a 429 or ambiguous network failure', async () => {
    const rateLimitedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const rateLimitedClient = clientWith(rateLimitedFetch, { maxRetries: 3 });
    await expect(
      rateLimitedClient.api('https://calendar.googleapis.com/calendar/v3/calendars/me/events', {
        method: 'POST',
        body: JSON.stringify({ summary: 'Meeting' }),
      }),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(rateLimitedFetch).toHaveBeenCalledTimes(2);

    const networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new TypeError('connection reset'));
    const networkClient = clientWith(networkFetch, { maxRetries: 3 });
    await expect(
      networkClient.api('https://calendar.googleapis.com/calendar/v3/calendars/me/events', {
        method: 'POST',
        body: JSON.stringify({ summary: 'Meeting' }),
      }),
    ).rejects.toThrow('connection reset');
    expect(networkFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a definitively rejected mutation once after refreshing a 401 token', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse('old-token'))
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(tokenResponse('new-token'))
      .mockResolvedValueOnce(Response.json({ id: 'sent-id' }));
    const client = clientWith(fetchMock);

    await expect(
      client.api<{ id: string }>('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw: 'email' }),
      }),
    ).resolves.toEqual({ id: 'sent-id' });
    const sentHeaders = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sentHeaders[1]?.get('authorization')).toBe('Bearer old-token');
    expect(sentHeaders[3]?.get('authorization')).toBe('Bearer new-token');
  });

  it('bounds the whole request at the configured timeout', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementationOnce((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      });
    const client = clientWith(fetchMock, { maxRetries: 0, timeoutMs: 5 });

    await expect(client.api(API_URL)).rejects.toThrow(/timeout|timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a mutation after headers arrive and its body stalls', async () => {
    const stalled = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
        },
      }),
      { status: 200 },
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(stalled);
    const client = clientWith(fetchMock, { timeoutMs: 10, maxRetries: 3 });
    await expect(client.api(API_URL, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      AmbiguousGoogleMutationError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-Google destinations before obtaining credentials', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const client = clientWith(fetchMock);

    await expect(client.api('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'refusing non-Google API URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized response bodies before buffering them without retrying', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('123456789'));
    const client = clientWith(fetchMock, { maxResponseBytes: 8, maxRetries: 3 });

    await expect(client.api(API_URL)).rejects.toThrow('Google response exceeds 8 bytes');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('downloads bounded binary Drive content with the same authenticated read guard', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { 'content-type': 'application/pdf' },
        }),
      );
    const client = clientWith(fetchMock);

    await expect(
      client.apiBytes(
        'https://www.googleapis.com/drive/v3/files/file-id/export?mimeType=application/pdf',
      ),
    ).resolves.toEqual({ body: Buffer.from([37, 80, 68, 70]), contentType: 'application/pdf' });
  });
});

describe('buildRawEmail', () => {
  it('rejects CRLF header injection', () => {
    expect(() =>
      buildRawEmail({
        from: 'assistant@example.com',
        to: ['owner@example.com'],
        subject: 'Approved subject\r\nBcc: attacker@example.com',
        body: 'hello',
      }),
    ).toThrow('Subject contains a forbidden line break');
  });

  it('wraps body + attachment in multipart/mixed with a base64 part', () => {
    const raw = buildRawEmail({
      from: 'assistant@example.com',
      to: ['owner@example.com'],
      subject: 'Chart',
      body: 'see attached',
      html: '<p>see attached</p>',
      attachments: [{ filename: 'chart.png', mimeType: 'image/png', data: Buffer.from('PNGDATA') }],
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('Content-Type: multipart/mixed;');
    expect(decoded).toContain('Content-Type: multipart/alternative;'); // body kept inside
    expect(decoded).toContain('Content-Disposition: attachment; filename="chart.png"');
    expect(decoded).toContain(Buffer.from('PNGDATA').toString('base64'));
  });

  it('rejects attachments over the size limit', () => {
    expect(() =>
      buildRawEmail({
        from: 'a@example.com',
        to: ['b@example.com'],
        subject: 'big',
        body: 'x',
        attachments: [
          {
            filename: 'big.bin',
            mimeType: 'application/octet-stream',
            data: Buffer.alloc(19 * 1024 * 1024),
          },
        ],
      }),
    ).toThrow(/over the .* email limit/);
  });

  it('has no attachment framing when none are supplied', () => {
    const raw = buildRawEmail({
      from: 'a@example.com',
      to: ['b@example.com'],
      subject: 's',
      body: 'plain',
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).not.toContain('multipart/mixed');
    expect(decoded).toContain('Content-Type: text/plain');
  });
});

describe('collectGmailAttachments', () => {
  it('collects named parts with an attachmentId, skipping inline body parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGk=' } }, // inline body — not an attachment
        {
          mimeType: 'application/pdf',
          filename: 'lease.pdf',
          body: { attachmentId: 'att-1', size: 4096 },
        },
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'image/png',
              filename: 'scan.png',
              body: { attachmentId: 'att-2', size: 8192 },
            },
          ],
        },
        // Named but no attachmentId → not fetchable, skipped.
        { mimeType: 'text/calendar', filename: 'invite.ics', body: {} },
      ],
    };
    const found = collectGmailAttachments(payload);
    expect(found.map((a) => a.filename)).toEqual(['lease.pdf', 'scan.png']);
    expect(found[0]).toMatchObject({
      mimeType: 'application/pdf',
      attachmentId: 'att-1',
      size: 4096,
    });
    expect(collectGmailAttachments(undefined)).toEqual([]);
  });
});
