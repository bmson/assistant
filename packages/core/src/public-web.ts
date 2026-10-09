/*
 * SSRF-guarded public web fetch, shared by the `web.fetch` tool and the
 * web-watch poller. Every request goes through URL validation, DNS resolution
 * with IP pinning, private/special-range rejection for IPv4 and IPv6, manual
 * redirect re-checks, a byte cap, and compressed-response refusal.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export const WEB_FETCH_MAX_BYTES = 256 * 1024;
const WEB_FETCH_MAX_REDIRECTS = 5;
const WEB_DNS_TIMEOUT_MS = 5_000;

export interface ResolvedWebAddress {
  address: string;
  family: 4 | 6;
}

export interface WebFetchResponse {
  status: number;
  headers: {
    contentType: string;
    contentEncoding: string;
    contentLength?: string;
    location?: string;
  };
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
}

export interface WebFetchIo {
  resolve: (hostname: string) => Promise<ResolvedWebAddress[]>;
  get: (
    url: URL,
    address: ResolvedWebAddress,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ) => Promise<WebFetchResponse>;
}

function ipv4Octets(address: string): number[] | null {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets;
}

function ipv6Words(rawAddress: string): number[] | null {
  let address =
    rawAddress
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%', 1)[0] ?? '';
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const octets = ipv4Octets(address.slice(lastColon + 1));
    if (lastColon < 0 || !octets) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const words = half.split(':').map((word) => Number.parseInt(word, 16));
    return words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
      ? null
      : words;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const zeroCount = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) {
    return null;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

/** Only globally routable addresses may be contacted by web.fetch. */
export function isPublicIpAddress(rawAddress: string): boolean {
  const address = rawAddress.replace(/^\[|\]$/g, '').split('%', 1)[0] ?? '';
  const family = isIP(address);
  if (family === 4) {
    const octets = ipv4Octets(address);
    if (!octets) return false;
    const [a = 0, b = 0, c = 0] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;

  const words = ipv6Words(address);
  if (!words) return false;
  // IPv4-mapped IPv6 must inherit the embedded IPv4 address's classification.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return isPublicIpAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  const [first = 0, second = 0, third = 0] = words;
  if ((first & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3
  if (first === 0x2002) return false; // 6to4 can tunnel to private IPv4
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2001 && second === 0) return false; // Teredo/special-purpose
  if (first === 0x2001 && second === 2 && third === 0) return false; // benchmarking
  if (first === 0x2001 && ((second & 0xfff0) === 0x10 || (second & 0xfff0) === 0x20)) {
    return false; // ORCHID identifier ranges
  }
  return true;
}

async function nodeResolve(hostname: string): Promise<ResolvedWebAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  let rows: Array<{ address: string; family: number }>;
  try {
    rows = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }) as Promise<
        Array<{ address: string; family: number }>
      >,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS resolution timed out')), WEB_DNS_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return rows.flatMap((row) =>
    row.family === 4 || row.family === 6 ? [{ address: row.address, family: row.family }] : [],
  );
}

async function nodeGet(
  url: URL,
  address: ResolvedWebAddress,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<WebFetchResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const authorityHostname = url.hostname.replace(/^\[|\]$/g, '');
    const lookup = ((_hostname, options, callback) => {
      if (options?.all) {
        callback(null, [{ address: address.address, family: address.family }]);
        return;
      }
      callback(null, address.address, address.family);
    }) as LookupFunction;
    const req = request(
      url,
      {
        method: 'GET',
        // Connect directly to the approved address; retain the original authority for HTTP and TLS.
        hostname: address.address,
        servername: isIP(authorityHostname) ? undefined : authorityHostname,
        agent: false,
        family: address.family,
        lookup,
        signal,
        headers: {
          host: url.host,
          accept:
            headers.accept ??
            'text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'assistant-bot/0.1 (+personal use)',
        },
      },
      (response) => {
        const firstHeader = (value: string | string[] | undefined): string =>
          Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            contentType: firstHeader(response.headers['content-type']),
            contentEncoding: firstHeader(response.headers['content-encoding']),
            contentLength: firstHeader(response.headers['content-length']) || undefined,
            location: firstHeader(response.headers.location) || undefined,
          },
          body: response,
          cancel: () => response.destroy(),
        });
      },
    );
    req.once('error', reject);
    req.end();
  });
}

export function createNodeWebFetchIo(resolve: WebFetchIo['resolve'] = nodeResolve): WebFetchIo {
  return { resolve, get: nodeGet };
}

const DEFAULT_WEB_FETCH_IO = createNodeWebFetchIo();

/** Resolve and pin one approved public address for a single request. Redirects
 * are returned to the caller and are never followed by this transport. */
export async function fetchPublicWebResponse(
  rawUrl: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  io: WebFetchIo = DEFAULT_WEB_FETCH_IO,
): Promise<WebFetchResponse> {
  signal.throwIfAborted();
  const url = new URL(rawUrl);
  validateWebUrl(url);
  const address = await resolvePublicAddress(url, io);
  signal.throwIfAborted();
  return io.get(url, address, signal, headers);
}

export function validateWebUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('http(s) only');
  if (url.username || url.password) throw new Error('URL credentials are blocked');
  if (!url.hostname) throw new Error('URL hostname is required');
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) throw new Error('non-standard web ports are blocked');
}

async function resolvePublicAddress(url: URL, io: WebFetchIo): Promise<ResolvedWebAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await io.resolve(hostname);
  if (addresses.length === 0) throw new Error('hostname did not resolve');
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('private or non-routable addresses are blocked');
  }
  return addresses[0] as ResolvedWebAddress;
}

async function readBoundedBody(
  response: WebFetchResponse,
): Promise<{ body: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let truncated = false;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    const remaining = WEB_FETCH_MAX_BYTES - bytesRead;
    if (bytes.length > remaining) {
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      bytesRead += Math.max(remaining, 0);
      truncated = true;
      response.cancel();
      break;
    }
    chunks.push(bytes);
    bytesRead += bytes.length;
  }
  return { body: Buffer.concat(chunks, bytesRead).toString('utf8'), truncated };
}

/** Fetch with DNS validation, IP pinning, manual redirect checks, and a byte cap. */
export async function fetchPublicWebPage(
  rawUrl: string,
  signal: AbortSignal,
  io: WebFetchIo = DEFAULT_WEB_FETCH_IO,
): Promise<{
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  finalUrl: string;
}> {
  let url = new URL(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    validateWebUrl(url);
    const address = await resolvePublicAddress(url, io);
    signal.throwIfAborted();
    const response = await io.get(url, address, signal);
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (isRedirect && response.headers.location) {
      response.cancel();
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(response.headers.location, url);
      continue;
    }
    const encoding = response.headers.contentEncoding.trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      response.cancel();
      throw new Error('compressed responses are blocked');
    }
    const { body, truncated } = await readBoundedBody(response);
    return {
      status: response.status,
      contentType: response.headers.contentType,
      body,
      truncated,
      finalUrl: url.toString(),
    };
  }
}

/**
 * Crude visible-text extraction (v1): drop scripts/styles/tags and collapse
 * whitespace so a page fingerprints stably across loads. Non-HTML bodies pass
 * through unchanged. Shared by `web.fetch` and the web-watch poller so both see
 * exactly the same normalized text — a real readability pass is a later step.
 */
export function extractWebText(contentType: string, body: string): string {
  if (!contentType.includes('html')) return body;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bot-challenge detector for web.fetch. Search engines and Cloudflare-fronted
 * sites answer datacenter traffic with a small verification page instead of
 * content — DuckDuckGo even serves its CAPTCHA as HTTP 202, so neither the
 * status code nor "we got HTML" distinguishes a wall from an answer. Treating
 * a challenge as a successful fetch poisons everything downstream: the model
 * summarizes a CAPTCHA page as if it were content, and an unattended goal
 * session counts the fetch as verified work (exactly that burned a goal
 * session's budget in prod). Phrases are only matched near the top of the
 * page, and only when the response also has a challenge-ish status or is
 * suspiciously small, so an article ABOUT captchas does not trip it.
 */
export function looksLikeBotChallenge(status: number, text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  const phrase =
    /complete the following challenge|verify (that )?you('re| are) (a )?human|are you a robot|enable javascript and cookies to continue|additional verification required|checking your browser|just a moment/;
  if (!phrase.test(head)) return false;
  const challengeStatus = status === 202 || status === 403 || status === 429 || status === 503;
  return challengeStatus || text.length < 4000;
}
