import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const targetUrl = 'postgres://assistant@127.0.0.1:1/assistant_0123456789abcdef01234567_test';

function runPreparation(env: NodeJS.ProcessEnv) {
  return spawnSync('pnpm', ['exec', 'tsx', 'packages/db/src/test-db.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

describe('destructive test preparation boundary', () => {
  it('refuses a shared _test URL without allocator ownership before connecting', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: targetUrl,
      TEST_DATABASE_URL: targetUrl,
    };
    delete env.ASSISTANT_TEST_TARGET_TOKEN;

    const result = runPreparation(env);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('An allocated test target token is required');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });

  it('refuses production before connecting even with an allocator-shaped target', () => {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: targetUrl,
      TEST_DATABASE_URL: targetUrl,
      ASSISTANT_TEST_TARGET_TOKEN: '0123456789abcdef01234567',
    };

    const result = runPreparation(env);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('Refusing to reset a test database with NODE_ENV=production');
    expect(result.stderr).not.toContain('ECONNREFUSED');
  });
});
