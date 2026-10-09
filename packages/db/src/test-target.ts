import { randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DATABASE_URL = 'postgres://assistant:assistant@localhost:55432/assistant';

export interface AllocatedTestTarget {
  databaseUrl: string;
  token: string;
  databaseName: string;
  kind: TestTargetKind;
}

export type TestTargetKind = 'standard' | 'restore';

function targetDatabaseName(token: string, kind: TestTargetKind): string {
  return kind === 'restore'
    ? `assistant_restore_${token.slice(0, 12)}_test`
    : `assistant_${token}_test`;
}

export function testTargetMarkerPath(token: string): string {
  if (!/^[a-f0-9]{24}$/.test(token)) throw new Error('Invalid test target token.');
  return join(tmpdir(), `assistant-test-target-${token}.json`);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'));
}

/** Allocate an unguessable per-run database on a local PostgreSQL server. */
export function allocateTestTarget(
  source: string | undefined,
  token = randomBytes(12).toString('hex'),
  kind: TestTargetKind = 'standard',
): AllocatedTestTarget {
  if (!/^[a-f0-9]{24}$/.test(token))
    throw new Error('Test target token must be 24 lowercase hex characters.');
  if (kind !== 'standard' && kind !== 'restore')
    throw new Error('Test target kind must be standard or restore.');
  let url: URL;
  try {
    url = new URL(source ?? DEFAULT_DATABASE_URL);
  } catch {
    throw new Error('Test database URL is invalid.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Tests require a local PostgreSQL URL.');
  if (!isLoopback(url.hostname))
    throw new Error('Refusing test database allocation on a non-local PostgreSQL host.');
  const databaseName = targetDatabaseName(token, kind);
  if (kind === 'restore' && url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('options');
  return { databaseUrl: url.toString(), token, databaseName, kind };
}

/** Validate both database variables and the identity supplied by the allocator. */
export function assertAllocatedTestTarget(input: {
  databaseUrl: string | undefined;
  testDatabaseUrl: string | undefined;
  token: string | undefined;
  kind?: TestTargetKind;
}): string {
  if (!input.token || !/^[a-f0-9]{24}$/.test(input.token))
    throw new Error('Destructive test preparation requires an allocator-owned target token.');
  if (!input.databaseUrl || !input.testDatabaseUrl || input.databaseUrl !== input.testDatabaseUrl)
    throw new Error('DATABASE_URL and TEST_DATABASE_URL must be the same allocated test target.');
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new Error('Test database URL is invalid.');
  }
  if (!isLoopback(url.hostname))
    throw new Error('Refusing destructive test preparation on a non-local database host.');
  const kind = input.kind ?? 'standard';
  if (kind !== 'standard' && kind !== 'restore')
    throw new Error('Test target kind must be standard or restore.');
  const expectedName = targetDatabaseName(input.token, kind);
  const actualName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (actualName !== expectedName)
    throw new Error('Database name does not match the allocated test target token.');
  return actualName;
}

export function assertTestCleanupOwnership(input: {
  databaseUrl: string | undefined;
  testDatabaseUrl: string | undefined;
  token: string | undefined;
  kind?: TestTargetKind;
}): { databaseName: string; token: string } {
  const databaseName = assertAllocatedTestTarget(input);
  return { databaseName, token: input.token as string };
}

/** Remove credentials that could let fixtures reach paid or customer services. */
export function isolatedTestEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      /^(?:OPENAI|OPENROUTER|ANTHROPIC|GOOGLE|GCP|GCLOUD|GEMINI|VERTEX|TWILIO|SENDGRID|RESEND|GITHUB|GH_|FIRECRAWL|TAVILY|SERP|AWS|AZURE).*(?:API_KEY|TOKEN|CREDENTIAL|KEYFILE|SECRET|ACCESS_KEY|APPLICATION_CREDENTIALS)$/i.test(
        key,
      ) ||
      /^(?:GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_KEYFILE_JSON|GCLOUD_AUTH_CREDENTIAL_FILE_OVERRIDE)$/i.test(
        key,
      )
    )
      delete env[key];
  }
  env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS = '1';
  return env;
}
