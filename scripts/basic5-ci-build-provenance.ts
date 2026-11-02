import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export const BASIC5_CI_PROVENANCE_LIMITS = {
  closureEntries: 50_000,
  closureBytes: 2 * 1024 * 1024 * 1024,
  oneFileBytes: 256 * 1024 * 1024,
  traceManifests: 4_096,
  traceManifestBytes: 2 * 1024 * 1024,
  traceBytes: 64 * 1024 * 1024,
  traceReferences: 200_000,
  traceTargetBytes: 2 * 1024 * 1024 * 1024,
} as const;

const HEX_OBJECT = /^[0-9a-f]{40,64}$/;
const BUILD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PATH_BYTES = 4_096;

type RootKind = 'artifact';
type EntryKind = 'directory' | 'file' | 'symlink' | 'symlink-file-content';

interface ClosureEntry {
  path: string;
  kind: EntryKind;
  size: number;
  sha256: string | null;
  targetRoot?: RootKind;
  targetPath?: string;
}

type TraceCoverage = {
  scope: 'apps/web/.next/server';
  status: 'complete' | 'incomplete' | 'unavailable';
  manifestCount: number;
  manifestBytes: number;
  manifestSha256: string | null;
  referenceCount: number;
  resolvedCheckoutReferenceCount: number;
  matchedClosureContentCount: number;
  unmatchedReferenceCount: number;
};

export interface Basic5CiBuildProvenanceInput {
  repositoryRoot: string;
  artifactRoot: string;
  serverRoot: string;
  sourceCommit: string;
  sourceWebTree: string;
  nodeVersion: string;
  imageOS: string;
  imageVersion: string;
  collectTraceDiagnostic?: boolean;
}

export interface Basic5CiBuildProvenance {
  schemaVersion: 1;
  kind: 'basic5-ci-build-provenance';
  source: {
    commit: string;
    webTree: string;
    basis: 'controller-provided-workflow-observation';
    cleanCheckoutVerifiedByHelper: false;
  };
  runtime: {
    nodeVersion: string;
    imageOS: string;
    imageVersion: string;
    basis: 'controller-provided-CI-observation';
  };
  requiredArtifactIdentity: {
    buildId: string;
    buildIdSha256: string;
    serverSha256: string;
    runtimeInventorySha256: string;
    runtimeInventoryEntryCount: number;
    runtimeInventoryFileCount: number;
    runtimeInventorySymlinkCount: number;
    runtimeInventoryBytes: number;
    staticAssets: { present: true; fileCount: number; sha256: string };
    publicAssets: { present: true; fileCount: number; sha256: string };
  };
  diagnosticTraceCompleteness: {
    scope: 'apps/web/.next/server';
    collection: 'not_requested' | 'collected';
    status: 'not_collected' | 'complete' | 'incomplete' | 'unavailable';
    manifestCount: number | null;
    manifestBytes: number | null;
    manifestSha256: string | null;
    referenceCount: number | null;
    resolvedCheckoutReferenceCount: number | null;
    matchedClosureContentCount: number | null;
    unmatchedReferenceCount: number | null;
  };
  buildExecutionAttribution: 'unknown-cache-may-have-reused-output';
  limitations: readonly string[];
}

function fail(message: string): never {
  throw new Error(`BASIC5 CI provenance rejected: ${message}`);
}

function assertString(value: unknown, label: string, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    fail(`${label} is missing or outside its bound`);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function relativePosix(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    fail('path escaped its evidence root');
  const normalized = relative.split(path.sep).join('/');
  if (Buffer.byteLength(normalized) > MAX_PATH_BYTES) fail('path exceeds the path-byte bound');
  return normalized;
}

function targetLocation(
  absolute: string,
  artifactRoot: string,
): {
  root: RootKind;
  path: string;
} {
  if (isInside(artifactRoot, absolute))
    return { root: 'artifact', path: relativePosix(artifactRoot, absolute) };
  fail('symlink target escaped standalone artifact');
}

async function hashFile(
  absolute: string,
  maximum: number,
): Promise<{ sha256: string; size: number }> {
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) fail('expected a regular file');
  if (before.size > maximum) fail('file exceeds its read bound');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    const data = chunk as Buffer;
    bytes += data.length;
    if (bytes > maximum) fail('file grew past its read bound');
    digest.update(data);
  }
  const after = await lstat(absolute);
  if (
    !after.isFile() ||
    after.size !== before.size ||
    bytes !== before.size ||
    after.mtimeMs !== before.mtimeMs
  )
    fail('file changed while its digest was being collected');
  return { sha256: digest.digest('hex'), size: bytes };
}

async function readBytesBounded(absolute: string, maximum: number): Promise<Buffer> {
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) fail('expected a regular file');
  if (before.size > maximum) fail('file exceeds its read bound');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    const data = chunk as Buffer;
    bytes += data.length;
    if (bytes > maximum) fail('file grew past its read bound');
    chunks.push(data);
  }
  const after = await lstat(absolute);
  if (
    !after.isFile() ||
    after.size !== before.size ||
    bytes !== before.size ||
    after.mtimeMs !== before.mtimeMs
  )
    fail('file changed while being read');
  return Buffer.concat(chunks, bytes);
}

async function existsDirectory(absolute: string): Promise<boolean> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await realpath(absolute);
      return (await lstat(target)).isDirectory();
    }
    return info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function enumerateClosure(artifactRoot: string): Promise<{
  entries: ClosureEntry[];
  fileHashes: Set<string>;
  fileBytes: number;
  fileCount: number;
  symlinkCount: number;
}> {
  const entries: ClosureEntry[] = [];
  const fileHashes = new Set<string>();
  let fileBytes = 0;
  let fileCount = 0;
  let symlinkCount = 0;

  const addFile = async (
    absolute: string,
    logical: string,
    kind: 'file' | 'symlink-file-content',
  ) => {
    const result = await hashFile(absolute, BASIC5_CI_PROVENANCE_LIMITS.oneFileBytes);
    fileBytes += result.size;
    fileCount += 1;
    if (fileBytes > BASIC5_CI_PROVENANCE_LIMITS.closureBytes)
      fail('standalone file-byte cap exceeded');
    fileHashes.add(result.sha256);
    entries.push({ path: logical, kind, size: result.size, sha256: result.sha256 });
  };

  const walkDirectory = async (
    absolute: string,
    logical: string,
    ancestorRealPaths: ReadonlySet<string>,
  ): Promise<void> => {
    const canonical = await realpath(absolute);
    if (!isInside(artifactRoot, canonical)) fail('directory escaped standalone artifact');
    if (ancestorRealPaths.has(canonical)) fail('symlink directory cycle detected');
    const nextAncestors = new Set(ancestorRealPaths).add(canonical);
    const directory = await opendir(absolute);
    for await (const entry of directory) {
      const name = entry.name;
      const child = path.join(absolute, name);
      const relative = logical ? `${logical}/${name}` : name;
      if (Buffer.byteLength(relative) > MAX_PATH_BYTES) fail('path exceeds the path-byte bound');
      if (entries.length >= BASIC5_CI_PROVENANCE_LIMITS.closureEntries)
        fail('standalone entry cap exceeded');
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        const realTarget = await realpath(child);
        const location = targetLocation(realTarget, artifactRoot);
        const linkText = await readlink(child);
        const linkBytes = Buffer.from(linkText);
        entries.push({
          path: relative,
          kind: 'symlink',
          size: linkBytes.length,
          sha256: createHash('sha256').update(linkBytes).digest('hex'),
          targetRoot: location.root,
          targetPath: location.path,
        });
        symlinkCount += 1;
        const targetStat = await lstat(realTarget);
        if (targetStat.isDirectory()) {
          await walkDirectory(realTarget, `${relative}/@target`, nextAncestors);
        } else if (targetStat.isFile()) {
          await addFile(realTarget, `${relative}/@target-file`, 'symlink-file-content');
        } else {
          fail('symlink target is not a regular file or directory');
        }
      } else if (childStat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory', size: 0, sha256: null });
        await walkDirectory(child, relative, nextAncestors);
      } else if (childStat.isFile()) {
        await addFile(child, relative, 'file');
      } else {
        fail('unsupported filesystem entry in standalone output');
      }
    }
  };

  await walkDirectory(artifactRoot, '', new Set());
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (entries.length > BASIC5_CI_PROVENANCE_LIMITS.closureEntries)
    fail('standalone entry cap exceeded');
  return { entries, fileHashes, fileBytes, fileCount, symlinkCount };
}

function fingerprintEntries(
  entries: ClosureEntry[],
  root: string,
): { fileCount: number; sha256: string } {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const selected = entries.filter((entry) => entry.path === root || entry.path.startsWith(prefix));
  const fileCount = selected.filter(
    (entry) => entry.kind === 'file' || entry.kind === 'symlink-file-content',
  ).length;
  return {
    fileCount,
    sha256: createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
  };
}

function notRequestedTraceDiagnostic(): Basic5CiBuildProvenance['diagnosticTraceCompleteness'] {
  return {
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
  };
}

async function collectTraceCoverage(
  repositoryRoot: string,
  artifactRoot: string,
  closureHashes: Set<string>,
): Promise<TraceCoverage> {
  const traceRoot = path.join(repositoryRoot, 'apps/web/.next/server');
  if (!(await existsDirectory(traceRoot))) {
    return {
      scope: 'apps/web/.next/server',
      status: 'unavailable',
      manifestCount: 0,
      manifestBytes: 0,
      manifestSha256: null,
      referenceCount: 0,
      resolvedCheckoutReferenceCount: 0,
      matchedClosureContentCount: 0,
      unmatchedReferenceCount: 0,
    };
  }
  const manifests: string[] = [];
  const visited = new Set<string>();
  let walkedEntries = 0;
  const walk = async (directory: string): Promise<void> => {
    const canonical = await realpath(directory);
    if (!isInside(repositoryRoot, canonical) && !isInside(artifactRoot, canonical))
      fail('trace directory escaped checkout/artifact');
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const directoryHandle = await opendir(directory);
    for await (const entry of directoryHandle) {
      const name = entry.name;
      walkedEntries += 1;
      if (walkedEntries > BASIC5_CI_PROVENANCE_LIMITS.closureEntries)
        fail('trace walk entry cap exceeded');
      const child = path.join(directory, name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        const target = await realpath(child);
        if (!isInside(repositoryRoot, target) && !isInside(artifactRoot, target))
          fail('trace walk symlink escaped checkout/artifact');
        const targetStat = await lstat(target);
        if (targetStat.isDirectory()) await walk(target);
        else if (targetStat.isFile() && name.endsWith('.nft.json')) manifests.push(target);
      } else if (stat.isDirectory()) await walk(child);
      else if (stat.isFile() && name.endsWith('.nft.json')) manifests.push(child);
      if (manifests.length > BASIC5_CI_PROVENANCE_LIMITS.traceManifests)
        fail('trace manifest cap exceeded');
    }
  };
  await walk(traceRoot);
  const uniqueManifests = [...new Set(manifests)].sort();
  if (uniqueManifests.length === 0) {
    return {
      scope: 'apps/web/.next/server',
      status: 'unavailable',
      manifestCount: 0,
      manifestBytes: 0,
      manifestSha256: null,
      referenceCount: 0,
      resolvedCheckoutReferenceCount: 0,
      matchedClosureContentCount: 0,
      unmatchedReferenceCount: 0,
    };
  }

  const traceDigest = createHash('sha256');
  const targetHashes = new Map<string, string>();
  let manifestBytes = 0;
  let referenceCount = 0;
  let resolvedCheckoutReferenceCount = 0;
  let matchedClosureContentCount = 0;
  let unmatchedReferenceCount = 0;
  let targetBytes = 0;

  for (const manifestPath of uniqueManifests) {
    const canonicalManifest = await realpath(manifestPath);
    if (!isInside(repositoryRoot, canonicalManifest)) fail('trace manifest escaped checkout');
    const stat = await lstat(canonicalManifest);
    if (!stat.isFile() || stat.size > BASIC5_CI_PROVENANCE_LIMITS.traceManifestBytes)
      fail('trace manifest missing or exceeds its byte bound');
    manifestBytes += stat.size;
    if (manifestBytes > BASIC5_CI_PROVENANCE_LIMITS.traceBytes) fail('trace bytes cap exceeded');
    const bytes = await readBytesBounded(
      canonicalManifest,
      BASIC5_CI_PROVENANCE_LIMITS.traceManifestBytes,
    );
    if (bytes.length !== stat.size) fail('trace manifest changed while being read');
    const manifestHash = createHash('sha256').update(bytes).digest('hex');
    traceDigest.update(`${relativePosix(repositoryRoot, canonicalManifest)}\0${manifestHash}\n`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('trace manifest JSON is invalid');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { files?: unknown }).files)
    )
      fail('trace manifest schema is unsupported');
    const files = (parsed as { files: unknown[] }).files;
    for (const reference of files) {
      if (
        typeof reference !== 'string' ||
        reference.length === 0 ||
        reference.length > MAX_PATH_BYTES
      )
        fail('trace reference is invalid or outside its bound');
      referenceCount += 1;
      if (referenceCount > BASIC5_CI_PROVENANCE_LIMITS.traceReferences)
        fail('trace reference cap exceeded');
      const lexicalTarget = path.resolve(path.dirname(canonicalManifest), reference);
      if (!isInside(repositoryRoot, lexicalTarget) && !isInside(artifactRoot, lexicalTarget))
        fail('trace reference escaped checkout/artifact');
      let canonicalTarget: string;
      try {
        canonicalTarget = await realpath(lexicalTarget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          unmatchedReferenceCount += 1;
          continue;
        }
        throw error;
      }
      if (!isInside(repositoryRoot, canonicalTarget) && !isInside(artifactRoot, canonicalTarget))
        fail('trace reference symlink escaped checkout/artifact');
      const targetStat = await lstat(canonicalTarget);
      if (!targetStat.isFile()) {
        unmatchedReferenceCount += 1;
        continue;
      }
      resolvedCheckoutReferenceCount += 1;
      let hash = targetHashes.get(canonicalTarget);
      if (hash === undefined) {
        targetBytes += targetStat.size;
        if (targetBytes > BASIC5_CI_PROVENANCE_LIMITS.traceTargetBytes)
          fail('trace target bytes cap exceeded');
        hash = (await hashFile(canonicalTarget, BASIC5_CI_PROVENANCE_LIMITS.oneFileBytes)).sha256;
        targetHashes.set(canonicalTarget, hash);
      }
      if (closureHashes.has(hash)) matchedClosureContentCount += 1;
      else unmatchedReferenceCount += 1;
    }
  }
  const status = referenceCount > 0 && unmatchedReferenceCount === 0 ? 'complete' : 'incomplete';
  return {
    scope: 'apps/web/.next/server',
    status,
    manifestCount: uniqueManifests.length,
    manifestBytes,
    manifestSha256: traceDigest.digest('hex'),
    referenceCount,
    resolvedCheckoutReferenceCount,
    matchedClosureContentCount,
    unmatchedReferenceCount,
  };
}

export async function observeBasic5CiBuildProvenance(
  input: Basic5CiBuildProvenanceInput,
): Promise<Basic5CiBuildProvenance> {
  if (!input || typeof input !== 'object') fail('input is malformed');
  assertString(input.repositoryRoot, 'repository root', MAX_PATH_BYTES);
  assertString(input.artifactRoot, 'standalone artifact root', MAX_PATH_BYTES);
  assertString(input.serverRoot, 'standalone server root', MAX_PATH_BYTES);
  if (
    !path.isAbsolute(input.repositoryRoot) ||
    !path.isAbsolute(input.artifactRoot) ||
    !path.isAbsolute(input.serverRoot)
  )
    fail('repository, artifact, and server roots must be absolute');
  if (!HEX_OBJECT.test(input.sourceCommit) || !HEX_OBJECT.test(input.sourceWebTree))
    fail('controller-provided source object IDs are malformed');
  assertString(input.nodeVersion, 'Node version', 64);
  assertString(input.imageOS, 'CI image OS', 64);
  assertString(input.imageVersion, 'CI image version', 128);

  const repositoryRoot = await realpath(input.repositoryRoot);
  const artifactRoot = await realpath(input.artifactRoot);
  const serverRoot = await realpath(input.serverRoot);
  const repoInfo = await lstat(repositoryRoot);
  const artifactInfo = await lstat(artifactRoot);
  const serverInfo = await lstat(serverRoot);
  if (!repoInfo.isDirectory() || !artifactInfo.isDirectory() || !serverInfo.isDirectory())
    fail('repository/artifact root is unavailable');
  if (!isInside(repositoryRoot, artifactRoot) || artifactRoot === repositoryRoot)
    fail('standalone output must be contained by the CI checkout');
  if (!isInside(artifactRoot, serverRoot) || artifactRoot === serverRoot)
    fail('standalone server root must be inside the complete artifact root');

  const outputRoot = path.join(serverRoot, '.next');
  const buildIdPath = path.join(outputRoot, 'BUILD_ID');
  const serverPath = path.join(serverRoot, 'server.js');
  const buildIdReal = await realpath(buildIdPath);
  const serverReal = await realpath(serverPath);
  if (!isInside(serverRoot, buildIdReal) || !isInside(serverRoot, serverReal))
    fail('BUILD_ID or standalone server escaped the artifact root');
  const buildIdBytes = await readBytesBounded(buildIdReal, 256);
  const buildId = buildIdBytes.toString('utf8').trim();
  if (!BUILD_ID.test(buildId)) fail('BUILD_ID is malformed');
  const server = await hashFile(serverReal, BASIC5_CI_PROVENANCE_LIMITS.oneFileBytes);
  const closure = await enumerateClosure(artifactRoot);
  const entriesBytes = Buffer.from(JSON.stringify(closure.entries));
  const closureSha256 = createHash('sha256').update(entriesBytes).digest('hex');
  const staticRoot = path.join(serverRoot, '.next/static');
  const publicRoot = path.join(serverRoot, 'public');
  const staticPresent = await existsDirectory(staticRoot);
  const publicPresent = await existsDirectory(publicRoot);
  const serverRelative = relativePosix(artifactRoot, serverRoot);
  const staticAssets = fingerprintEntries(closure.entries, `${serverRelative}/.next/static`);
  const publicAssets = fingerprintEntries(closure.entries, `${serverRelative}/public`);
  if (!staticPresent || staticAssets.fileCount < 1)
    fail('required standalone static assets are missing');
  if (!publicPresent || publicAssets.fileCount < 1)
    fail('required standalone public assets are missing');
  const diagnosticTraceCompleteness = input.collectTraceDiagnostic
    ? {
        ...(await collectTraceCoverage(repositoryRoot, artifactRoot, closure.fileHashes)),
        collection: 'collected' as const,
      }
    : notRequestedTraceDiagnostic();

  return {
    schemaVersion: 1,
    kind: 'basic5-ci-build-provenance',
    source: {
      commit: input.sourceCommit,
      webTree: input.sourceWebTree,
      basis: 'controller-provided-workflow-observation',
      cleanCheckoutVerifiedByHelper: false,
    },
    runtime: {
      nodeVersion: input.nodeVersion,
      imageOS: input.imageOS,
      imageVersion: input.imageVersion,
      basis: 'controller-provided-CI-observation',
    },
    requiredArtifactIdentity: {
      buildId,
      buildIdSha256: createHash('sha256').update(buildIdBytes).digest('hex'),
      serverSha256: server.sha256,
      runtimeInventorySha256: closureSha256,
      runtimeInventoryEntryCount: closure.entries.length,
      runtimeInventoryFileCount: closure.fileCount,
      runtimeInventorySymlinkCount: closure.symlinkCount,
      runtimeInventoryBytes: closure.fileBytes,
      staticAssets: { present: staticPresent, ...staticAssets },
      publicAssets: { present: publicPresent, ...publicAssets },
    },
    diagnosticTraceCompleteness,
    buildExecutionAttribution: 'unknown-cache-may-have-reused-output',
    limitations: [
      'Source and CI runtime values are controller-provided observations, not independently read by this helper.',
      'Successful workflow build ordering does not prove a fresh compile because build caches may reuse outputs.',
      'Trace coverage is limited to manifests found under apps/web/.next/server and byte matches in the observed standalone closure.',
      'Routine acceptance does not collect NFT trace completeness; it verifies runtime artifact identity and exercises one bounded browser flow.',
      'This output does not prove complete dynamic import, native dependency, OS image, or runtime behavior closure.',
    ],
  };
}
