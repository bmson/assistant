import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '@assistant/db';
import { allocateTestTarget, testTargetMarkerPath } from '@assistant/db/test-target';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from './test-target.js';

describe('script fixture target ownership', () => {
  it('requires the exact private allocator marker before a fixture script can connect', async () => {
    const token = randomBytes(12).toString('hex');
    const target = allocateTestTarget(
      'postgres://assistant:assistant@127.0.0.1:55432/assistant',
      token,
    );
    const marker = testTargetMarkerPath(token);
    const input = {
      databaseUrl: target.databaseUrl,
      testDatabaseUrl: target.databaseUrl,
      token,
    };
    try {
      expect(() => assertAllocatedTestTargetMarker(input)).toThrow('private test allocator marker');
      await writeFile(marker, JSON.stringify({ databaseUrl: target.databaseUrl, token }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      expect(assertAllocatedTestTargetMarker(input)).toMatchObject({
        databaseUrl: target.databaseUrl,
        databaseName: target.databaseName,
        token,
      });
      await chmod(marker, 0o644);
      expect(() => assertAllocatedTestTargetMarker(input)).toThrow(
        'allocator marker does not match',
      );
      await chmod(marker, 0o600);
      expect(() =>
        assertAllocatedTestTargetMarker({
          ...input,
          databaseUrl: 'postgres://assistant:assistant@127.0.0.1:55432/assistant',
        }),
      ).toThrow('same allocated test target');
      await expect(
        assertAllocatedTestDatabaseOwnership(
          {
            execute: vi.fn(async () => [
              {
                database_name: target.databaseName,
                ownership_marker: `assistant-test-target:${'f'.repeat(24)}`,
              },
            ]),
          } as unknown as Db,
          target,
        ),
      ).rejects.toThrow('database allocator ownership marker');
      await expect(
        assertAllocatedTestDatabaseOwnership(
          {
            execute: vi.fn(async () => [
              {
                database_name: target.databaseName,
                ownership_marker: `assistant-test-target:${token}`,
              },
            ]),
          } as unknown as Db,
          target,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(marker, { force: true });
    }
  });

  it('rejects a marker symlink instead of following a caller-controlled file', async () => {
    const token = randomBytes(12).toString('hex');
    const target = allocateTestTarget(
      'postgres://assistant:assistant@127.0.0.1:55432/assistant',
      token,
    );
    const marker = testTargetMarkerPath(token);
    const directory = await mkdtemp(path.join(tmpdir(), 'target-marker-'));
    const source = path.join(directory, 'marker.json');
    try {
      await writeFile(source, JSON.stringify({ databaseUrl: target.databaseUrl, token }), {
        mode: 0o600,
      });
      const { symlink } = await import('node:fs/promises');
      await symlink(source, marker);
      expect(() =>
        assertAllocatedTestTargetMarker({
          databaseUrl: target.databaseUrl,
          testDatabaseUrl: target.databaseUrl,
          token,
        }),
      ).toThrow('allocator marker does not match');
    } finally {
      await rm(marker, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
