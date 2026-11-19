import { localQaInstallationProof } from '@assistant/application/health';

export const dynamic = 'force-dynamic';

/**
 * Release verification target: reports the commit baked into this image.
 *
 * infra/gcp/release.sh polls this after rolling the web service and fails the
 * release unless it reports the tag being released. That check is the only
 * thing separating "the web image was built and pushed" from "production is
 * actually serving it" — without it a stranded rollout is invisible until
 * someone notices their UI change never appeared.
 *
 * Deliberately unauthenticated: the verifier runs in GitHub Actions with no
 * owner session, and a commit SHA is not a secret. It reveals nothing about
 * the owner's data, so it stays outside isAuthed() on purpose.
 */
export function GET(request: Request) {
  // Next.js can normalize the loopback address in request.url to localhost.
  const proof = localQaInstallationProof(
    request.headers.get('host'),
    request.headers.get('x-assistant-qa-nonce'),
  );
  return Response.json(
    { ok: true, service: 'web', sha: process.env.BUILD_SHA ?? 'unknown' },
    {
      headers: {
        'cache-control': 'no-store',
        ...(proof ? { 'x-assistant-qa-proof': proof } : {}),
      },
    },
  );
}
