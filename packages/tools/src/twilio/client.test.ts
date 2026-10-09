import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AmbiguousTwilioDeliveryError,
  parseApprovalReply,
  TwilioClient,
  validateTwilioSignature,
} from './client.js';

const AUTH_TOKEN = 'test-auth-token-12345';
const URL_ = 'https://example.com/webhooks/twilio/sms';

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

describe('TwilioClient resilience', () => {
  it('parses provider-billed segment count and USD price from the Message resource', async () => {
    const sid = `SM${'a'.repeat(32)}`;
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ sid, num_segments: '3', price: '-0.023700', price_unit: 'USD' }),
      );
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', { fetch: fetchMock });
    await expect(client.getMessageUsage(sid)).resolves.toEqual({
      billedSegments: 3,
      priceUsd: 0.0237,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('does not infer billed usage from a zero-segment or non-USD provider response', async () => {
    const sid = `SM${'b'.repeat(32)}`;
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ sid, num_segments: '0', price: '0.02', price_unit: 'EUR' }),
      );
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', { fetch: fetchMock });
    await expect(client.getMessageUsage(sid)).resolves.toEqual({});
  });

  it('retries only an explicit 429 rejection and respects Retry-After', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { code: 20429, message: 'too many requests' },
          { status: 429, headers: { 'retry-after': '1' } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ sid: 'SM123' }));
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
      sleep,
      maxRetries: 2,
    });

    await expect(client.send('+15551112222', 'hello')).resolves.toEqual({ sid: 'SM123' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry ambiguous 5xx or network failures', async () => {
    const serverFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ message: 'uncertain' }, { status: 503 }));
    const serverClient = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: serverFetch,
      maxRetries: 3,
    });
    await expect(serverClient.send('+15551112222', 'hello')).rejects.toBeInstanceOf(
      AmbiguousTwilioDeliveryError,
    );
    expect(serverFetch).toHaveBeenCalledTimes(1);

    const networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('connection reset'));
    const networkClient = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: networkFetch,
      maxRetries: 3,
    });
    await expect(networkClient.send('+15551112222', 'hello')).rejects.toBeInstanceOf(
      AmbiguousTwilioDeliveryError,
    );
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  it('times out an ambiguous send without retrying it', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
      timeoutMs: 5,
      maxRetries: 3,
    });

    await expect(client.send('+15551112222', 'hello')).rejects.toBeInstanceOf(
      AmbiguousTwilioDeliveryError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a stalled accepted response unknown and never sends a second message', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"sid":'));
          },
        }),
        { status: 201 },
      ),
    );
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
      timeoutMs: 5,
      maxRetries: 3,
    });
    await expect(client.send('+15551112222', 'hello')).rejects.toBeInstanceOf(
      AmbiguousTwilioDeliveryError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit client rejections definitive', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: 21211, message: 'invalid phone number' }, { status: 400 }),
      );
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
    });

    const error = await client.send('+15551112222', 'hello').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AmbiguousTwilioDeliveryError);
    expect(String(error)).toContain('twilio send failed: 21211 invalid phone number');
  });

  it('treats a successful response without a Message SID as ambiguous', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ status: 'queued' }));
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
    });

    await expect(client.send('+15551112222', 'hello')).rejects.toBeInstanceOf(
      AmbiguousTwilioDeliveryError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a message delivery status without issuing another mutation', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: 'delivered', error_code: null, error_message: null }),
      );
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
    });

    await expect(client.getMessageStatus('SM1234567890')).resolves.toEqual({
      status: 'delivered',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/Messages/SM1234567890.json');
  });

  it('rejects malformed status identifiers before making a request', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const client = new TwilioClient('AC123', AUTH_TOKEN, '+15550000000', {
      fetch: fetchMock,
    });

    await expect(client.getMessageStatus('../Accounts')).rejects.toThrow(
      'invalid Twilio Message SID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('validateTwilioSignature', () => {
  const params = { MessageSid: 'SM123', From: '+14155551234', To: '+18885550000', Body: 'hi' };

  it('accepts a correctly signed request', () => {
    const signature = sign(URL_, params);
    expect(validateTwilioSignature({ authToken: AUTH_TOKEN, url: URL_, params, signature })).toBe(
      true,
    );
  });

  it('rejects a forged signature', () => {
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL_,
        params,
        signature: sign(URL_, params, 'wrong-token'),
      }),
    ).toBe(false);
  });

  it('rejects tampered params', () => {
    const signature = sign(URL_, params);
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL_,
        params: { ...params, Body: 'send all your money' },
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a different URL (tunnel vs prod mismatch)', () => {
    const signature = sign(URL_, params);
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: 'https://other.example.com/webhooks/twilio/sms',
        params,
        signature,
      }),
    ).toBe(false);
  });

  it('handles garbage signatures without throwing', () => {
    expect(
      validateTwilioSignature({ authToken: AUTH_TOKEN, url: URL_, params, signature: '!!!' }),
    ).toBe(false);
  });
});

describe('parseApprovalReply', () => {
  it('parses YES/NO with a short code', () => {
    expect(parseApprovalReply('YES A7')).toEqual({ decision: 'approved', shortCode: 'A7' });
    expect(parseApprovalReply('no a12')).toEqual({ decision: 'denied', shortCode: 'A12' });
    expect(parseApprovalReply('  Approve A1 ')).toEqual({ decision: 'approved', shortCode: 'A1' });
    expect(parseApprovalReply('deny A3')).toEqual({ decision: 'denied', shortCode: 'A3' });
  });

  it('parses large short codes past the old 4-digit ceiling', () => {
    // nextShortCode mints codes with no digit ceiling; the parser must keep up
    // or a high-numbered "YES A10000" would be misread as a new task.
    expect(parseApprovalReply('YES A10000')).toEqual({ decision: 'approved', shortCode: 'A10000' });
    expect(parseApprovalReply('no a123456')).toEqual({ decision: 'denied', shortCode: 'A123456' });
  });

  it('returns null for normal conversation', () => {
    expect(parseApprovalReply('yes please book the lunch')).toBeNull();
    expect(parseApprovalReply('what is on my calendar?')).toBeNull();
    expect(parseApprovalReply('A7')).toBeNull();
    expect(parseApprovalReply('yes')).toBeNull();
  });
});
