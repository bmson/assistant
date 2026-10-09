import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { headers } from 'next/headers';
import { redirect, unauthorized } from 'next/navigation';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { formSessionScopeForJwt, isValidFormSessionScope } from './app/auth-form-session-scope';
import { requestLooksLoopback, resolveAuthMode } from './auth-mode';

// loadConfig() side-loads the repo-root .env, so AUTH_* vars defined there are
// visible even though Next only reads apps/web/.env* files.
const config = loadConfig();

/**
 * passkey    — OWNER_AUTH_MODE=passkey; WebAuthn owner sign-in stored in Firestore,
 *              no Google OAuth client (customer-owned installations).
 * google     — AUTH_GOOGLE_ID is set; real Google sign-in, allowlisted to the owner.
 * dev-bypass — explicitly enabled for development or loopback-only Docker; auth is skipped.
 * disabled   — auth is not configured; every request is rejected (401).
 */
export const authMode = resolveAuthMode({
  googleClientId: config.AUTH_GOOGLE_ID,
  devBypass: config.AUTH_DEV_BYPASS,
  localhostBypass: config.AUTH_LOCALHOST_BYPASS,
  authUrl: config.AUTH_URL,
  queueDriver: config.QUEUE_DRIVER,
  nodeEnv: process.env.NODE_ENV,
  ownerAuthMode: config.OWNER_AUTH_MODE,
  persistenceDriver: config.PERSISTENCE_DRIVER,
  authSecret: config.AUTH_SECRET,
});

if (authMode === 'dev-bypass') {
  console.warn('[auth] explicit local bypass enabled — owner authentication is disabled');
  if (config.AUTH_LOCALHOST_BYPASS && process.env.NODE_ENV === 'production') {
    console.warn(
      '[auth] AUTH_LOCALHOST_BYPASS is active. The per-request loopback check is a best-effort ' +
        'tripwire, NOT a boundary — a crafted X-Forwarded-For defeats it. Bind this port to ' +
        'loopback (127.0.0.1) only; do not expose it to the network.',
    );
  }
}

export const { handlers, auth, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, account }) {
      const claims = token as typeof token & { assistantFormSessionScope?: unknown };
      const scope = formSessionScopeForJwt({
        accountPresent: Boolean(account),
        existingScope: claims.assistantFormSessionScope,
        createScope: randomUUID,
      });
      if (scope) claims.assistantFormSessionScope = scope;
      else delete claims.assistantFormSessionScope;
      return token;
    },
    session({ session, token }) {
      const scope = (token as typeof token & { assistantFormSessionScope?: unknown })
        .assistantFormSessionScope;
      return Object.assign(session, {
        assistantFormSessionScope: isValidFormSessionScope(scope) ? scope : null,
      });
    },
    signIn({ profile }) {
      // Belt-and-suspenders: with Google as the sole IdP the email namespace is
      // Google's, but require the verified flag so an unverified-email account
      // can never match the owner address. The typed claim is a boolean, so an
      // explicit === true is exact and cannot be spoofed by a string value.
      return profile?.email === config.OWNER_EMAIL && profile?.email_verified === true;
    },
  },
});

export interface OwnerSession {
  user: { email: string; name?: string | null };
  /** Opaque per-browser login scope used only to partition local form drafts. */
  formSessionScope?: string;
}

/**
 * Returns the owner session, or null when the request is not authenticated.
 * Used by API routes (return 401 yourself) and by requireOwner() for pages.
 */
export async function isAuthed(): Promise<OwnerSession | null> {
  if (authMode === 'dev-bypass') {
    // The production-built localhost bypass (Compose quickstart) additionally
    // requires the request itself to look loopback-direct. This is a best-effort
    // tripwire, not a boundary: see requestLooksLoopback — a crafted
    // X-Forwarded-For defeats it, so the real control is binding the port to
    // loopback. AUTH_DEV_BYPASS cannot reach here in production builds
    // (resolveAuthMode throws), so this branch is exactly the Compose case.
    if (process.env.NODE_ENV === 'production') {
      const h = await headers();
      const loopback = requestLooksLoopback({
        host: h.get('host'),
        forwardedFor: h.get('x-forwarded-for'),
        forwardedHost: h.get('x-forwarded-host'),
      });
      if (!loopback) {
        console.warn('[auth] localhost bypass refused for a non-loopback request');
        return null;
      }
    }
    return {
      user: { email: config.OWNER_EMAIL, name: 'Owner (dev)' },
      formSessionScope: 'local-development-scope',
    };
  }
  if (authMode === 'disabled') return null;
  if (authMode === 'passkey') {
    const { currentOwnerSession } = await import('./lib/owner-auth/runtime');
    const claims = await currentOwnerSession();
    return claims
      ? {
          user: { email: config.OWNER_EMAIL, name: config.OWNER_NAME },
          ...(isValidFormSessionScope(claims.sid) ? { formSessionScope: claims.sid } : {}),
        }
      : null;
  }
  const session = await auth();
  if (session?.user?.email === config.OWNER_EMAIL) {
    const formSessionScope = (session as typeof session & { assistantFormSessionScope?: unknown })
      .assistantFormSessionScope;
    return {
      user: { email: session.user.email, name: session.user.name },
      ...(isValidFormSessionScope(formSessionScope) ? { formSessionScope } : {}),
    };
  }
  return null;
}

/**
 * Page guard: redirects to the sign-in page when Google or passkey auth is configured,
 * renders the 401 page when auth is unconfigured in production.
 */
export async function requireOwner(): Promise<OwnerSession> {
  const session = await isAuthed();
  if (session) return session;
  if (authMode === 'google') redirect('/api/auth/signin');
  if (authMode === 'passkey') redirect('/signin');
  unauthorized();
}
