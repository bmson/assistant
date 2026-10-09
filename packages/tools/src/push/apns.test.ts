import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
import { describe, expect, it } from 'vitest';
import { AmbiguousApnsDeliveryError, ApnsClient } from './apns.js';

/**
 * A fake HTTP/2 session: captures the request headers + payload and answers
 * with a scripted status/reason. Stands in for api.push.apple.com so the
 * client's JWT, headers, and result mapping are covered without a network.
 */
function fakeSession(script: {
  status: number;
  reason?: string;
  apnsId?: string;
  termination?: 'close' | 'goaway' | 'stall';
}) {
  const requests: Array<{ headers: Record<string, unknown>; payload: string }> = [];
  const session = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    unref() {},
    request(headers: Record<string, unknown>) {
      const emitter = new EventEmitter();
      const stream = emitter as EventEmitter & { end: (body?: string) => void };
      stream.end = (body?: string) => {
        requests.push({ headers, payload: body ?? '' });
        queueMicrotask(() => {
          stream.emit('response', { ':status': script.status, 'apns-id': script.apnsId ?? 'id-1' });
          if (script.reason)
            stream.emit('data', Buffer.from(JSON.stringify({ reason: script.reason })));
          if (script.termination === 'close') stream.emit('close');
          else if (script.termination === 'goaway') session.emit('goaway');
          else if (script.termination !== 'stall') stream.emit('end');
        });
      };
      return stream as unknown as ClientHttp2Stream;
    },
  });
  return { session: session as unknown as ClientHttp2Session, requests };
}

function makeClient(
  script: {
    status: number;
    reason?: string;
    apnsId?: string;
    termination?: 'close' | 'goaway' | 'stall';
  },
  timeoutMs = 15_000,
) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  void publicKey;
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fake = fakeSession(script);
  const client = new ApnsClient(
    'KEY1234567',
    'TEAM123456',
    Buffer.from(pem).toString('base64'),
    'com.example.assistant',
    { connect: () => fake.session, timeoutMs },
  );
  return { client, fake };
}

describe('ApnsClient', () => {
  it.each(['close', 'goaway', 'stall'] as const)(
    'settles %s without replaying a possibly accepted alert',
    async (termination) => {
      const { client, fake } = makeClient({ status: 200, termination }, 5);
      await expect(
        client.send({
          token: 'a'.repeat(64),
          environment: 'production',
          title: 'Assistant',
          body: 'Private notice',
        }),
      ).rejects.toBeInstanceOf(AmbiguousApnsDeliveryError);
      expect(fake.requests).toHaveLength(1);
    },
  );
  it('does not treat a missing status as a known rejection', async () => {
    const { client, fake } = makeClient({ status: 0 });
    await expect(
      client.send({
        token: 'a'.repeat(64),
        environment: 'production',
        title: 'Assistant',
        body: 'Notice',
      }),
    ).rejects.toBeInstanceOf(AmbiguousApnsDeliveryError);
    expect(fake.requests).toHaveLength(1);
  });

  it('stands down until every setting is present', () => {
    expect(new ApnsClient('', '', '', '').configured()).toBe(false);
    expect(new ApnsClient('k', 't', 'p', '').configured()).toBe(false);
    expect(makeClient({ status: 200 }).client.configured()).toBe(true);
  });

  it('sends a signed alert push with the APNs headers and plain payload', async () => {
    const { client, fake } = makeClient({ status: 200, apnsId: 'apns-1' });
    const result = await client.send({
      token: 'a'.repeat(64),
      environment: 'production',
      title: 'Mori',
      body: 'Dentist moved to 15:00.',
      category: 'ASSISTANT_UPDATE',
      data: { route: 'chat' },
    });

    expect(result).toEqual({ ok: true, apnsId: 'apns-1' });
    expect(fake.requests).toHaveLength(1);
    const first = fake.requests[0];
    if (!first) throw new Error('expected one APNs request');
    const { headers, payload } = first;
    expect(headers[':path']).toBe(`/3/device/${'a'.repeat(64)}`);
    expect(headers['apns-topic']).toBe('com.example.assistant');
    expect(headers['apns-push-type']).toBe('alert');
    // ES256 provider JWT: three base64url segments, kid/team in header/claims.
    const [header = '', claims = '', signature = ''] = String(headers.authorization)
      .replace('bearer ', '')
      .split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss).toBe('TEAM123456');
    expect(signature.length).toBeGreaterThan(0);
    expect(JSON.parse(payload)).toEqual({
      aps: {
        alert: { title: 'Mori', body: 'Dentist moved to 15:00.' },
        sound: 'default',
        'thread-id': 'assistant-work',
        category: 'ASSISTANT_UPDATE',
      },
      route: 'chat',
    });
  });

  it('flags dead tokens as unregistered so the caller invalidates them', async () => {
    const gone = makeClient({ status: 410, reason: 'Unregistered' });
    const result = await gone.client.send({
      token: 'b'.repeat(64),
      environment: 'sandbox',
      title: 't',
      body: 'b',
    });
    expect(result).toMatchObject({ ok: false, unregistered: true, status: 410 });

    const bad = makeClient({ status: 400, reason: 'BadDeviceToken' });
    const again = await bad.client.send({
      token: 'c'.repeat(64),
      environment: 'sandbox',
      title: 't',
      body: 'b',
    });
    expect(again).toMatchObject({ ok: false, unregistered: true, status: 400 });
  });

  it('treats other rejections as transient, never as a dead token', async () => {
    const { client } = makeClient({ status: 429, reason: 'TooManyRequests' });
    const result = await client.send({
      token: 'd'.repeat(64),
      environment: 'production',
      title: 't',
      body: 'b',
    });
    expect(result).toMatchObject({ ok: false, unregistered: false, status: 429 });
  });
});
