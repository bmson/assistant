import { fetchCardImage, type PublicWebFetch } from '@assistant/application/public-web';

export interface CardImageDependencies {
  requireOwner: () => Promise<unknown>;
  fetchPublic?: PublicWebFetch;
  timeoutMs?: number;
}

export function createCardImageHandler(deps: CardImageDependencies) {
  return async function handleCardImage(request: Request): Promise<Response> {
    await deps.requireOwner();
    const raw = new URL(request.url).searchParams.get('url') ?? '';
    const result = await fetchCardImage(raw, deps.fetchPublic, deps.timeoutMs);
    if (result.kind === 'invalid-url') {
      return new Response(raw ? 'Image URL is not allowed' : 'Invalid image URL', { status: 400 });
    }
    if (result.kind === 'unavailable') return new Response('Image unavailable', { status: 502 });
    if (result.kind === 'unsupported') return new Response('Unsupported image', { status: 415 });
    if (result.kind === 'too-large') return new Response('Image too large', { status: 413 });
    return new Response(Buffer.from(result.bytes), {
      headers: {
        'content-type': result.contentType,
        'cache-control': 'private, max-age=3600',
        'content-security-policy': "default-src 'none'",
        'x-content-type-options': 'nosniff',
      },
    });
  };
}
