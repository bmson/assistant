import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const roleBuilds = [
  {
    role: 'agent',
    dockerfile: 'infra/docker/agent.Dockerfile',
    build: 'pnpm --filter @assistant/agent build',
    command: 'node", "--enable-source-maps", "/app/index.mjs',
  },
  {
    role: 'web',
    dockerfile: 'infra/docker/web.Dockerfile',
    build: 'pnpm --filter @assistant/web build',
    command: 'node", "/app/apps/web/server.js',
  },
  {
    role: 'browser',
    dockerfile: 'infra/docker/browser-job.Dockerfile',
    build: '@assistant/browser-job deploy --prod --legacy /runtime',
    command: 'tsx", "src/index.ts',
  },
  {
    role: 'code',
    dockerfile: 'infra/docker/code-runner.Dockerfile',
    build: '@assistant/code-runner deploy --prod --legacy /runtime',
    command: 'tsx", "src/index.ts',
  },
  {
    role: 'processor',
    dockerfile: 'infra/docker/document-processor.Dockerfile',
    build: '@assistant/document-processor deploy --prod --legacy /runtime',
    command: 'tsx", "src/index.ts',
  },
];

const cloudBuild = await readFile(
  new URL('../../infra/gcp/cloudbuild.yaml', import.meta.url),
  'utf8',
);

test('schema-135 role build definitions keep every released image and entrypoint visible', async () => {
  for (const { role, dockerfile, build, command } of roleBuilds) {
    const source = await readFile(new URL(`../../${dockerfile}`, import.meta.url), 'utf8');
    assert.ok(source.includes(build), `${role} Dockerfile must keep its current build command`);
    assert.ok(
      source.includes(command),
      `${role} Dockerfile must keep its actual runtime entrypoint`,
    );
    assert.ok(cloudBuild.includes(dockerfile), `${role} Cloud Build must name the Dockerfile`);
    assert.ok(cloudBuild.includes(`/${role}:latest`), `${role} image must be tagged latest`);
    assert.ok(
      cloudBuild.includes(`/${role}:\${_TAG}`),
      `${role} immutable source tag must be emitted`,
    );
  }
  assert.ok(cloudBuild.includes('infra/docker/migrate.Dockerfile'));
});

test('migration and portable transport tools remain explicit in the source/build path', async () => {
  const migrateDockerfile = await readFile(
    new URL('../../infra/docker/migrate.Dockerfile', import.meta.url),
    'utf8',
  );
  const migrateSource = await readFile(
    new URL('../../packages/db/src/migrate.ts', import.meta.url),
    'utf8',
  );
  const exportSource = await readFile(
    new URL('../../packages/db/src/workspace-migration.ts', import.meta.url),
    'utf8',
  );
  const importSource = await readFile(
    new URL('../../packages/firestore/src/workspace-migration.ts', import.meta.url),
    'utf8',
  );
  const cliExport = await readFile(
    new URL('../../scripts/workspace-migration-export.ts', import.meta.url),
    'utf8',
  );
  const cliImport = await readFile(
    new URL('../../scripts/workspace-migration-import.ts', import.meta.url),
    'utf8',
  );

  assert.ok(migrateDockerfile.includes('pnpm", "--filter", "@assistant/db", "reconcile'));
  assert.ok(migrateSource.includes('assertCompatibleOwnerEditorMigrationTail'));
  assert.ok(exportSource.includes('exportWorkspaceSnapshot'));
  assert.ok(importSource.includes('importWorkspaceBundle'));
  assert.ok(cliExport.includes('exportWorkspaceSnapshot'));
  assert.ok(cliImport.includes('importWorkspaceBundle'));
});
