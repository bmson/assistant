import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const roles = ['agent', 'web'] as const;
const historical = [
  'parent.json',
  'build-receipt.json',
  'signature.sigstore.json',
  'sbom.sigstore.json',
] as const;
const rootFiles = ['native-binding.json', 'trusted-root.json', 'oci-layout', 'index.json'] as const;
const fixed = [
  ...rootFiles,
  ...roles.flatMap((role) => historical.map((name) => `historical/${role}-${name}`)),
];
const blobPath = /^blobs\/sha256\/[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const indexType = 'application/vnd.oci.image.index.v1+json';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const gzipType = 'application/vnd.oci.image.layer.v1.tar+gzip';
const tarType = 'application/vnd.oci.image.layer.v1.tar';
const metadataLimit = 8 * 1024 * 1024;
const compressedLimit = 1024 ** 3;
const expandedLayerLimit = 1024 ** 3;
const expandedPackLimit = 4 * 1024 ** 3;
const fileLimit = 256;

type Obj = Record<string, unknown>;
type Descriptor = { digest: string; size: number; mediaType: string };
type Layer = { descriptor: Descriptor; diffId: string };
type FingerprintRow = [relativePath: string, bytes: number, hash: string];
export type ArchivedRoleEvidence = {
  parent: Buffer;
  child: Buffer;
  receipt: Buffer;
  signature: Buffer;
  sbom: Buffer;
};

function requirePack(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Archived runtime pack rejected: ${reason}`);
}
function object(value: unknown): Obj {
  requirePack(value && typeof value === 'object' && !Array.isArray(value), 'invalid JSON object');
  return value as Obj;
}
function sha(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(bytes: Buffer) {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = object(JSON.parse(source));
  const stack: (Set<string> | null)[] = [];
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/gs)) {
    if (token[0] === '{' || token[0] === '[') {
      stack.push(token[0] === '{' ? new Set() : null);
      requirePack(stack.length <= 128, 'JSON nesting limit');
    } else if (token[0] === '}' || token[0] === ']') stack.pop();
    else if (
      token[0].startsWith('"') &&
      /^\s*:/.test(source.slice(token.index + token[0].length))
    ) {
      const keys = stack.at(-1);
      const key = JSON.parse(token[0]) as string;
      requirePack(keys && !keys.has(key), 'duplicate JSON key');
      keys.add(key);
    }
  }
  return value;
}
function descriptor(value: unknown, types: readonly string[]): Descriptor {
  const row = object(value);
  requirePack(
    typeof row.digest === 'string' &&
      digestPattern.test(row.digest) &&
      typeof row.size === 'number' &&
      Number.isSafeInteger(row.size) &&
      row.size > 0 &&
      typeof row.mediaType === 'string' &&
      types.includes(row.mediaType) &&
      row.urls === undefined &&
      row.data === undefined &&
      row.artifactType === undefined,
    'invalid OCI descriptor',
  );
  return { digest: row.digest, size: row.size, mediaType: row.mediaType };
}
function entries(index: Obj) {
  requirePack(
    index.schemaVersion === 2 &&
      index.mediaType === indexType &&
      index.subject === undefined &&
      index.artifactType === undefined &&
      Array.isArray(index.manifests) &&
      index.manifests.length > 0 &&
      index.manifests.length <= 32,
    'invalid OCI index',
  );
  return index.manifests.map((entry) => object(entry));
}
function amd64(entry: Obj) {
  const platform = object(entry.platform);
  return (
    platform.os === 'linux' &&
    platform.architecture === 'amd64' &&
    Object.keys(platform).length === 2
  );
}
function sameFile(a: Stats, b: Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function digestPath(digest: string) {
  return `blobs/sha256/${digest.slice(7)}`;
}

export async function readArchivedRuntimePack(directory: string, expectedPackSha256: string) {
  requirePack(hashPattern.test(expectedPackSha256), 'invalid expected fingerprint');
  requirePack((await lstat(directory)).isDirectory(), 'invalid pack directory');
  const root = await realpath(directory);
  const dirs = new Map<string, Stats>();
  const files = new Map<string, Stats>();
  let packedBytes = 0;

  async function scan(relative: string, knownDirs: readonly string[]) {
    const path = join(root, relative);
    const stats = await lstat(path);
    requirePack(stats.isDirectory(), 'unexpected directory type');
    dirs.set(relative, stats);
    const handle = await opendir(path);
    for await (const entry of handle) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      requirePack(/^[a-z0-9./-]+$/.test(name), 'unexpected path');
      if (knownDirs.includes(name)) {
        requirePack(entry.isDirectory(), 'unexpected directory entry');
        await scan(name, name === 'blobs' ? ['blobs/sha256'] : []);
        continue;
      }
      requirePack(
        entry.isFile() && (fixed.includes(name) || blobPath.test(name)),
        'unexpected file',
      );
      const file = await lstat(join(root, name));
      requirePack(file.isFile() && file.size > 0 && files.size < fileLimit, 'invalid file');
      packedBytes += file.size;
      requirePack(packedBytes <= compressedLimit, 'compressed size limit');
      files.set(name, file);
    }
  }
  await scan('', ['historical', 'blobs']);
  requirePack(dirs.size === 4 && fixed.every((name) => files.has(name)), 'incomplete pack');

  const fingerprints = new Map<string, FingerprintRow>();
  async function verifyDirectories() {
    for (const [relative, original] of dirs) {
      const current = await lstat(join(root, relative));
      requirePack(current.isDirectory() && sameFile(original, current), 'directory changed');
    }
  }
  async function readFile<T>(
    name: string,
    consume: (
      handle: Awaited<ReturnType<typeof open>>,
      size: number,
    ) => Promise<{ value: T; hash: string }>,
  ) {
    const stats = files.get(name);
    requirePack(stats && !fingerprints.has(name), 'missing or reused path');
    await verifyDirectories();
    const handle = await open(
      join(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      requirePack(sameFile(stats, await handle.stat()), 'file changed');
      const result = await consume(handle, stats.size);
      requirePack(
        sameFile(stats, await handle.stat()) && sameFile(stats, await lstat(join(root, name))),
        'file changed',
      );
      if (blobPath.test(name))
        requirePack(result.hash === name.slice('blobs/sha256/'.length), 'blob hash mismatch');
      fingerprints.set(name, [name, stats.size, result.hash]);
      return result.value;
    } finally {
      await handle.close();
    }
  }
  async function metadata(name: string) {
    return readFile(name, async (handle, size) => {
      requirePack(size <= metadataLimit, 'metadata size limit');
      const value = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const part = await handle.read(value, offset, size - offset, offset);
        requirePack(part.bytesRead > 0, 'short metadata read');
        offset += part.bytesRead;
      }
      return { value, hash: sha(value) };
    });
  }
  async function evidence(name: string) {
    const bytes = await metadata(name);
    json(bytes);
    return bytes;
  }
  const layout = json(await metadata('oci-layout'));
  requirePack(
    layout.imageLayoutVersion === '1.0.0' && Object.keys(layout).length === 1,
    'unsupported OCI layout',
  );
  const nativeBinding = json(await metadata('native-binding.json'));
  const trustedRoot = await evidence('trusted-root.json');
  const descriptors = entries(json(await metadata('index.json')));
  requirePack(descriptors.length === roles.length, 'incomplete runtime pair');
  const graph = new Map<string, Descriptor>();
  function bind(desc: Descriptor) {
    const previous = graph.get(desc.digest);
    requirePack(
      !previous || (previous.size === desc.size && previous.mediaType === desc.mediaType),
      'inconsistent OCI descriptor',
    );
    requirePack(
      files.get(digestPath(desc.digest))?.size === desc.size,
      'missing blob or size mismatch',
    );
    graph.set(desc.digest, desc);
  }
  const knownMetadata = new Map<string, Buffer>();
  async function readDescriptor(desc: Descriptor) {
    bind(desc);
    const known = knownMetadata.get(desc.digest);
    if (known) return known;
    const bytes = await metadata(digestPath(desc.digest));
    knownMetadata.set(desc.digest, bytes);
    return bytes;
  }
  const layers = new Map<string, Layer>();
  async function readRole(role: (typeof roles)[number]): Promise<ArchivedRoleEvidence> {
    const imageEntries = descriptors.filter(
      (entry) => object(entry.annotations)['org.opencontainers.image.ref.name'] === role,
    );
    const image = imageEntries[0];
    requirePack(
      imageEntries.length === 1 && image && amd64(image),
      'invalid runtime role or platform',
    );
    const runtime = descriptor(image, [manifestType]);
    const parent = await metadata(`historical/${role}-parent.json`);
    const children = entries(json(parent));
    const runtimeChildren = children.filter((entry) => {
      const platform = object(entry.platform);
      requirePack(
        typeof platform.os === 'string' &&
          platform.os.length > 0 &&
          typeof platform.architecture === 'string' &&
          platform.architecture.length > 0,
        'invalid historical platform',
      );
      return platform.os === 'linux' && platform.architecture === 'amd64';
    });
    const candidate = runtimeChildren[0];
    requirePack(
      runtimeChildren.length === 1 && candidate && amd64(candidate),
      'invalid historical runtime platform',
    );
    const selected = descriptor(candidate, [manifestType]);
    requirePack(
      selected.digest === runtime.digest &&
        selected.size === runtime.size &&
        children.filter((entry) => entry.digest === runtime.digest).length === 1,
      'historical runtime mismatch',
    );
    for (const entry of children) descriptor(entry, [manifestType]);
    const child = await readDescriptor(runtime);
    const manifest = json(child);
    requirePack(
      manifest.schemaVersion === 2 &&
        manifest.mediaType === manifestType &&
        manifest.subject === undefined &&
        manifest.artifactType === undefined &&
        Array.isArray(manifest.layers) &&
        manifest.layers.length > 0 &&
        manifest.layers.length <= 128,
      'invalid runtime manifest',
    );
    const config = json(await readDescriptor(descriptor(manifest.config, [configType])));
    const rootfs = object(config.rootfs);
    requirePack(
      config.os === 'linux' &&
        config.architecture === 'amd64' &&
        rootfs.type === 'layers' &&
        Array.isArray(rootfs.diff_ids) &&
        rootfs.diff_ids.length === manifest.layers.length,
      'invalid runtime config',
    );
    const diffIds = rootfs.diff_ids;
    for (const [index, entry] of manifest.layers.entries()) {
      const desc = descriptor(entry, [gzipType, tarType]);
      bind(desc);
      const diffId: unknown = diffIds[index];
      requirePack(
        typeof diffId === 'string' && digestPattern.test(diffId),
        'invalid layer diff ID',
      );
      const previous = layers.get(desc.digest);
      requirePack(!previous || previous.diffId === diffId, 'inconsistent layer diff ID');
      layers.set(desc.digest, { descriptor: desc, diffId });
    }
    return {
      parent,
      child,
      receipt: await evidence(`historical/${role}-build-receipt.json`),
      signature: await evidence(`historical/${role}-signature.sigstore.json`),
      sbom: await evidence(`historical/${role}-sbom.sigstore.json`),
    };
  }
  const agent = await readRole('agent');
  const web = await readRole('web');
  requirePack(!agent.child.equals(web.child), 'runtime roles share a manifest');
  requirePack(files.size === fixed.length + graph.size, 'unreferenced blob');
  let expandedPack = 0;
  for (const [digest, layer] of layers) {
    await readFile(digestPath(digest), async (handle, size) => {
      const raw = createHash('sha256');
      const expanded = createHash('sha256');
      let compressedBytes = 0;
      let expandedBytes = 0;
      const input = handle.createReadStream({ autoClose: false });
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          compressedBytes += chunk.length;
          if (compressedBytes > size)
            return done(new Error('Archived runtime blob exceeded its size'));
          raw.update(chunk);
          done(null, chunk);
        },
      });
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          expandedBytes += chunk.length;
          expandedPack += chunk.length;
          if (expandedBytes > expandedLayerLimit || expandedPack > expandedPackLimit)
            return done(new Error('Archived runtime pack exceeded its decompression limit'));
          expanded.update(chunk);
          done();
        },
      });
      if (layer.descriptor.mediaType === gzipType)
        await pipeline(input, hashing, createGunzip(), sink);
      else await pipeline(input, hashing, sink);
      requirePack(
        compressedBytes === size &&
          expandedBytes > 0 &&
          `sha256:${expanded.digest('hex')}` === layer.diffId,
        'layer diff ID mismatch',
      );
      return { value: undefined, hash: raw.digest('hex') };
    });
  }
  await verifyDirectories();
  requirePack(fingerprints.size === files.size, 'incomplete fingerprint');
  const rows = [...fingerprints.values()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const sha256 = sha(JSON.stringify(rows));
  requirePack(sha256 === expectedPackSha256, 'pack fingerprint mismatch');
  return { sha256, nativeBinding, roles: { agent, web }, trustedRoot };
}
