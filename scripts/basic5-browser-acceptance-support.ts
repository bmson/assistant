import { createRequire } from 'node:module';
import { isolatedTestEnvironment } from './test-target.js';

const require = createRequire(import.meta.url);
const nextHtmlParser =
  require('../apps/web/node_modules/next/dist/compiled/node-html-parser/index.js') as {
    parse: (html: string) => {
      textContent: string;
      querySelectorAll: (selector: string) => Array<{
        tagName: string;
        attributes: Record<string, string>;
        rawAttrs: string;
        outerHTML: string;
        parentNode?: { tagName?: string; parentNode?: unknown } | null;
        getAttribute: (name: string) => string | null;
      }>;
    };
  };

const ANONYMOUS_RESPONSE_BODY_LIMIT = 64 * 1024;
const ANONYMOUS_RESPONSE_TEXT_LIMIT = 2_048;
const ANONYMOUS_PROTECTED_MARKER_LIMIT = 32;
const ANONYMOUS_SIGNIN_PATH = '/api/auth/signin';

function anonymousResponseError(): never {
  throw new Error('BASIC5 anonymous person-page response did not satisfy the auth boundary');
}

function isExpectedSigninLocation(value: string, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const target = new URL(value, base);
    return (
      target.origin === base.origin &&
      target.pathname === ANONYMOUS_SIGNIN_PATH &&
      target.search === '' &&
      target.hash === '' &&
      target.username === '' &&
      target.password === ''
    );
  } catch {
    return false;
  }
}

function streamedSigninRedirect(body: Buffer, contentType: string | undefined): boolean {
  if (!contentType || !/^text\/html(?:\s*;|$)/i.test(contentType)) return false;
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return false;
  }
  let document: ReturnType<typeof nextHtmlParser.parse>;
  try {
    document = nextHtmlParser.parse(html);
  } catch {
    return false;
  }
  const elements = document.querySelectorAll('*');
  if (elements.some((element) => element.tagName.toLowerCase() === 'base')) return false;
  const htmlElements = elements.filter((element) => element.tagName.toLowerCase() === 'html');
  const heads = elements.filter((element) => element.tagName.toLowerCase() === 'head');
  const bodies = elements.filter((element) => element.tagName.toLowerCase() === 'body');
  if (
    htmlElements.length > 1 ||
    heads.length > 1 ||
    bodies.length > 1 ||
    (htmlElements.length === 0 && (heads.length > 0 || bodies.length > 0)) ||
    (htmlElements.length === 1 && (heads.length !== 1 || bodies.length !== 1))
  )
    return false;
  const refreshes = elements.filter(
    (element) =>
      element.tagName.toLowerCase() === 'meta' &&
      (element.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh',
  );
  const redirectMarkers = elements.filter(
    (element) => element.getAttribute('id') === '__next-page-redirect',
  );
  if (refreshes.length !== 1 || redirectMarkers.length !== 1 || refreshes[0] !== redirectMarkers[0])
    return false;
  const marker = redirectMarkers[0];
  const serializedMarker = marker ? `<meta ${marker.rawAttrs}>` : '';
  if (
    !marker ||
    Object.keys(marker.attributes).length !== 3 ||
    marker.outerHTML !==
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin">' ||
    (!html.includes(serializedMarker) && !html.includes(serializedMarker.replace(/>$/, '/>'))) ||
    marker.rawAttrs !==
      'id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/auth/signin"'
  )
    return false;
  let ancestor = marker.parentNode;
  let markerIsInAuthDocumentContext = false;
  let markerIsUnderHtml = false;
  while (ancestor?.tagName) {
    const tag = ancestor.tagName.toLowerCase();
    if (!['html', 'head', 'body'].includes(tag)) return false;
    if (tag === 'head' || tag === 'body') markerIsInAuthDocumentContext = true;
    if (tag === 'html') markerIsUnderHtml = true;
    ancestor = ancestor.parentNode as typeof ancestor;
  }
  if (htmlElements.length === 0) {
    if (marker.parentNode?.tagName || markerIsUnderHtml) return false;
  } else if (!markerIsUnderHtml || !markerIsInAuthDocumentContext) {
    return false;
  }
  return marker.getAttribute('content') === `1;url=${ANONYMOUS_SIGNIN_PATH}`;
}

function hasStreamRedirectMarkup(body: Buffer): boolean {
  if (body.length === 0) return false;
  try {
    const html = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const elements = nextHtmlParser.parse(html).querySelectorAll('*');
    return elements.some(
      (element) =>
        element.getAttribute('id') === '__next-page-redirect' ||
        (element.tagName.toLowerCase() === 'meta' &&
          (element.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh'),
    );
  } catch {
    return true;
  }
}

function decodeEscapedCharacters(value: string): string {
  return value.replace(
    /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
    (_match, braced: string | undefined, unicode: string | undefined, hex: string | undefined) => {
      const code = Number.parseInt(braced ?? unicode ?? hex ?? '', 16);
      if (!Number.isFinite(code) || code > 0x10ffff) return '';
      return braced === undefined ? String.fromCharCode(code) : String.fromCodePoint(code);
    },
  );
}

/**
 * Accept only the two Next HTML page-auth representations for the configured
 * Google sign-in route. The body and URL are never included in diagnostics.
 */
export function assertBasic5AnonymousPageResponse(input: {
  status: number;
  location?: string;
  contentType?: string;
  body: Buffer;
  baseUrl: string;
  protectedMarkers: readonly string[];
}): void {
  if (
    !Number.isInteger(input.status) ||
    !Buffer.isBuffer(input.body) ||
    input.body.length > ANONYMOUS_RESPONSE_BODY_LIMIT ||
    input.baseUrl.length > ANONYMOUS_RESPONSE_TEXT_LIMIT ||
    (input.location !== undefined && input.location.length > ANONYMOUS_RESPONSE_TEXT_LIMIT) ||
    (input.contentType !== undefined && input.contentType.length > 256) ||
    input.protectedMarkers.length > ANONYMOUS_PROTECTED_MARKER_LIMIT ||
    input.protectedMarkers.length === 0 ||
    input.protectedMarkers.some(
      (marker) =>
        typeof marker !== 'string' ||
        marker.length === 0 ||
        marker.length > ANONYMOUS_RESPONSE_TEXT_LIMIT,
    )
  )
    anonymousResponseError();

  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    anonymousResponseError();
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    anonymousResponseError();

  let accepted = false;
  if (
    input.status === 307 &&
    input.location !== undefined &&
    !hasStreamRedirectMarkup(input.body)
  ) {
    accepted = isExpectedSigninLocation(input.location, base.href);
  } else if (
    input.status === 200 &&
    input.location === undefined &&
    streamedSigninRedirect(input.body, input.contentType)
  ) {
    accepted = true;
  }
  if (!accepted) anonymousResponseError();

  let rawBody: string;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true }).decode(input.body);
  } catch {
    anonymousResponseError();
  }
  let document: ReturnType<typeof nextHtmlParser.parse>;
  try {
    document = nextHtmlParser.parse(rawBody);
  } catch {
    anonymousResponseError();
  }
  const searchableContent = [
    rawBody,
    document.textContent,
    ...document.querySelectorAll('*').flatMap((element) => Object.values(element.attributes)),
  ];
  const decodedContent = [...searchableContent, ...searchableContent.map(decodeEscapedCharacters)];
  for (const marker of input.protectedMarkers) {
    const jsonEscaped = JSON.stringify(marker).slice(1, -1);
    if (decodedContent.some((part) => part.includes(marker) || part.includes(jsonEscaped)))
      anonymousResponseError();
  }
}

export const BASIC5_BROWSER_ACTIONS = [
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const;

export const BASIC5_FIXTURE_MODEL_ID = 'gw:basic5-fixture:embedding';
export const BASIC5_FIXTURE_CONNECTION_ID = 'basic5-fixture';
export const BASIC5_EMBEDDING_DIMENSIONS = 1_536;
export const BASIC5_AUTH_COOKIE_NAME = 'authjs.session-token';
export const BASIC5_READINESS_ATTEMPT_LIMIT = 451;
const AUTH_COOKIE_CHUNK_LIMIT = 4_096 - 160;
const FORM_SESSION_SCOPE = /^[A-Za-z0-9_-]{16,128}$/;
type AuthJsJwt = {
  encode(input: {
    secret: string;
    salt: string;
    maxAge: number;
    token: Record<string, unknown>;
  }): Promise<string>;
  decode(input: { secret: string; salt: string; token: string }): Promise<unknown>;
};

export function nextBasic5ReadinessAttempt(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= BASIC5_READINESS_ATTEMPT_LIMIT)
    throw new Error('BASIC5 readiness attempt limit exceeded');
  return current + 1;
}

/** Use the explicitly installed CI channel; local runs keep Playwright's existing default. */
export function basic5BrowserLaunchOptions(isCi: boolean): {
  headless: true;
  channel?: 'chrome';
} {
  return isCi ? { headless: true, channel: 'chrome' } : { headless: true };
}

async function authJsJwt(): Promise<AuthJsJwt> {
  // Resolve the official package through the web app's declared dependency.
  return (await import(
    new URL('../apps/web/node_modules/next-auth/jwt.js', import.meta.url).href
  )) as AuthJsJwt;
}

/** Official Auth.js JWE cookie. Synthetic owner claims exercise cookie decode, not OAuth sign-in. */
export async function createBasic5AuthCookie(input: {
  email: string;
  subject: string;
  formSessionScope: string;
  secret: string;
}): Promise<{ name: string; value: string }> {
  if (
    !input.email.includes('@') ||
    !input.subject ||
    !FORM_SESSION_SCOPE.test(input.formSessionScope)
  )
    throw new Error('Invalid synthetic Auth.js session claims');
  if (Buffer.byteLength(input.secret) < 32)
    throw new Error('Synthetic Auth.js session secret must be at least 32 bytes');
  const { encode } = await authJsJwt();
  const value = await encode({
    secret: input.secret,
    salt: BASIC5_AUTH_COOKIE_NAME,
    maxAge: 60 * 60,
    token: {
      sub: input.subject,
      email: input.email,
      name: 'Synthetic acceptance owner',
      assistantFormSessionScope: input.formSessionScope,
    },
  });
  if (value.length >= AUTH_COOKIE_CHUNK_LIMIT)
    throw new Error('Synthetic Auth.js cookie exceeds the single-cookie acceptance limit');
  return { name: BASIC5_AUTH_COOKIE_NAME, value };
}

export async function decodeBasic5AuthCookie(
  cookie: { name: string; value: string },
  secret: string,
) {
  const { decode } = await authJsJwt();
  return decode({ secret, salt: cookie.name, token: cookie.value });
}

/** Use actual application environment names, but force all known credentials empty before dotenv loads. */
export function basic5IsolatedWebEnvironment(input: {
  source: NodeJS.ProcessEnv;
  databaseUrl: string;
  targetToken: string;
  ownerEmail: string;
  ownerName: string;
  authSecret: string;
  emptyHome: string;
  authUrl: string;
  embeddingBaseUrl: string;
  denyEgressPreloader: string;
}): NodeJS.ProcessEnv {
  const sanitizedSource = isolatedTestEnvironment(input.source);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER']) {
    if (sanitizedSource[key] !== undefined) env[key] = sanitizedSource[key];
  }
  const credentialKeys = [
    'OPENROUTER_API_KEY',
    'VERTEX_PROJECT',
    'VERTEX_LOCATION',
    'AUTH_GOOGLE_SECRET',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'BOT_GOOGLE_REFRESH_TOKEN',
    'MOBILE_API_TOKEN',
    'INTERNAL_API_SECRET',
    'INTERNAL_OIDC_AUDIENCE',
    'INTERNAL_OIDC_SERVICE_ACCOUNT',
    'GMAIL_PUSH_SERVICE_ACCOUNT',
    'TWILIO_AUTH_TOKEN',
    'LOCATION_PING_SECRET',
    'PROFILE_ENC_KEY',
    'MCP_ENC_KEY',
    'SEARCH_API_KEY',
    'GITHUB_TOKEN',
    'SELF_REPAIR_OPENAI_API_KEY',
    'SELF_REPAIR_GITHUB_TOKEN',
    'APNS_PRIVATE_KEY',
    'MAPKIT_PRIVATE_KEY',
    'OPENAI_BILLING_ADMIN_KEY_ENCRYPTED',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_KEYFILE_JSON',
    'GCLOUD_AUTH_CREDENTIAL_FILE_OVERRIDE',
  ];
  for (const key of credentialKeys) env[key] = '';
  const preloader = `--import=${input.denyEgressPreloader}`;
  Object.assign(env, {
    NODE_OPTIONS: preloader,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: input.databaseUrl,
    TEST_DATABASE_URL: input.databaseUrl,
    ASSISTANT_TEST_TARGET_TOKEN: input.targetToken,
    ASSISTANT_TEST_TARGET_KIND: 'standard',
    ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1',
    PERSISTENCE_DRIVER: 'postgres',
    OWNER_EMAIL: input.ownerEmail,
    OWNER_NAME: input.ownerName,
    ASSISTANT_EMAIL: input.ownerEmail,
    ASSISTANT_NAME: input.ownerName,
    OWNER_PHONE: '',
    AUTH_URL: input.authUrl,
    AUTH_SECRET: input.authSecret,
    AUTH_GOOGLE_ID: 'basic5-fixture.apps.googleusercontent.test',
    AUTH_GOOGLE_SECRET: 'synthetic-auth-cookie-only-secret',
    AUTH_TRUST_HOST: 'true',
    AUTH_DEV_BYPASS: 'false',
    AUTH_LOCALHOST_BYPASS: 'false',
    OWNER_AUTH_MODE: 'google',
    LLM_PROVIDER: 'vertex',
    OPENROUTER_API_KEY: '',
    RESTORE_REHEARSAL: 'false',
    ASSISTANT_RELEASE_WRITES_PAUSED: 'false',
    POSTGRES_SOURCE_WRITES_FENCED: 'false',
    BASIC5_FIXTURE_EMBEDDING_BASE_URL: input.embeddingBaseUrl,
    HOME: input.emptyHome,
  });
  return env;
}

/** Strict local OpenAI-compatible response: no input text is echoed or logged. */
export function basic5EmbeddingResponse(body: unknown): {
  object: 'list';
  data: { object: 'embedding'; embedding: number[]; index: number }[];
  model: 'embedding';
  usage: { prompt_tokens: number; total_tokens: number };
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid embedding fixture request');
  const input = (body as { input?: unknown }).input;
  const count = Array.isArray(input) ? input.length : typeof input === 'string' ? 1 : 0;
  if (count < 1 || count > 100) throw new Error('Embedding fixture input count is out of bounds');
  const embedding = Array.from({ length: BASIC5_EMBEDDING_DIMENSIONS }, (_, index) =>
    index === 0 ? 1 : 0,
  );
  return {
    object: 'list',
    data: Array.from({ length: count }, (_, index) => ({
      object: 'embedding' as const,
      embedding,
      index,
    })),
    model: 'embedding',
    usage: { prompt_tokens: count, total_tokens: count },
  };
}

export interface Basic5ObservedPost {
  command: string;
  operationId: string;
  authority: string;
  outcome: string;
}

/** Require one real apply receipt for each authorized save, in the planned order. */
export function assertBasic5ReceiptSequence(posts: readonly Basic5ObservedPost[]): void {
  if (
    posts.length !== BASIC5_BROWSER_ACTIONS.length ||
    posts.some(
      (post, index) =>
        post.command !== BASIC5_BROWSER_ACTIONS[index] ||
        post.authority !== 'operation_receipt' ||
        post.outcome !== 'saved' ||
        !/^[0-9a-f-]{36}$/i.test(post.operationId),
    ) ||
    new Set(posts.map((post) => post.operationId)).size !== BASIC5_BROWSER_ACTIONS.length
  )
    throw new Error('BASIC5 acceptance did not produce four distinct saved operation receipts');
}
