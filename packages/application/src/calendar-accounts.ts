import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CalendarAccountRepository } from '@assistant/persistence';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const CALENDAR_CALLBACK_PATH = '/api/calendar-accounts/callback';
export const CALENDAR_CONNECTION_TTL = 15 * 60;

export interface CalendarAccountPorts {
  accounts: CalendarAccountRepository;
  config: {
    GOOGLE_OAUTH_CLIENT_ID: string;
    GOOGLE_OAUTH_CLIENT_SECRET: string;
    AUTH_URL: string;
    MCP_ENC_KEY: string;
    ASSISTANT_MODULES?: readonly string[];
    AUTH_GOOGLE_ID?: string;
  };
  seal(value: string): string;
  open(value: string): string;
}

export function calendarConnectionReady(ports: CalendarAccountPorts): boolean {
  const { config } = ports;
  if (
    !config.ASSISTANT_MODULES?.some((module) => module === 'calendar' || module === 'google') ||
    !config.GOOGLE_OAUTH_CLIENT_ID ||
    !config.GOOGLE_OAUTH_CLIENT_SECRET ||
    !/^[a-f0-9]{64}$/i.test(config.MCP_ENC_KEY)
  )
    return false;
  try {
    calendarCallbackURL(config.AUTH_URL);
    return true;
  } catch {
    return false;
  }
}

export function calendarCallbackURL(authURL: string): string {
  const url = new URL(authURL);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Calendar connections require an HTTPS AUTH_URL (or loopback for local development)',
    );
  return new URL(CALENDAR_CALLBACK_PATH, url.origin).href;
}

export function calendarOAuthCallbackURL(ports: CalendarAccountPorts): string {
  const callback = calendarCallbackURL(ports.config.AUTH_URL);
  return ports.config.AUTH_GOOGLE_ID === ports.config.GOOGLE_OAUTH_CLIENT_ID
    ? new URL('/api/auth/callback/google', callback).href
    : callback;
}

function oauth(ports: CalendarAccountPorts): OAuth2Client {
  return new OAuth2Client({
    clientId: ports.config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: ports.config.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: calendarOAuthCallbackURL(ports),
    transporterOptions: { timeout: 15_000, retry: false, maxContentLength: 128 * 1024 },
  });
}

export async function beginCalendarConnection(ports: CalendarAccountPorts, sessionScope: string) {
  if (!calendarConnectionReady(ports)) throw new Error('Calendar connections are not configured');
  if (!sessionScope) throw new Error('Sign in again before connecting a calendar');
  const state = `calendar.${randomBytes(32).toString('base64url')}`;
  const verifier = randomBytes(48).toString('base64url');
  const redirectUri = calendarOAuthCallbackURL(ports);
  const cookie = ports.seal(
    JSON.stringify({ state, verifier, sessionScope, redirectUri, issuedAt: Date.now() }),
  );
  const url = oauth(ports).generateAuthUrl({
    scope: ['openid', 'email', CALENDAR_READ_SCOPE],
    access_type: 'offline',
    prompt: 'select_account consent',
    // Avoid combining this grant with the bot's broader mail/Drive scopes.
    include_granted_scopes: false,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: CodeChallengeMethod.S256,
  });
  return { url, cookie };
}

/** Validate the browser binding before exchanging anything with Google. */
export function verifyCalendarConnectionState(
  ports: CalendarAccountPorts,
  cookie: string,
  state: string,
  sessionScope: string,
) {
  const saved = JSON.parse(ports.open(cookie)) as {
    state: string;
    verifier: string;
    sessionScope: string;
    redirectUri: string;
    issuedAt: number;
  };
  if (
    typeof saved.state !== 'string' ||
    typeof state !== 'string' ||
    !state ||
    state.length > 256 ||
    Buffer.byteLength(saved.state) !== Buffer.byteLength(state) ||
    !timingSafeEqual(Buffer.from(saved.state), Buffer.from(state)) ||
    !sessionScope ||
    saved.sessionScope !== sessionScope ||
    typeof saved.verifier !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(saved.verifier) ||
    saved.redirectUri !== calendarOAuthCallbackURL(ports) ||
    !Number.isFinite(saved.issuedAt) ||
    Date.now() < saved.issuedAt ||
    Date.now() - saved.issuedAt > CALENDAR_CONNECTION_TTL * 1000
  )
    throw new Error('Calendar connection expired. Start again from Settings.');
  return saved;
}

export async function completeCalendarConnection(
  ports: CalendarAccountPorts,
  input: { cookie: string; state: string; code: string; sessionScope: string },
) {
  const saved = verifyCalendarConnectionState(ports, input.cookie, input.state, input.sessionScope);
  if (!input.code || input.code.length > 4096) throw new Error('Missing authorization code');
  const client = oauth(ports);
  const { tokens } = await client.getToken({
    code: input.code,
    codeVerifier: saved.verifier,
    redirect_uri: saved.redirectUri,
  });
  const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [];
  if (!scopes.includes(CALENDAR_READ_SCOPE) || !tokens.id_token || !tokens.refresh_token)
    throw new Error(
      'Calendar access and offline access are required. Reconnect and allow calendar access.',
    );
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: ports.config.GOOGLE_OAUTH_CLIENT_ID,
  });
  const identity = ticket.getPayload();
  if (!identity?.sub || !identity.email || identity.email_verified !== true)
    throw new Error('Google did not verify the calendar account');
  const existing = await ports.accounts.list();
  if (!existing.some((account) => account.id === identity.sub) && existing.length >= 10)
    throw new Error('Calendar account limit reached');
  await ports.accounts.save({
    id: identity.sub,
    email: identity.email,
    clientId: ports.config.GOOGLE_OAUTH_CLIENT_ID,
    refreshTokenEncrypted: ports.seal(tokens.refresh_token),
    scopes,
    lastError: null,
    updatedAt: new Date(),
  });
}

export async function calendarAccountsOverview(ports: CalendarAccountPorts) {
  return {
    ready: calendarConnectionReady(ports),
    accounts: (await ports.accounts.list()).map(({ id, email, lastError, clientId }) => ({
      id,
      email,
      lastError:
        clientId === ports.config.GOOGLE_OAUTH_CLIENT_ID
          ? lastError
          : 'Reconnect this account after the Google connection settings changed.',
    })),
  };
}
