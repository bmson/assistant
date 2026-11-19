import { createHash } from 'node:crypto';
export const ociIndex = 'application/vnd.oci.image.index.v1+json';
export const ociManifest = 'application/vnd.oci.image.manifest.v1+json';
export const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export function syntheticImage(role = 'web', nonce = 'synthetic') {
  const root = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}`;
  const child = {
    schemaVersion: 2,
    mediaType: ociManifest,
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      size: 1,
      digest: `sha256:${hash(bytes(nonce))}`,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        size: 1,
        digest: `sha256:${'d'.repeat(64)}`,
      },
    ],
  };
  const childBytes = bytes(child),
    childImage = `${root}@sha256:${hash(childBytes)}`;
  const parent = {
    schemaVersion: 2,
    mediaType: ociIndex,
    manifests: [
      {
        mediaType: ociManifest,
        digest: `sha256:${hash(childBytes)}`,
        size: childBytes.length,
        platform: { os: 'linux', architecture: 'amd64' },
      },
    ],
  };
  const parentBytes = bytes(parent),
    image = `${root}@sha256:${hash(parentBytes)}`;
  const revision = {
    containers: [{ name: `${role}-1`, image: childImage }],
    containerStatuses: [{ name: `${role}-1`, imageDigest: childImage }],
  };
  return { root, image, childImage, parent, child, parentBytes, childBytes, revision };
}
