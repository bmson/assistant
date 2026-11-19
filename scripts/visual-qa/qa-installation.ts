import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '@assistant/db';
import type { BrowserContext } from 'playwright';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
  type VerifiedScriptTestTarget,
} from '../test-target.js';

function parseLocalOrigin(value: string | undefined): string {
  if (!value) throw new Error('Set ASSISTANT_QA_WEB_ORIGIN to the dedicated local QA server.');
  try {
    const url = new URL(value);
    if (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port &&
      value === url.origin
    )
      return url.origin;
  } catch {
    // Avoid echoing a URL that may contain credentials.
  }
  throw new Error('QA requires a literal loopback HTTP origin with an explicit port.');
}

export function requireQaOrigin(requested: string | undefined, configured: string | undefined) {
  const origin = parseLocalOrigin(configured);
  if (requested !== undefined && parseLocalOrigin(requested) !== origin)
    throw new Error('Requested origin does not match the dedicated QA server.');
  return origin;
}

export async function openQaInstallation(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' || env.ASSISTANT_TEST_TARGET_KIND === 'restore')
    throw new Error('QA requires a disposable QA installation.');
  if (env.DATABASE_URL) {
    let database: URL;
    try {
      database = new URL(env.DATABASE_URL);
    } catch {
      throw new Error('QA requires a valid local PostgreSQL URL.');
    }
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      ['host', 'port', 'options'].some((key) => database.searchParams.has(key))
    )
      throw new Error('QA database URLs cannot override connection routing or session options.');
  }
  const target = assertAllocatedTestTargetMarker({
    databaseUrl: env.DATABASE_URL,
    testDatabaseUrl: env.TEST_DATABASE_URL,
    token: env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const db = createDb(target.databaseUrl, { max: 1, readOnly: true });
  try {
    await assertAllocatedTestDatabaseOwnership(db, target);
    return { db, target };
  } catch (error) {
    await db.$client.end({ timeout: 5 });
    throw error;
  }
}

export async function assertQaWebInstallation(origin: string, target: VerifiedScriptTestTarget) {
  const nonce = randomBytes(16).toString('hex');
  const expected = createHmac('sha256', target.token)
    .update(target.databaseUrl)
    .update(nonce)
    .digest('hex');
  const response = await fetch(new URL('/api/health', origin), {
    headers: { 'x-assistant-qa-nonce': nonce },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok || response.headers.get('x-assistant-qa-proof') !== expected)
    throw new Error('The local web server did not prove it uses the allocated QA installation.');
}

export async function verifyQaBrowserInstallation(origin: string) {
  const { db, target } = await openQaInstallation();
  try {
    await assertQaWebInstallation(origin, target);
    return target;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

export async function restrictQaBrowserContext(context: BrowserContext, base: string) {
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== base || !['GET', 'HEAD'].includes(request.method())) {
      await route.abort();
      return;
    }
    const response = await route.fetch({ maxRedirects: 0 });
    try {
      // Playwright only routes the first hop. Allowing any redirect to reach the browser
      // would let later hops leave the verified origin without another route check.
      if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
        await route.abort();
        return;
      }
      await route.fulfill({ response });
    } finally {
      await response.dispose();
    }
  });
}
