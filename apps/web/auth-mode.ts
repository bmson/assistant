export type AuthMode = 'google' | 'passkey' | 'dev-bypass' | 'disabled';

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * The exact WebAuthn origin for passkey mode: an HTTPS origin with no path,
 * or loopback HTTP for local development. Returns null when unusable.
 */
export function passkeyOrigin(authUrl: string): { origin: string; rpId: string } | null {
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(authUrl)))
    return null;
  return { origin: url.origin, rpId: url.hostname };
}

/**
 * Best-effort tripwire: whether a request *appears* to have arrived on loopback,
 * judged only from its headers.
 *
 * IMPORTANT — this is not, and cannot be, a security boundary on its own. Next
 * populates `x-forwarded-for` from the socket only when the client did not send
 * it (`??=`), so a deliberately crafted `Host: localhost` +
 * `X-Forwarded-For: 127.0.0.1` is byte-identical to a genuine local request. A
 * determined attacker who can reach the port defeats this check. What it DOES
 * block is the cases that matter in practice for the loopback-published
 * quickstart image: a browser on another machine pointed at an exposed IP (a
 * browser cannot set `x-forwarded-for`, so Next fills it with the real remote
 * address → rejected) and a naive `Host:` override.
 *
 * The real control for AUTH_LOCALHOST_BYPASS is binding the port to loopback
 * (docker-compose does; see the .env.example warning) plus the boot-time gate
 * in resolveAuthMode (loopback AUTH_URL + QUEUE_DRIVER=local). A sound
 * per-request check would need the socket remote address, which the App Router
 * does not expose without a custom server — recorded as a follow-up. Do NOT
 * expose this port to the network with the bypass enabled.
 */
export function requestLooksLoopback(headers: {
  host: string | null;
  forwardedFor: string | null;
  forwardedHost: string | null;
}): boolean {
  const loopbackName = (value: string): boolean => {
    // Strip the port; IPv6 hosts keep their brackets ([::1]:3000 → [::1]).
    const hostname = value.startsWith('[')
      ? value.replace(/](:\d+)?$/, ']')
      : value.replace(/:\d+$/, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  };
  // A forwarded value naming a non-loopback client or host proves the request
  // crossed the network (Next mirrors direct requests into x-forwarded-* too,
  // so a loopback value there is necessary but — see above — not sufficient).
  if (headers.forwardedFor !== null) {
    const client = headers.forwardedFor.split(',')[0]?.trim() ?? '';
    if (client !== '127.0.0.1' && client !== '::1' && client !== '::ffff:127.0.0.1') return false;
  }
  if (headers.forwardedHost !== null && !loopbackName(headers.forwardedHost)) return false;
  return loopbackName(headers.host ?? '');
}

/**
 * Resolve auth fail-closed. Development bypass is never valid in production;
 * the separate localhost bypass supports production-built Docker images only
 * when both their URL and queue configuration prove a local installation.
 */
export function resolveAuthMode(options: {
  googleClientId: string;
  devBypass: boolean;
  localhostBypass?: boolean;
  authUrl?: string;
  queueDriver?: 'local' | 'cloudtasks' | 'inert';
  nodeEnv: string | undefined;
  ownerAuthMode?: 'google' | 'passkey';
  persistenceDriver?: 'postgres' | 'firestore';
  authSecret?: string;
}): AuthMode {
  if (options.devBypass && options.nodeEnv === 'production') {
    throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  }
  if (options.ownerAuthMode === 'passkey') {
    if (options.devBypass || options.localhostBypass)
      throw new Error('OWNER_AUTH_MODE=passkey cannot be combined with an auth bypass');
    if (options.persistenceDriver !== 'firestore')
      throw new Error('OWNER_AUTH_MODE=passkey requires PERSISTENCE_DRIVER=firestore');
    if ((options.authSecret ?? '').length < 32)
      throw new Error('OWNER_AUTH_MODE=passkey requires an AUTH_SECRET of at least 32 characters');
    if (!passkeyOrigin(options.authUrl ?? ''))
      throw new Error(
        'OWNER_AUTH_MODE=passkey requires AUTH_URL to be an HTTPS origin (or loopback HTTP)',
      );
    return 'passkey';
  }
  if (
    options.localhostBypass &&
    (!isLoopbackUrl(options.authUrl ?? '') || options.queueDriver !== 'local')
  ) {
    throw new Error('AUTH_LOCALHOST_BYPASS requires a loopback AUTH_URL and QUEUE_DRIVER=local');
  }
  if (options.googleClientId) return 'google';
  if (!options.devBypass && !options.localhostBypass) return 'disabled';
  return 'dev-bypass';
}
