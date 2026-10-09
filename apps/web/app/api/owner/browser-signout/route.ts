import { loadConfig } from '@assistant/config';
import { authMode, signOut } from '@/auth';
import { clearOwnerSessionCookie } from '@/lib/owner-auth/runtime';

export const dynamic = 'force-dynamic';

function noStore(status: number, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(null, {
    status,
    headers: responseHeaders,
  });
}

function redirectTo(url: URL): Response {
  return noStore(303, { location: url.href });
}

/** Browser-only sign out that works from read-only pages such as Audit. */
export async function POST(request: Request): Promise<Response> {
  if (authMode !== 'google' && authMode !== 'passkey') return noStore(404);

  let configuredOrigin: URL;
  try {
    configuredOrigin = new URL(loadConfig().AUTH_URL);
    if (
      (configuredOrigin.protocol !== 'https:' && configuredOrigin.protocol !== 'http:') ||
      configuredOrigin.username ||
      configuredOrigin.password
    )
      return noStore(503);
  } catch {
    return noStore(503);
  }

  if (request.headers.get('origin') !== configuredOrigin.origin) return noStore(403);

  if (authMode === 'passkey') {
    try {
      await clearOwnerSessionCookie();
      return redirectTo(new URL('/signin', configuredOrigin.origin));
    } catch {
      return noStore(503);
    }
  }

  try {
    // Auth.js writes its expired session-cookie values through Next's outgoing
    // cookie store. Keep its redirect disabled so this endpoint can use one
    // fixed, safe sign-in destination instead of the current page's Referer.
    const result = await signOut({ redirect: false });
    if (!result || !Array.isArray(result.cookies)) return noStore(503);
    return redirectTo(new URL('/api/auth/signin', configuredOrigin.origin));
  } catch {
    return noStore(503);
  }
}
