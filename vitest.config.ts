import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { allocateTestTarget } from './scripts/test-target.js';

/**
 * Every Vitest invocation receives a fresh loopback database URL. Database
 * suites require `pnpm test` to create it; direct unit-suite invocations stay
 * usable without being able to select a shared or remote database.
 */
function isolatedTestTarget(): {
  databaseUrl: string;
  token?: string;
  kind: 'standard' | 'restore';
} {
  const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
  const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  const requestedKind = token ? (process.env.ASSISTANT_TEST_TARGET_KIND ?? 'standard') : 'standard';
  if (requestedKind !== 'standard' && requestedKind !== 'restore')
    throw new Error('ASSISTANT_TEST_TARGET_KIND must be standard or restore.');
  try {
    const target = allocateTestTarget(source, token, requestedKind);
    if (token && (source !== target.databaseUrl || process.env.DATABASE_URL !== source))
      throw new Error('The supplied test target does not match the allocated database URL.');
    return { databaseUrl: target.databaseUrl, kind: target.kind, ...(token ? { token } : {}) };
  } catch (error) {
    if (token) throw error;
    // A shell can contain a remote development URL. Unit suites should remain
    // runnable, while database tests fail locally unless `pnpm test` created
    // their unique disposable target.
    const target = allocateTestTarget(undefined);
    return { databaseUrl: target.databaseUrl, kind: target.kind };
  }
}

const target = isolatedTestTarget();

/**
 * Projects that never touch PostgreSQL run their files in parallel; the
 * integration projects explicitly inherit the root configuration and run in
 * distinct sequence groups. They share one database: files in different
 * projects must not overlap either, including temporary owners and triggers.
 */
const parallel = (root: string) => ({
  extends: true as const,
  test: { root, fileParallelism: true },
});

const serial = (root: string, groupOrder: number) => ({
  extends: true as const,
  test: {
    root,
    name: root === 'scripts' ? 'scripts' : `@assistant/${root.split('/').at(-1)}`,
    fileParallelism: false,
    sequence: { groupOrder },
  },
});

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: target.databaseUrl,
      TEST_DATABASE_URL: target.databaseUrl,
      ...(target.token ? { ASSISTANT_TEST_TARGET_TOKEN: target.token } : {}),
      ASSISTANT_TEST_TARGET_KIND: target.kind,
    },
    // Serial project definitions below also serialize shared-database groups.
    fileParallelism: false,
    projects: [
      serial('packages/application', 1),
      serial('packages/core', 2),
      serial('packages/db', 3),
      // Serial since the watches e2e suite moved in with the watches module —
      // it shares the one database with the other integration projects.
      serial('packages/modules', 4),
      serial('packages/tools', 5),
      serial('apps/agent', 6),
      parallel('packages/persistence'),
      {
        extends: true,
        test: {
          root: 'packages/firestore',
          env: { METADATA_SERVER_DETECTION: 'none' },
          // The emulator shares a transaction lock manager across installation
          // roots. Keep files serial while preserving each test's deliberate
          // concurrent operations and their race assertions.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      parallel('packages/config'),
      parallel('packages/setup'),
      // Fixture and recovery scripts share the allocated PostgreSQL database.
      serial('scripts', 7),
      {
        ...parallel('apps/web'),
        // Next resolves "@/..." from the app's tsconfig paths; vitest does not
        // read those, so without this any web test that imports a component
        // reaching for @/lib fails to resolve the package rather than the file.
        resolve: {
          alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) },
        },
      },
      parallel('workers/browser-job'),
      parallel('workers/code-runner'),
      parallel('workers/document-processor'),
    ],
  },
});
