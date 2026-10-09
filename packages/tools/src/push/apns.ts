import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';

/**
 * APNs provider client (HTTP/2, token auth). The .p8 key signs an ES256 JWT
 * that APNs accepts for up to an hour; the client caches the token and a
 * session per environment, since proactive nudges are rare but bursty (one
 * notice fans out to every registered device).
 *
 * Delivery results distinguish "the token is dead" (410 / BadDeviceToken —
 * the caller invalidates it) from transient failures, which are only logged:
 * a dropped nudge is preferable to a retry storm double-notifying the owner.
 */

export interface ApnsAlert {
  token: string;
  environment: 'sandbox' | 'production';
  title: string;
  body: string;
  /** Matches UNNotificationCategory identifiers registered by the iOS app. */
  category?: string;
  /** Extra payload keys the app reads from userInfo (route, approvalId, …). */
  data?: Record<string, string>;
}

export type ApnsResult =
  | { ok: true; apnsId: string }
  | { ok: false; unregistered: boolean; status: number; reason: string };

const APNS_HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

/** APNs rejects provider tokens older than an hour; refresh well inside it. */
const TOKEN_TTL_MS = 45 * 60 * 1000;

export class AmbiguousApnsDeliveryError extends Error {
  constructor(message: string) {
    super(`APNs delivery outcome is unknown: ${message}`);
    this.name = 'AmbiguousApnsDeliveryError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** crypto.sign emits DER; JWS needs the raw 64-byte R‖S concatenation. */
function derToRawEcdsa(der: Buffer): Buffer {
  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  let offset = 3; // skip sequence header + first integer tag
  const rLength = der[offset] ?? 0;
  offset += 1;
  let r = der.subarray(offset, offset + rLength);
  offset += rLength + 1; // skip r, land on s length
  const sLength = der[offset] ?? 0;
  offset += 1;
  let s = der.subarray(offset, offset + sLength);
  // Strip leading zero padding, then left-pad to 32 bytes each.
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);
  return Buffer.concat([
    Buffer.concat([Buffer.alloc(32 - r.length), r]),
    Buffer.concat([Buffer.alloc(32 - s.length), s]),
  ]);
}

export class ApnsClient {
  private jwt: { value: string; issuedAt: number } | undefined;
  private sessions = new Map<string, ClientHttp2Session>();
  private readonly connect: (host: string) => ClientHttp2Session;
  private readonly timeoutMs: number;

  constructor(
    private keyId: string,
    private teamId: string,
    /** Base64-encoded .p8 (PKCS#8 PEM) ES256 private key. */
    private privateKeyBase64: string,
    private bundleId: string,
    options: { connect?: (host: string) => ClientHttp2Session; timeoutMs?: number } = {},
  ) {
    this.connect = options.connect ?? ((host) => http2.connect(host));
    const timeoutMs = options.timeoutMs ?? 15_000;
    this.timeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(120_000, timeoutMs))
      : 15_000;
  }

  configured(): boolean {
    return Boolean(this.keyId && this.teamId && this.privateKeyBase64 && this.bundleId);
  }

  async send(alert: ApnsAlert): Promise<ApnsResult> {
    const session = this.session(APNS_HOSTS[alert.environment]);
    const payload = JSON.stringify({
      aps: {
        alert: { title: alert.title, body: alert.body },
        sound: 'default',
        'thread-id': 'assistant-work',
        ...(alert.category ? { category: alert.category } : {}),
      },
      ...(alert.data ?? {}),
    });
    try {
      return await this.request(session, alert.token, payload);
    } catch (err) {
      if (err instanceof AmbiguousApnsDeliveryError) throw err;
      // Only a failure before a stream exists may get a fresh attempt.
      // Once dispatch is possible, the unknown result above prevents replay.
      this.sessions.delete(APNS_HOSTS[alert.environment]);
      try {
        return await this.request(
          this.session(APNS_HOSTS[alert.environment]),
          alert.token,
          payload,
        );
      } catch {
        throw err;
      }
    }
  }

  private request(
    session: ClientHttp2Session,
    token: string,
    payload: string,
  ): Promise<ApnsResult> {
    return new Promise((resolve, reject) => {
      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(token)}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-id': randomUUID(),
        'content-type': 'application/json',
      });
      let status = 0;
      let apnsId = '';
      let body = '';
      let bodyBytes = 0;
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AmbiguousApnsDeliveryError(message));
        stream.close?.();
      };
      const sessionClosed = () => fail('session closed before a complete acknowledgement');
      const timeout = setTimeout(
        () => fail(`request timed out after ${this.timeoutMs}ms`),
        this.timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        session.removeListener('close', sessionClosed);
        session.removeListener('goaway', sessionClosed);
        session.removeListener('error', sessionClosed);
      };
      session.once('close', sessionClosed);
      session.once('goaway', sessionClosed);
      session.once('error', sessionClosed);
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
        apnsId = String(headers['apns-id'] ?? '');
      });
      stream.on('data', (chunk: Buffer) => {
        bodyBytes += chunk.byteLength;
        if (bodyBytes > 64 * 1024) {
          fail('response exceeds 65536 bytes');
          return;
        }
        body += chunk.toString('utf8');
      });
      stream.on('error', () => fail('stream failed before a complete acknowledgement'));
      stream.on('close', () => {
        if (!settled) fail('stream closed before a complete acknowledgement');
      });
      stream.on('end', () => {
        if (settled) return;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          fail('response ended without a valid acknowledgement status');
          return;
        }
        settled = true;
        cleanup();
        if (status === 200) {
          resolve({ ok: true, apnsId });
          return;
        }
        let reason = '';
        try {
          reason = String(JSON.parse(body).reason ?? '');
        } catch {
          reason = body.slice(0, 120);
        }
        resolve({
          ok: false,
          unregistered: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
          status,
          reason,
        });
      });
      try {
        stream.end(payload);
      } catch {
        fail('stream ended without a complete acknowledgement');
      }
    });
  }

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = this.connect(host);
    const drop = () => {
      if (this.sessions.get(host) === session) this.sessions.delete(host);
    };
    session.on('error', drop);
    session.on('goaway', drop);
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  private providerToken(): string {
    if (this.jwt && Date.now() - this.jwt.issuedAt < TOKEN_TTL_MS) return this.jwt.value;
    const key = createPrivateKey(Buffer.from(this.privateKeyBase64, 'base64'));
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const claims = base64url(
      JSON.stringify({ iss: this.teamId, iat: Math.floor(Date.now() / 1000) }),
    );
    const signature = derToRawEcdsa(sign('sha256', Buffer.from(`${header}.${claims}`), key));
    this.jwt = {
      value: `${header}.${claims}.${signature.toString('base64url')}`,
      issuedAt: Date.now(),
    };
    return this.jwt.value;
  }
}
