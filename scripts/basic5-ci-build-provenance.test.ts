import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observeBasic5CiBuildProvenance } from './basic5-ci-build-provenance.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'basic5-ci-provenance-'));
  roots.push(root);
  const repo = path.join(root, 'checkout');
  const webNext = path.join(repo, 'apps/web/.next');
  const artifactRoot = path.join(webNext, 'standalone');
  const standalone = path.join(artifactRoot, 'apps/web');
  const traceRoot = path.join(webNext, 'server');
  await mkdir(path.join(standalone, '.next/static'), { recursive: true });
  await mkdir(path.join(standalone, 'public'), { recursive: true });
  await mkdir(traceRoot, { recursive: true });
  await writeFile(path.join(standalone, '.next/BUILD_ID'), 'build-123\n');
  await writeFile(path.join(standalone, 'server.js'), 'synthetic standalone server bytes');
  await writeFile(path.join(standalone, '.next/static/chunk.js'), 'static bytes');
  await writeFile(path.join(standalone, 'public/icon.svg'), '<svg/>');
  const workspacePackage = path.join(repo, 'packages/shared/index.js');
  await mkdir(path.dirname(workspacePackage), { recursive: true });
  await writeFile(workspacePackage, 'workspace package bytes');
  const copiedWorkspacePackage = path.join(artifactRoot, 'apps/web/packages/shared/index.js');
  await mkdir(path.dirname(copiedWorkspacePackage), { recursive: true });
  await writeFile(copiedWorkspacePackage, 'workspace package bytes');
  await mkdir(path.join(standalone, 'node_modules'), { recursive: true });
  await symlink(
    path.dirname(copiedWorkspacePackage),
    path.join(standalone, 'node_modules/shared'),
    'dir',
  );
  const manifestPath = path.join(traceRoot, 'page.nft.json');
  const refs = [
    path.relative(traceRoot, path.join(standalone, 'server.js')),
    path.relative(traceRoot, workspacePackage),
  ].map((value) => value.split(path.sep).join('/'));
  await writeFile(manifestPath, JSON.stringify({ version: 1, files: refs }));
  return { root, repo, artifactRoot, standalone, traceRoot, manifestPath, workspacePackage };
}

function input(
  value: Awaited<ReturnType<typeof fixture>>,
  options: { collectTraceDiagnostic?: boolean } = {},
) {
  return {
    repositoryRoot: value.repo,
    artifactRoot: value.artifactRoot,
    serverRoot: value.standalone,
    sourceCommit: 'a'.repeat(40),
    sourceWebTree: 'b'.repeat(40),
    nodeVersion: 'v26.2.0',
    imageOS: 'ubuntu24',
    imageVersion: '2026-10-20.1',
    ...options,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('BASIC5 CI build provenance observation', () => {
  it('hashes the required standalone artifact without collecting trace diagnostics by default', async () => {
    const value = await fixture();
    const observed = await observeBasic5CiBuildProvenance(input(value));
    expect(observed).toMatchObject({
      schemaVersion: 1,
      kind: 'basic5-ci-build-provenance',
      source: {
        commit: 'a'.repeat(40),
        webTree: 'b'.repeat(40),
        cleanCheckoutVerifiedByHelper: false,
      },
      runtime: { nodeVersion: 'v26.2.0', imageOS: 'ubuntu24', imageVersion: '2026-10-20.1' },
      requiredArtifactIdentity: {
        buildId: 'build-123',
        buildIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        serverSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeInventoryEntryCount: expect.any(Number),
        runtimeInventoryFileCount: expect.any(Number),
        runtimeInventorySymlinkCount: 1,
        staticAssets: {
          present: true,
          fileCount: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        publicAssets: {
          present: true,
          fileCount: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      diagnosticTraceCompleteness: {
        scope: 'apps/web/.next/server',
        collection: 'not_requested',
        status: 'not_collected',
        manifestCount: null,
        manifestBytes: null,
        manifestSha256: null,
        referenceCount: null,
        resolvedCheckoutReferenceCount: null,
        matchedClosureContentCount: null,
        unmatchedReferenceCount: null,
      },
      buildExecutionAttribution: 'unknown-cache-may-have-reused-output',
    });
    expect(observed.requiredArtifactIdentity.runtimeInventorySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not read or parse malformed trace input during routine artifact verification', async () => {
    const value = await fixture();
    await writeFile(value.manifestPath, '{ malformed trace JSON');
    await expect(observeBasic5CiBuildProvenance(input(value))).resolves.toMatchObject({
      diagnosticTraceCompleteness: {
        collection: 'not_requested',
        status: 'not_collected',
        manifestCount: null,
        manifestSha256: null,
        referenceCount: null,
      },
    });
  });

  it('changes the required static asset fingerprint when a required asset changes', async () => {
    const value = await fixture();
    const before = await observeBasic5CiBuildProvenance(input(value));
    await writeFile(path.join(value.standalone, '.next/static/chunk.js'), 'changed static bytes');
    const after = await observeBasic5CiBuildProvenance(input(value));
    expect(after.requiredArtifactIdentity.staticAssets.sha256).not.toBe(
      before.requiredArtifactIdentity.staticAssets.sha256,
    );
    expect(after.requiredArtifactIdentity.publicAssets.sha256).toBe(
      before.requiredArtifactIdentity.publicAssets.sha256,
    );
  });

  it.each([
    ['static', '.next/static/chunk.js', 'required standalone static assets are missing'],
    ['public', 'public/icon.svg', 'required standalone public assets are missing'],
  ])('rejects an empty required %s asset directory', async (_label, relativeFile, expected) => {
    const value = await fixture();
    await rm(path.join(value.standalone, relativeFile));
    await expect(observeBasic5CiBuildProvenance(input(value))).rejects.toThrow(expected);
  });

  it('rejects a missing standalone server entrypoint', async () => {
    const value = await fixture();
    await rm(path.join(value.standalone, 'server.js'));
    await expect(observeBasic5CiBuildProvenance(input(value))).rejects.toThrow();
  });

  it('collects complete bounded trace coverage only when explicitly requested', async () => {
    const value = await fixture();
    const observed = await observeBasic5CiBuildProvenance(
      input(value, { collectTraceDiagnostic: true }),
    );
    expect(observed.diagnosticTraceCompleteness).toMatchObject({
      collection: 'collected',
      status: 'complete',
      manifestCount: 1,
      referenceCount: 2,
      resolvedCheckoutReferenceCount: 2,
      matchedClosureContentCount: 2,
      unmatchedReferenceCount: 0,
    });
    expect(observed.diagnosticTraceCompleteness.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reproduces a monorepo standalone payload with shared dependencies above the server root', async () => {
    const value = await fixture();
    const sharedDependency = path.join(
      value.artifactRoot,
      'node_modules/@workspace/shared/index.js',
    );
    await mkdir(path.dirname(sharedDependency), { recursive: true });
    await writeFile(sharedDependency, 'copied shared dependency bytes');
    await writeFile(
      value.manifestPath,
      JSON.stringify({
        version: 1,
        files: [
          path.relative(value.traceRoot, path.join(value.standalone, 'server.js')),
          path.relative(value.traceRoot, sharedDependency),
        ].map((reference) => reference.split(path.sep).join('/')),
      }),
    );

    const observed = await observeBasic5CiBuildProvenance(
      input(value, { collectTraceDiagnostic: true }),
    );

    expect(observed.diagnosticTraceCompleteness).toMatchObject({
      collection: 'collected',
      status: 'complete',
      referenceCount: 2,
      resolvedCheckoutReferenceCount: 2,
      matchedClosureContentCount: 2,
      unmatchedReferenceCount: 0,
    });
    expect(observed.requiredArtifactIdentity.runtimeInventoryFileCount).toBeGreaterThan(3);
  });

  it('requires the nested server root to remain inside the complete standalone artifact', async () => {
    const value = await fixture();
    await expect(
      observeBasic5CiBuildProvenance({
        ...input(value),
        serverRoot: value.repo,
      }),
    ).rejects.toThrow('standalone server root must be inside the complete artifact root');
  });

  it('reports a missing trace reference as incomplete rather than zero coverage', async () => {
    const value = await fixture();
    await writeFile(
      value.manifestPath,
      JSON.stringify({ version: 1, files: ['missing-runtime.js'] }),
    );
    const observed = await observeBasic5CiBuildProvenance(
      input(value, { collectTraceDiagnostic: true }),
    );
    expect(observed.diagnosticTraceCompleteness).toMatchObject({
      collection: 'collected',
      status: 'incomplete',
      manifestCount: 1,
      referenceCount: 1,
      resolvedCheckoutReferenceCount: 0,
      matchedClosureContentCount: 0,
      unmatchedReferenceCount: 1,
    });
  });

  it('labels absent trace manifests unavailable instead of asserting zero references', async () => {
    const value = await fixture();
    await rm(value.traceRoot, { recursive: true });
    const observed = await observeBasic5CiBuildProvenance(
      input(value, { collectTraceDiagnostic: true }),
    );
    expect(observed.diagnosticTraceCompleteness).toMatchObject({
      collection: 'collected',
      status: 'unavailable',
      manifestCount: 0,
      manifestSha256: null,
    });
  });

  it('rejects artifact symlinks that escape both the checkout and standalone root', async () => {
    const value = await fixture();
    const outside = path.join(value.root, 'outside.txt');
    await writeFile(outside, 'outside bytes');
    await symlink(outside, path.join(value.standalone, 'escape.txt'));
    await expect(observeBasic5CiBuildProvenance(input(value))).rejects.toThrow(
      'symlink target escaped standalone artifact',
    );
  });

  it('rejects runtime symlinks that escape the artifact into the checkout', async () => {
    const value = await fixture();
    await symlink(
      path.dirname(value.workspacePackage),
      path.join(value.standalone, 'node_modules/checkout-escape'),
      'dir',
    );
    await expect(observeBasic5CiBuildProvenance(input(value))).rejects.toThrow(
      'symlink target escaped standalone artifact',
    );
  });

  it('rejects trace directories that escape the checkout', async () => {
    const value = await fixture();
    await rm(value.traceRoot, { recursive: true });
    const outside = path.join(value.root, 'outside-traces');
    await mkdir(outside);
    await writeFile(path.join(outside, 'page.nft.json'), JSON.stringify({ version: 1, files: [] }));
    await symlink(outside, value.traceRoot, 'dir');
    await expect(
      observeBasic5CiBuildProvenance(input(value, { collectTraceDiagnostic: true })),
    ).rejects.toThrow('trace directory escaped checkout/artifact');
  });

  it('fails explicitly when trace input exceeds its byte bound', async () => {
    const value = await fixture();
    await truncate(value.manifestPath, 2 * 1024 * 1024 + 1);
    await expect(
      observeBasic5CiBuildProvenance(input(value, { collectTraceDiagnostic: true })),
    ).rejects.toThrow('trace manifest missing or exceeds its byte bound');
  });
});
