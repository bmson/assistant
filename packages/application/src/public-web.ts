import { fetchPublicWebResponse, type WebFetchResponse } from '@assistant/core/public-web';

export type { WebFetchResponse } from '@assistant/core/public-web';
export { fetchPublicWebResponse } from '@assistant/core/public-web';

const MAX_CARD_IMAGE_BYTES = 5 * 1024 * 1024;
const CARD_IMAGE_TIMEOUT_MS = 8_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export type CardImageResult =
  | { kind: 'ok'; contentType: string; bytes: Uint8Array }
  | { kind: 'invalid-url' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' }
  | { kind: 'too-large' };

export type PublicWebFetch = (
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
) => Promise<WebFetchResponse>;

function hasExplicitPort(raw: string): boolean {
  const authority = /^https:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 && host.slice(end + 1).startsWith(':');
  }
  return host.includes(':');
}

async function readBoundedBody(
  response: WebFetchResponse,
): Promise<{ kind: 'ok'; bytes: Uint8Array } | { kind: 'too-large' } | { kind: 'read-failed' }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (total + chunk.byteLength > MAX_CARD_IMAGE_BYTES) {
        response.cancel();
        return { kind: 'too-large' };
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch {
    response.cancel();
    return { kind: 'read-failed' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes };
}

/**
 * Fetch one card image through the shared DNS-validated, address-pinned public
 * transport. Redirects are rejected by status; the transport never follows
 * them for this request.
 */
export async function fetchCardImage(
  rawUrl: string,
  fetchPublic: PublicWebFetch = fetchPublicWebResponse,
  timeoutMs = CARD_IMAGE_TIMEOUT_MS,
): Promise<CardImageResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'invalid-url' };
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    hasExplicitPort(rawUrl)
  ) {
    return { kind: 'invalid-url' };
  }

  let response: WebFetchResponse;
  try {
    response = await fetchPublic(url.toString(), AbortSignal.timeout(timeoutMs), {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    return { kind: 'unavailable' };
  }
  const contentType = response.headers.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const contentEncoding = response.headers.contentEncoding.trim().toLowerCase();
  if (
    !ALLOWED_IMAGE_TYPES.has(contentType) ||
    (contentEncoding && contentEncoding !== 'identity')
  ) {
    response.cancel();
    return { kind: 'unsupported' };
  }

  const body = await readBoundedBody(response);
  if (body.kind === 'too-large') return { kind: 'too-large' };
  if (body.kind === 'read-failed') return { kind: 'unavailable' };
  return { kind: 'ok', contentType, bytes: body.bytes };
}
