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
  const standalone = path.join(webNext, 'standalone/apps/web');
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
  await mkdir(path.join(standalone, 'node_modules'), { recursive: true });
  await symlink(
    path.dirname(workspacePackage),
    path.join(standalone, 'node_modules/shared'),
    'dir',
  );
  const manifestPath = path.join(traceRoot, 'page.nft.json');
  const refs = [
    path.relative(traceRoot, path.join(standalone, 'server.js')),
    path.relative(traceRoot, workspacePackage),
  ].map((value) => value.split(path.sep).join('/'));
  await writeFile(manifestPath, JSON.stringify({ version: 1, files: refs }));
  return { root, repo, standalone, traceRoot, manifestPath, workspacePackage };
}

function input(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    repositoryRoot: value.repo,
    standaloneRoot: value.standalone,
    sourceCommit: 'a'.repeat(40),
    sourceWebTree: 'b'.repeat(40),
    nodeVersion: 'v26.2.0',
    imageOS: 'ubuntu24',
    imageVersion: '2026-10-20.1',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('BASIC5 CI build provenance observation', () => {
  it('hashes the existing standalone closure and reports bounded trace coverage honestly', async () => {
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
      output: {
        buildId: 'build-123',
        closureFileCount: expect.any(Number),
        closureSymlinkCount: 1,
        staticPresent: true,
        staticFileCount: 1,
        publicPresent: true,
        publicFileCount: 1,
      },
      traces: {
        scope: 'apps/web/.next/server',
        status: 'complete',
        manifestCount: 1,
        referenceCount: 2,
        resolvedCheckoutReferenceCount: 2,
        matchedClosureContentCount: 2,
        unmatchedReferenceCount: 0,
      },
      buildExecutionAttribution: 'unknown-cache-may-have-reused-output',
    });
    expect(observed.output.serverSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.output.closureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.traces.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports a missing trace reference as incomplete rather than zero coverage', async () => {
    const value = await fixture();
    await writeFile(
      value.manifestPath,
      JSON.stringify({ version: 1, files: ['missing-runtime.js'] }),
    );
    const observed = await observeBasic5CiBuildProvenance(input(value));
    expect(observed.traces).toMatchObject({
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
    const observed = await observeBasic5CiBuildProvenance(input(value));
    expect(observed.traces).toMatchObject({
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
      'escaped both standalone artifact and CI checkout',
    );
  });

  it('rejects trace directories that escape the checkout', async () => {
    const value = await fixture();
    await rm(value.traceRoot, { recursive: true });
    const outside = path.join(value.root, 'outside-traces');
    await mkdir(outside);
    await writeFile(path.join(outside, 'page.nft.json'), JSON.stringify({ version: 1, files: [] }));
    await symlink(outside, value.traceRoot, 'dir');
    await expect(observeBasic5CiBuildProvenance(input(value))).rejects.toThrow(
      'trace directory escaped checkout/artifact',
    );
  });

  it('fails explicitly when trace input exceeds its byte bound', async () => {
    const value = await fixture();
    await truncate(value.manifestPath, 2 * 1024 * 1024 + 1);
    await expect(observeBasic5CiBuildProvenance(input(value))).rejects.toThrow(
      'trace manifest missing or exceeds its byte bound',
    );
  });
});
