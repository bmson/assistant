import { describe, expect, it } from 'vitest';
import {
  allocateTestTarget,
  assertAllocatedTestTarget,
  assertTestCleanupOwnership,
  isolatedTestEnvironment,
} from './test-target.js';

describe('disposable test target', () => {
  const token = '0123456789abcdef01234567';

  it('allocates a unique name while retaining only local connection details', () => {
    const first = allocateTestTarget('postgres://user:pass@127.0.0.1:5432/assistant', token);
    const second = allocateTestTarget(
      'postgres://user:pass@127.0.0.1:5432/assistant',
      'fedcba9876543210fedcba98',
    );

    expect(new URL(first.databaseUrl).pathname).toBe(`/assistant_${token}_test`);
    expect(first.databaseUrl).toContain('user:pass@127.0.0.1:5432');
    expect(first.databaseName).not.toBe(second.databaseName);
    expect(() =>
      allocateTestTarget('postgres://user:pass@db.example.com/assistant', token),
    ).toThrow('non-local PostgreSQL host');
    expect(() => allocateTestTarget('postgres://user:pass@127.999.4.5/assistant', token)).toThrow(
      'non-local PostgreSQL host',
    );
  });

  it('accepts only the exact allocated URL and identity before destructive preparation', () => {
    const target = allocateTestTarget(undefined, token);
    expect(
      assertAllocatedTestTarget({
        databaseUrl: target.databaseUrl,
        testDatabaseUrl: target.databaseUrl,
        token,
      }),
    ).toBe(target.databaseName);
    expect(() =>
      assertAllocatedTestTarget({
        databaseUrl: target.databaseUrl,
        testDatabaseUrl: 'postgres://assistant:assistant@localhost:5432/other_test',
        token,
      }),
    ).toThrow('must be the same allocated test target');
    expect(() =>
      assertAllocatedTestTarget({
        databaseUrl: 'postgres://assistant:assistant@localhost:5432/assistant_test',
        testDatabaseUrl: 'postgres://assistant:assistant@localhost:5432/assistant_test',
        token,
      }),
    ).toThrow('does not match the allocated test target token');
    expect(() =>
      assertAllocatedTestTarget({
        databaseUrl:
          'postgres://assistant:assistant@db.example.com/assistant_test_0123456789abcdef01234567',
        testDatabaseUrl:
          'postgres://assistant:assistant@db.example.com/assistant_test_0123456789abcdef01234567',
        token,
      }),
    ).toThrow('non-local database host');
  });

  it('allocates restore-profile targets and refuses mismatched restore ownership', () => {
    const restore = allocateTestTarget(
      'postgres://user:pass@127.0.0.1:55432/assistant',
      token,
      'restore',
    );
    expect(restore.databaseName).toBe('assistant_restore_0123456789ab_test');
    expect(new URL(restore.databaseUrl).pathname).toBe('/assistant_restore_0123456789ab_test');
    expect(
      assertAllocatedTestTarget({
        databaseUrl: restore.databaseUrl,
        testDatabaseUrl: restore.databaseUrl,
        token,
        kind: 'restore',
      }),
    ).toBe(restore.databaseName);
    expect(
      assertTestCleanupOwnership({
        databaseUrl: restore.databaseUrl,
        testDatabaseUrl: restore.databaseUrl,
        token,
        kind: 'restore',
      }),
    ).toEqual({ databaseName: restore.databaseName, token });
    expect(() =>
      assertAllocatedTestTarget({
        databaseUrl: restore.databaseUrl,
        testDatabaseUrl: restore.databaseUrl,
        token: 'fedcba9876543210fedcba98',
        kind: 'restore',
      }),
    ).toThrow('does not match the allocated test target token');
    expect(() =>
      assertAllocatedTestTarget({
        databaseUrl:
          'postgres://user:pass@db.example.com:55432/assistant_restore_0123456789ab_test',
        testDatabaseUrl:
          'postgres://user:pass@db.example.com:55432/assistant_restore_0123456789ab_test',
        token,
        kind: 'restore',
      }),
    ).toThrow('non-local database host');
    expect(() =>
      assertAllocatedTestTarget({
        databaseUrl: 'postgres://user:pass@127.0.0.1:55432/assistant_restore_fedcba987654_test',
        testDatabaseUrl: 'postgres://user:pass@127.0.0.1:55432/assistant_restore_fedcba987654_test',
        token,
        kind: 'restore',
      }),
    ).toThrow('does not match the allocated test target token');
  });

  it('strips known live provider credentials from test child processes', () => {
    const env = isolatedTestEnvironment({
      OPENROUTER_API_KEY: 'secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
      AUTH_SECRET: 'test-session-secret',
      PATH: '/bin',
    });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.AUTH_SECRET).toBe('test-session-secret');
    expect(env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS).toBe('1');
  });

  it('requires allocator identity for cleanup ownership', () => {
    const target = allocateTestTarget(undefined, token);
    expect(
      assertTestCleanupOwnership({
        databaseUrl: target.databaseUrl,
        testDatabaseUrl: target.databaseUrl,
        token,
      }),
    ).toEqual({ databaseName: target.databaseName, token });
    expect(() =>
      assertTestCleanupOwnership({
        databaseUrl: target.databaseUrl,
        testDatabaseUrl: target.databaseUrl,
        token: undefined,
      }),
    ).toThrow('allocator-owned target token');
  });
});
