import { isolatedTestEnvironment } from './test-target.js';

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
