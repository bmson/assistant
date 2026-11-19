import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  boundedProviderResponse,
  ProviderDeadlineError,
  ProviderResponseLimitError,
  providerTransaction,
  withProviderSignal,
} from '../bounded-provider-response.js';

/**
 * Short, stable digest of a tool call's content, for idempotency keys on
 * non-idempotent mutations (append/draft) where the same target + different
 * content must key differently, but a crash-retry of the SAME call must not
 * append twice. 16 hex chars is ample collision resistance for per-task keys.
 */
export function contentDigest(...parts: unknown[]): string {
  return createHash('sha256')
    .update(parts.map((p) => JSON.stringify(p ?? null)).join('\0'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Minimal Google REST client for the bot account. Raw fetch — no googleapis
 * dependency. The refresh token comes from scripts/auth-bot.ts.
 */
export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional connected-account authority, checked before every provider request. */
  tokenProvider?: {
    accessToken(
      forceRefresh?: boolean,
      rejectedAccessToken?: string,
    ): Promise<string | { accessToken: string; credentialVersion: number }>;
    /** Recheck connection capability immediately before each provider request. */
    authorizeRequest?(url: string, method: string): Promise<void>;
    /** Final provider failure, after bounded 401 refresh/retries; never logged by the client. */
    requestFailed?(failure: {
      status: number;
      body: string;
      accessToken: string;
      credentialVersion?: number;
      url: string;
      method?: string;
    }): Promise<void>;
    /** Secret bound to the connection identity and revision, never the access token. */
    cursorSecret: string;
  };
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Additional attempts for token refreshes and idempotent API reads. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Maximum decoded HTTP response body accepted from Google. */
  maxResponseBytes?: number;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value as number)) : fallback;
}

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`Google API ${status} on ${url}: ${body.slice(0, 300)}`);
  }
}

/** A mutating request may have committed even though its response was lost. */
export class AmbiguousGoogleMutationError extends Error {
  readonly deliveryMayHaveSucceeded = true;

  constructor(
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'AmbiguousGoogleMutationError';
  }
}

export function isAmbiguousGoogleMutationError(
  error: unknown,
): error is AmbiguousGoogleMutationError {
  return (
    error instanceof AmbiguousGoogleMutationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { deliveryMayHaveSucceeded?: unknown }).deliveryMayHaveSucceeded === true)
  );
}

export class GoogleClient {
  private access: { token: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxResponseBytes: number;

  constructor(private opts: GoogleClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = boundedNumber(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxRetries = Math.floor(
      boundedNumber(opts.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES),
    );
    this.retryBaseDelayMs = boundedNumber(
      opts.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
    );
    this.maxResponseBytes = Math.floor(
      boundedNumber(opts.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_RESPONSE_BYTES),
    );
  }

  configured(): boolean {
    return Boolean(
      this.opts.tokenProvider ||
        (this.opts.clientId && this.opts.clientSecret && this.opts.refreshToken),
    );
  }

  /** Sign opaque provider cursors without exposing OAuth material in the token. */
  signOpaqueToken(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.opaqueTokenKey(), nonce);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher
      .getAuthTag()
      .toString('base64url')}`;
  }

  /** Verify a cursor created by this configured Google client. */
  verifyOpaqueToken(token: string): string | null {
    try {
      const [version, nonceText, ciphertextText, tagText, extra] = token.split('.');
      if (version !== 'v1' || !nonceText || !ciphertextText || !tagText || extra !== undefined)
        return null;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.opaqueTokenKey(),
        Buffer.from(nonceText, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  private opaqueTokenKey(): Buffer {
    return createHash('sha256')
      .update(
        this.opts.tokenProvider
          ? `connected-google\0${this.opts.tokenProvider.cursorSecret}`
          : `${this.opts.clientId}\0${this.opts.clientSecret}\0${this.opts.refreshToken}`,
      )
      .digest();
  }

  private async requestToken(
    forceRefresh: boolean,
    rejectedAccessToken?: string,
  ): Promise<{ accessToken: string; credentialVersion?: number }> {
    const credential = this.opts.tokenProvider
      ? rejectedAccessToken === undefined
        ? await this.opts.tokenProvider.accessToken(forceRefresh)
        : await this.opts.tokenProvider.accessToken(forceRefresh, rejectedAccessToken)
      : await this.token();
    return typeof credential === 'string' ? { accessToken: credential } : credential;
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    if (!this.refreshing) {
      this.refreshing = this.refreshToken().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async refreshToken(): Promise<string> {
    let attempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await this.fetchWithTimeout(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.opts.clientId,
            client_secret: this.opts.clientSecret,
            refresh_token: this.opts.refreshToken,
            grant_type: 'refresh_token',
          }),
        });
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        await this.waitBeforeRetry(undefined, attempt++);
        continue;
      }

      const text = await boundedResponseText(res, MAX_TOKEN_RESPONSE_BYTES);
      if (isTransientStatus(res.status) && attempt < this.maxRetries) {
        await this.waitBeforeRetry(res, attempt++);
        continue;
      }
      let data: {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        // Preserve the status/body in the stable error below.
      }
      if (!res.ok || !data.access_token) {
        throw new Error(
          `google token refresh failed: ${data.error ?? res.status} ${data.error_description ?? text.slice(0, 200)} — if the bot password changed, rerun pnpm auth:bot`,
        );
      }
      this.access = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      return this.access.token;
    }
  }

  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    try {
      return await providerTransaction(init.signal, this.timeoutMs, 'Google', (signal) =>
        this.apiWithinDeadline<T>(url, { ...init, signal }),
      );
    } catch (error) {
      if (
        (error instanceof ProviderDeadlineError || init.signal?.aborted) &&
        !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())
      )
        throw new AmbiguousGoogleMutationError(
          'Google mutation outcome is unknown after its transaction deadline',
          error,
        );
      throw error;
    }
  }

  private async apiWithinDeadline<T>(url: string, init: RequestInit): Promise<T> {
    assertGoogleApiUrl(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const retryableRead = method === 'GET' || method === 'HEAD';
    let retries = 0;
    let refreshedAfterUnauthorized = false;
    let forceTokenRefresh = false;
    let rejectedAccessToken: string | undefined;

    while (true) {
      const credential = await withProviderSignal(
        this.requestToken(forceTokenRefresh, rejectedAccessToken),
        init.signal ?? undefined,
      );
      const token = credential.accessToken;
      forceTokenRefresh = false;
      const headers = new Headers(init.headers);
      if (init.body && !headers.has('content-type'))
        headers.set('content-type', 'application/json');
      headers.set('authorization', `Bearer ${token}`);

      await this.opts.tokenProvider?.authorizeRequest?.(url, method);
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { ...init, method, headers });
      } catch (error) {
        if (!retryableRead) {
          throw new AmbiguousGoogleMutationError(
            `Google mutation outcome is unknown after a transport failure: ${String(error)}`,
            error,
          );
        }
        if (
          error instanceof ProviderResponseLimitError ||
          init.signal?.aborted ||
          retries >= this.maxRetries
        )
          throw error;
        await this.waitBeforeRetry(undefined, retries++, init.signal ?? undefined);
        continue;
      }

      let text: string;
      try {
        text = await boundedResponseText(res, this.maxResponseBytes);
      } catch (error) {
        if (!retryableRead) {
          throw new AmbiguousGoogleMutationError(
            `Google mutation outcome is unknown because its response was interrupted: ${String(error)}`,
            error,
          );
        }
        throw error;
      }
      if (res.status === 401 && !refreshedAfterUnauthorized) {
        // A 401 definitively rejected the request, so even mutations are safe
        // to retry once after discarding the rejected access token.
        if (this.access?.token === token) this.access = undefined;
        refreshedAfterUnauthorized = true;
        rejectedAccessToken = token;
        forceTokenRefresh = true;
        continue;
      }
      if (retryableRead && isTransientStatus(res.status) && retries < this.maxRetries) {
        await this.waitBeforeRetry(res, retries++, init.signal ?? undefined);
        continue;
      }
      if (!retryableRead && (res.status === 408 || res.status >= 500)) {
        throw new AmbiguousGoogleMutationError(
          `Google mutation outcome is unknown after HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        await this.opts.tokenProvider?.requestFailed?.({
          status: res.status,
          body: text,
          accessToken: token,
          url,
          method,
          ...(credential.credentialVersion !== undefined
            ? { credentialVersion: credential.credentialVersion }
            : {}),
        });
        throw new GoogleApiError(res.status, text, url);
      }
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        if (!retryableRead) {
          throw new AmbiguousGoogleMutationError(
            `Google mutation succeeded but returned an unreadable response: ${String(error)}`,
            error,
          );
        }
        throw error;
      }
    }
  }

  /** Authenticated, bounded GET for Drive downloads and exports. */
  async apiBytes(
    url: string,
    init: RequestInit = {},
  ): Promise<{ body: Buffer; contentType: string }> {
    return providerTransaction(init.signal, this.timeoutMs, 'Google', (signal) =>
      this.apiBytesWithinDeadline(url, { ...init, signal }),
    );
  }

  private async apiBytesWithinDeadline(
    url: string,
    init: RequestInit,
  ): Promise<{ body: Buffer; contentType: string }> {
    assertGoogleApiUrl(url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error('apiBytes supports read requests only');
    }
    let retries = 0;
    let refreshedAfterUnauthorized = false;
    let forceTokenRefresh = false;
    let rejectedAccessToken: string | undefined;

    while (true) {
      const credential = await withProviderSignal(
        this.requestToken(forceTokenRefresh, rejectedAccessToken),
        init.signal ?? undefined,
      );
      const token = credential.accessToken;
      forceTokenRefresh = false;
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { ...init, method, headers });
      } catch (error) {
        if (
          error instanceof ProviderResponseLimitError ||
          init.signal?.aborted ||
          retries >= this.maxRetries
        )
          throw error;
        await this.waitBeforeRetry(undefined, retries++, init.signal ?? undefined);
        continue;
      }
      if (res.status === 401 && !refreshedAfterUnauthorized) {
        await res.body?.cancel().catch(() => {});
        if (this.access?.token === token) this.access = undefined;
        refreshedAfterUnauthorized = true;
        rejectedAccessToken = token;
        forceTokenRefresh = true;
        continue;
      }
      if (isTransientStatus(res.status) && retries < this.maxRetries) {
        await res.body?.cancel().catch(() => {});
        await this.waitBeforeRetry(res, retries++, init.signal ?? undefined);
        continue;
      }
      if (!res.ok) {
        const text = await boundedResponseText(res, this.maxResponseBytes);
        await this.opts.tokenProvider?.requestFailed?.({
          status: res.status,
          body: text,
          accessToken: token,
          url,
          method,
          ...(credential.credentialVersion !== undefined
            ? { credentialVersion: credential.credentialVersion }
            : {}),
        });
        throw new GoogleApiError(res.status, text, url);
      }
      return {
        body: await boundedResponseBytes(res, this.maxResponseBytes),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return boundedProviderResponse(this.fetchFn, url, init, {
      timeoutMs: this.timeoutMs,
      maxBytes: url === TOKEN_URL ? MAX_TOKEN_RESPONSE_BYTES : this.maxResponseBytes,
      label: 'Google',
    });
  }

  private async waitBeforeRetry(
    response: Response | undefined,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const retryAfter = response ? retryAfterMs(response.headers.get('retry-after')) : undefined;
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    await withProviderSignal(
      this.sleep(Math.min(MAX_RETRY_DELAY_MS, retryAfter ?? exponential)),
      signal,
    );
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Google response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Google response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function assertGoogleApiUrl(value: string): void {
  const url = new URL(value);
  const googleApiHost =
    url.hostname === 'www.googleapis.com' || url.hostname.endsWith('.googleapis.com');
  if (url.protocol !== 'https:' || !googleApiHost || url.username || url.password || url.port) {
    throw new Error(`refusing non-Google API URL: ${url.origin}`);
  }
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

/** Total attachment bytes accepted before base64 (~18MB → ~24MB encoded). */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

export function mimeTypeForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Build an RFC 2822 email and encode base64url for the Gmail API. Without `html`
 * or attachments it is text/plain; with `html` it is multipart/alternative
 * (plain + rich); with attachments the whole body is wrapped in multipart/mixed.
 */
export function buildRawEmail(input: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: EmailAttachment[];
}): string {
  const header = (name: string, value: string): string => {
    if (/[\r\n]/.test(value)) throw new Error(`${name} contains a forbidden line break`);
    return `${name}: ${value}`;
  };
  const baseHeaders = [
    header('From', input.from),
    header('To', input.to.join(', ')),
    header('Subject', input.subject),
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [header('In-Reply-To', input.inReplyTo)] : []),
    ...(input.references ? [header('References', input.references)] : []),
  ];

  // The body entity: text/plain, or a multipart/alternative block. Returned as
  // its own Content-Type header lines + the content, so it can either be the
  // whole message or the first part inside a multipart/mixed wrapper.
  let bodyHeaderLines: string[];
  let bodyContent: string;
  if (input.html) {
    const alt = 'asst_alt_boundary_7f3c9e';
    bodyHeaderLines = [`Content-Type: multipart/alternative; boundary="${alt}"`];
    bodyContent = [
      `--${alt}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.body,
      `--${alt}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.html,
      `--${alt}--`,
      '',
    ].join('\r\n');
  } else {
    bodyHeaderLines = ['Content-Type: text/plain; charset=UTF-8'];
    bodyContent = input.body;
  }

  const attachments = input.attachments ?? [];
  let message: string;
  if (attachments.length === 0) {
    message = `${[...baseHeaders, ...bodyHeaderLines].join('\r\n')}\r\n\r\n${bodyContent}`;
  } else {
    const total = attachments.reduce((n, a) => n + a.data.length, 0);
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachments total ${total} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte email limit`,
      );
    }
    const mixed = 'asst_mixed_boundary_1b8d2a';
    const parts = [`--${mixed}`, ...bodyHeaderLines, '', bodyContent];
    for (const a of attachments) {
      const b64 = a.data.toString('base64').replace(/(.{76})/g, '$1\r\n');
      const safeName = a.filename.replace(/[\r\n"]/g, '_');
      parts.push(
        `--${mixed}`,
        `Content-Type: ${a.mimeType}; name="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        b64,
      );
    }
    parts.push(`--${mixed}--`, '');
    const headers = [...baseHeaders, `Content-Type: multipart/mixed; boundary="${mixed}"`];
    message = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
  }
  return Buffer.from(message).toString('base64url');
}

/** Crude HTML → text (a proper readability pass arrives with the browser phase). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode a Gmail message payload into plain text (prefers text/plain parts). */
export function extractGmailText(payload: GmailPayload | undefined): string {
  if (!payload) return '';
  const parts: GmailPayload[] = [];
  const walk = (p: GmailPayload) => {
    parts.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);

  const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return decode(plain.body?.data).trim();
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  if (html) return htmlToText(decode(html.body?.data));
  return decode(payload.body?.data).trim();
}

export interface GmailPayload {
  mimeType?: string;
  /** Non-empty for an attachment part (as opposed to an inline body part). */
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayload[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

/** Collect real file attachments (named parts carrying an attachmentId) from a payload. */
export function collectGmailAttachments(payload: GmailPayload | undefined): GmailAttachmentRef[] {
  if (!payload) return [];
  const found: GmailAttachmentRef[] = [];
  const walk = (p: GmailPayload) => {
    const attachmentId = p.body?.attachmentId;
    if (p.filename && attachmentId) {
      found.push({
        filename: p.filename,
        mimeType: (p.mimeType || 'application/octet-stream').split(';')[0]?.trim() ?? '',
        attachmentId,
        size: p.body?.size ?? 0,
      });
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return found;
}

export function gmailHeader(payload: GmailPayload | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}
