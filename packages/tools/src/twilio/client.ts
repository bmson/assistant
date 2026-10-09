import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  boundedProviderResponse,
  ProviderDeadlineError,
  providerTransaction,
  withProviderSignal,
} from '../bounded-provider-response.js';

/**
 * Minimal Twilio REST client (fetch + basic auth — no SDK). Injectable so
 * tests can fake delivery.
 */
export interface SmsSender {
  send(to: string, body: string): Promise<{ sid: string }>;
  getMessageUsage?(sid: string): Promise<TwilioMessageUsage>;
}

export interface TwilioMessageUsage {
  billedSegments?: number;
  priceUsd?: number;
}

export interface TwilioMessageStatus {
  status: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface TwilioClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Additional attempts, used only after an explicit HTTP 429 rejection. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

/**
 * The request may have reached Twilio even though no Message SID made it back
 * to us. Callers must conservatively meter the attempt and suppress automatic
 * retries; retrying an ambiguous delivery can send and bill twice.
 */
export class AmbiguousTwilioDeliveryError extends Error {
  readonly deliveryMayHaveSucceeded = true;

  constructor(
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'AmbiguousTwilioDeliveryError';
  }
}

export function isAmbiguousTwilioDeliveryError(
  error: unknown,
): error is AmbiguousTwilioDeliveryError {
  return (
    error instanceof AmbiguousTwilioDeliveryError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { deliveryMayHaveSucceeded?: unknown }).deliveryMayHaveSucceeded === true)
  );
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 5;

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value as number)) : fallback;
}

export class TwilioClient implements SmsSender {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string,
    options: TwilioClientOptions = {},
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxRetries = Math.floor(
      boundedNumber(options.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES),
    );
    this.retryBaseDelayMs = boundedNumber(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
    );
  }

  configured(): boolean {
    return Boolean(this.accountSid && this.authToken && this.fromNumber);
  }

  async send(to: string, body: string, callerSignal?: AbortSignal): Promise<{ sid: string }> {
    try {
      return await providerTransaction(callerSignal, this.timeoutMs, 'Twilio', (signal) =>
        this.sendWithinDeadline(to, body, signal),
      );
    } catch (error) {
      if (error instanceof ProviderDeadlineError || callerSignal?.aborted)
        throw new AmbiguousTwilioDeliveryError(
          'Twilio delivery outcome is unknown after its transaction was interrupted',
          error,
        );
      throw error;
    }
  }

  private async sendWithinDeadline(
    to: string,
    body: string,
    signal: AbortSignal,
  ): Promise<{ sid: string }> {
    let retries = 0;
    while (true) {
      // A network error or timeout is ambiguous: Twilio may have accepted the
      // message. Never retry those without a provider idempotency primitive.
      let res: Response;
      try {
        res = await this.fetchWithTimeout(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
          {
            method: 'POST',
            signal,
            headers: {
              authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }),
          },
        );
      } catch (error) {
        throw new AmbiguousTwilioDeliveryError(
          `Twilio delivery outcome is unknown after a transport failure: ${String(error)}`,
          error,
        );
      }

      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        throw new AmbiguousTwilioDeliveryError(
          `Twilio delivery outcome is unknown because its response was interrupted: ${String(error)}`,
          error,
        );
      }
      let data: { sid?: string; message?: string; code?: number } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        // The stable error below includes the HTTP status even for malformed bodies.
      }

      if (res.status === 429 && retries < this.maxRetries) {
        const retryAfter = retryAfterMs(res.headers.get('retry-after'));
        const exponential = this.retryBaseDelayMs * 2 ** retries;
        retries += 1;
        await withProviderSignal(
          this.sleep(Math.min(MAX_RETRY_DELAY_MS, retryAfter ?? exponential)),
          signal,
        );
        continue;
      }
      if (res.status === 408 || res.status >= 500) {
        throw new AmbiguousTwilioDeliveryError(
          `Twilio delivery outcome is unknown: ${data.code ?? res.status} ${data.message ?? text.slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `twilio send failed: ${data.code ?? res.status} ${data.message ?? text.slice(0, 200)}`,
        );
      }
      if (!data.sid) {
        throw new AmbiguousTwilioDeliveryError(
          `Twilio delivery outcome is unknown: ${res.status} ${text.slice(0, 200)}`,
        );
      }
      return { sid: data.sid };
    }
  }

  /** Safe, idempotent provider read used to confirm a canary reached carrier handoff. */
  async getMessageStatus(sid: string, signal?: AbortSignal): Promise<TwilioMessageStatus> {
    if (!/^SM[0-9A-Za-z]{8,64}$/.test(sid)) throw new Error('invalid Twilio Message SID');
    const res = await this.fetchWithTimeout(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages/${encodeURIComponent(sid)}.json`,
      {
        method: 'GET',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        },
        signal,
      },
    );
    const text = await res.text();
    let data: {
      status?: string;
      error_code?: number | null;
      error_message?: string | null;
      message?: string;
    } = {};
    try {
      data = text ? (JSON.parse(text) as typeof data) : {};
    } catch {
      // Preserve status and a bounded body in the stable error below.
    }
    if (!res.ok || !data.status) {
      throw new Error(`twilio status failed: ${res.status} ${data.message ?? text.slice(0, 200)}`);
    }
    return {
      status: data.status,
      ...(typeof data.error_code === 'number' ? { errorCode: data.error_code } : {}),
      ...(typeof data.error_message === 'string' ? { errorMessage: data.error_message } : {}),
    };
  }

  /** Read Message usage; durable read-repair retries when Twilio has not populated it yet. */
  async getMessageUsage(sid: string): Promise<TwilioMessageUsage> {
    if (!/^SM[0-9A-Za-z]{8,64}$/.test(sid)) throw new Error('invalid Twilio Message SID');
    const res = await this.fetchWithTimeout(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages/${encodeURIComponent(sid)}.json`,
      {
        method: 'GET',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        },
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`twilio usage lookup failed: ${res.status} ${text.slice(0, 200)}`);
    let data: {
      sid?: string;
      num_segments?: string | number;
      price?: string | null;
      price_unit?: string | null;
    };
    try {
      data = text ? (JSON.parse(text) as typeof data) : {};
    } catch {
      throw new Error(`twilio usage lookup returned malformed data: ${text.slice(0, 200)}`);
    }
    if (data.sid !== sid) throw new Error('twilio usage lookup returned a different message SID');
    const segments = Number(data.num_segments);
    const price = data.price === null || data.price === undefined ? Number.NaN : Number(data.price);
    return {
      ...(Number.isInteger(segments) && segments > 0 ? { billedSegments: segments } : {}),
      ...(Number.isFinite(price) && data.price_unit?.toLowerCase() === 'usd'
        ? { priceUsd: Math.abs(price) }
        : {}),
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return boundedProviderResponse(this.fetchFn, url, init, {
      timeoutMs: this.timeoutMs,
      maxBytes: 1024 * 1024,
      label: 'Twilio',
    });
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/**
 * Validate X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted form
 * params concatenated as key+value)). Per Twilio's security docs; the URL must
 * be the EXACT public URL Twilio requested (scheme, host, path, query).
 */
export function validateTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  const data =
    input.url +
    Object.keys(input.params)
      .sort()
      .map((k) => k + input.params[k])
      .join('');
  const expected = createHmac('sha1', input.authToken).update(data, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** "YES A7XR" / "no a12" → an approval resolution; anything else → null. */
export function parseApprovalReply(
  body: string,
): { decision: 'approved' | 'denied'; shortCode: string } | null {
  // Short codes are minted monotonically with no digit ceiling (nextShortCode)
  // and now carry a two-letter random suffix (A7XR). The optional {0,2} letter
  // group accepts both the new form and legacy suffix-less codes still pending
  // during the transition; the letters are unambiguous because the numeric part
  // is unique per code, so "A7" and "A7XR" can never both exist.
  const match = body.trim().match(/^(yes|no|approve|deny)\s+(A\d{1,9}[A-Z]{0,2})$/i);
  if (!match) return null;
  const word = (match[1] as string).toLowerCase();
  return {
    decision: word === 'yes' || word === 'approve' ? 'approved' : 'denied',
    shortCode: (match[2] as string).toUpperCase(),
  };
}
