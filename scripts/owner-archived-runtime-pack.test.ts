import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readArchivedRuntimePack } from './owner-archived-runtime-pack.js';

const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const gzipType = 'application/vnd.oci.image.layer.v1.tar+gzip';
const platform = { architecture: 'amd64', os: 'linux' };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const roots: string[] = [];

type FixtureOptions = {
  badDiff?: boolean;
  badMediaType?: boolean;
  badSize?: boolean;
  corruptGzip?: boolean;
  duplicatePlatform?: boolean;
  expandedBomb?: boolean;
  foreignRole?: boolean;
  parentMismatch?: boolean;
};

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-archive-test-'));
  roots.push(root);
  const blobDir = join(root, 'blobs', 'sha256');
  await mkdir(blobDir, { recursive: true });
  await mkdir(join(root, 'historical'));
  async function addBlob(raw: Buffer, mediaType: string) {
    const hash = sha(raw);
    await writeFile(join(blobDir, hash), raw);
    return { digest: `sha256:${hash}`, size: raw.length, mediaType };
  }
  const layer = Buffer.from('test decompressed layer');
  let compressed = gzipSync(layer);
  if (options.corruptGzip) compressed = Buffer.from('invalid gzip');
  if (options.expandedBomb) {
    const mebibyte = gzipSync(Buffer.alloc(1024 ** 2));
    compressed = Buffer.concat(Array<Buffer>(1025).fill(mebibyte));
  }
  const layerBlob = await addBlob(compressed, gzipType);
  const manifests = [];
  const rawChildren: Record<string, Buffer> = {};
  for (const role of ['agent', 'web']) {
    const config = await addBlob(
      json({
        architecture: 'amd64',
        os: 'linux',
        config: { Cmd: [role] },
        rootfs: {
          type: 'layers',
          diff_ids: [`sha256:${options.badDiff ? '1'.repeat(64) : sha(layer)}`],
        },
      }),
      configType,
    );
    const rawChild = json({
      schemaVersion: 2,
      mediaType: manifestType,
      config,
      layers: [
        {
          ...layerBlob,
          ...(options.badMediaType ? { mediaType: 'application/vnd.in-toto+json' } : {}),
          ...(options.badSize ? { size: layerBlob.size + 1 } : {}),
        },
      ],
    });
    rawChildren[role] = rawChild;
    const child = await addBlob(rawChild, manifestType);
    const parentChild = {
      ...child,
      platform,
      ...(options.parentMismatch ? { digest: `sha256:${'2'.repeat(64)}` } : {}),
    };
    const attestation = {
      mediaType: manifestType,
      digest: `sha256:${'3'.repeat(64)}`,
      size: 564,
      platform: { os: 'unknown', architecture: 'unknown' },
    };
    const parent = json({
      schemaVersion: 2,
      mediaType: indexType,
      manifests: [parentChild, attestation, ...(options.duplicatePlatform ? [parentChild] : [])],
    });
    await writeFile(join(root, 'historical', `${role}-parent.json`), parent);
    for (const file of ['build-receipt.json', 'signature.sigstore.json', 'sbom.sigstore.json'])
      await writeFile(join(root, 'historical', `${role}-${file}`), json({ role, file }));
    manifests.push({
      ...child,
      platform,
      annotations: {
        'org.opencontainers.image.ref.name':
          options.foreignRole && role === 'web' ? 'worker' : role,
      },
    });
  }
  await writeFile(
    join(root, 'index.json'),
    json({ schemaVersion: 2, mediaType: indexType, manifests }),
  );
  await writeFile(join(root, 'oci-layout'), json({ imageLayoutVersion: '1.0.0' }));
  await writeFile(join(root, 'native-binding.json'), json({ fixedNativeObservation: true }));
  await writeFile(join(root, 'trusted-root.json'), json({ trustedRoot: true }));
  return { root, blobDir, layerBlob, rawChildren };
}

async function fingerprint(root: string) {
  const names = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  return sha(
    JSON.stringify(
      await Promise.all(
        names.map(async (name) => {
          const raw = await readFile(join(root, name));
          return [name, raw.length, sha(raw)];
        }),
      ),
    ),
  );
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('archived runtime pair pack', () => {
  it('returns exact bound files and validates a compressed layer shared by both roles', async () => {
    const { root, rawChildren } = await fixture();
    const expected = await fingerprint(root);
    const pack = await readArchivedRuntimePack(root, expected);
    expect(pack.sha256).toBe(expected);
    expect(pack.nativeBinding).toEqual({ fixedNativeObservation: true });
    expect(pack.trustedRoot).toEqual(json({ trustedRoot: true }));
    for (const role of ['agent', 'web'] as const) {
      expect(pack.roles[role].child).toEqual(rawChildren[role]);
      expect(pack.roles[role].parent).toEqual(
        await readFile(join(root, 'historical', `${role}-parent.json`)),
      );
      expect(pack.roles[role].receipt).toEqual(json({ role, file: 'build-receipt.json' }));
      expect(pack.roles[role].signature).toEqual(json({ role, file: 'signature.sigstore.json' }));
      expect(pack.roles[role].sbom).toEqual(json({ role, file: 'sbom.sigstore.json' }));
    }
    await expect(readArchivedRuntimePack(root, '0'.repeat(64))).rejects.toThrow(
      'pack fingerprint mismatch',
    );
  });

  it.each([
    ['wrong config diff ID', { badDiff: true }, /diff ID mismatch/],
    ['wrong layer media type', { badMediaType: true }, /invalid OCI descriptor/],
    ['wrong compressed size', { badSize: true }, /size mismatch/],
    ['corrupt gzip', { corruptGzip: true }, /header check/],
    ['dual platform', { duplicatePlatform: true }, /invalid historical runtime platform/],
    ['unknown role', { foreignRole: true }, /invalid runtime role/],
    [
      'child belongs to a different parent',
      { parentMismatch: true },
      /historical runtime mismatch/,
    ],
  ] as const)('rejects %s even if the pack fingerprint matches', async (_label, options, error) => {
    const { root } = await fixture(options);
    await expect(readArchivedRuntimePack(root, await fingerprint(root))).rejects.toThrow(error);
  });

  it('rejects a symlink root, symlink file and unexpected paths', async () => {
    const { root } = await fixture();
    const expected = await fingerprint(root);
    const link = `${root}-link`;
    roots.push(link);
    await symlink(root, link, 'dir');
    await expect(readArchivedRuntimePack(link, expected)).rejects.toThrow('invalid pack directory');
    const path = join(root, 'native-binding.json');
    await rm(path);
    await symlink(join(root, 'trusted-root.json'), path, 'file');
    await expect(readArchivedRuntimePack(root, expected)).rejects.toThrow('unexpected file');
    await rm(path);
    await writeFile(path, '{}');
    await writeFile(join(root, 'unexpected.json'), '{}');
    await expect(readArchivedRuntimePack(root, expected)).rejects.toThrow('unexpected file');
  });

  it('rejects a missing role receipt and orphan content', async () => {
    const { root, blobDir } = await fixture();
    const path = join(root, 'historical', 'agent-build-receipt.json');
    await rm(path);
    await expect(readArchivedRuntimePack(root, await fingerprint(root))).rejects.toThrow(
      'incomplete pack',
    );
    await writeFile(path, '{}');
    await writeFile(join(blobDir, sha('{}')), '{}');
    await expect(readArchivedRuntimePack(root, await fingerprint(root))).rejects.toThrow(
      'unreferenced blob',
    );
  });

  it('checks compressed blob hashes independently of the pack fingerprint and expanded digest', async () => {
    const { root, blobDir, layerBlob } = await fixture();
    const path = join(blobDir, layerBlob.digest.slice(7));
    const raw = await readFile(path);
    raw.writeUInt32LE(1, 4); // Change gzip mtime while preserving the exact uncompressed bytes.
    await writeFile(path, raw);
    await expect(readArchivedRuntimePack(root, await fingerprint(root))).rejects.toThrow(
      'blob hash mismatch',
    );
  });

  it('bounds packed input and streamed decompression', async () => {
    const { root, blobDir, layerBlob } = await fixture({ expandedBomb: true });
    await expect(readArchivedRuntimePack(root, await fingerprint(root))).rejects.toThrow(
      'decompression limit',
    );
    await truncate(join(blobDir, layerBlob.digest.slice(7)), 1024 ** 3 + 1);
    await expect(readArchivedRuntimePack(root, '0'.repeat(64))).rejects.toThrow(
      'compressed size limit',
    );
  }, 30_000);

  it('rejects duplicate JSON keys and bounds metadata before reading', async () => {
    const { root } = await fixture();
    const native = join(root, 'native-binding.json');
    await writeFile(native, '{"value":1,"val\\u0075e":2}');
    await expect(readArchivedRuntimePack(root, await fingerprint(root))).rejects.toThrow(
      'duplicate JSON key',
    );
    await truncate(native, 8 * 1024 * 1024 + 1);
    await expect(readArchivedRuntimePack(root, '0'.repeat(64))).rejects.toThrow(
      'metadata size limit',
    );
  });
});
