import { createHmac } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';

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
function localQaProof(request: Request): string | undefined {
  if (process.env.NODE_ENV !== 'development') return;
  const nonce = request.headers.get('x-assistant-qa-nonce');
  const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
  if (!nonce || !/^[0-9a-f]{32}$/.test(nonce) || !token) return;
  try {
    const config = loadConfig();
    if (
      new URL(request.url).origin !== config.AUTH_URL ||
      !config.AUTH_DEV_BYPASS ||
      config.RESTORE_REHEARSAL ||
      config.PERSISTENCE_DRIVER !== 'postgres'
    )
      return;
    assertAllocatedTestTarget({
      databaseUrl: config.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token,
    });
    return createHmac('sha256', token).update(config.DATABASE_URL).update(nonce).digest('hex');
  } catch {
    return;
  }
}

export function GET(request: Request) {
  const proof = localQaProof(request);
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
