import { createHash } from 'node:crypto';
import { loadReviewedArchivedRuntimePack } from './owner-archived-runtime-input.js';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  reviewedCurrentEnvironment,
} from './owner-release-current-snapshot.js';
import { registerImageResolution } from './owner-release-image-resolution.js';
import { protectedRestoreTargetReview } from './owner-restore-target-review.js';
import { tagHash } from './owner-web-tag-retirement.js';

const roleNames = ['agent', 'web'] as const;
type Role = (typeof roleNames)[number];
type Targets = Record<Role, { image: string; parent: string; child: string }>;
type ArchivedPack = { nativeBinding: unknown; roles: Record<Role, ArchivedRoleEvidence> };
type NativePair = Record<Role, { service: unknown; revision: unknown }>;

const archivedSource = '1c2ea3907bf17b14368846708002f9d4633f2092';
const archivedManifest = '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647';
const archivedServiceTemplate = {
  agent: '8ed6937de80a52651b1e80d3f464bb5c61149dd433c70cc0064dc3f541a01932',
  web: '938c1530e8b97793f94eaaa31909d9c03075fadbce2ccfca0fff9811f4fa4b5f',
} as const;
type Obj = Record<string, unknown>;

// Agent service GET omits the container name. The archived revision and
// bootstrap proof use the provider's exact default name ("agent-1").
const archivedRevisionTemplate = {
  ...archivedServiceTemplate,
  agent: '53a47b948298498e031cc6a8f7acd65a53250f42266b0595d02dc7532c9c0f9a',
} as const;

// Native proof uses the raw-UID hash, while the archive binding hashes its
// canonical JSON representation. Fresh readback verifies both conventions.
const archivedRevisionUid = {
  agent: '48e24460ff97eb87801e9a876bbdc5690194c65eb0a780a98e97fe828ab94d67',
  web: '4ef1ecfce5e4eb4f54a7fd40c5f9b67cff9714705c355f511e98727d08ae84c9',
} as const;

const host = 'us-west1-docker.pkg.dev';
const repository = 'bmson-assistant/assistant';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const layerTypes = [
  'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.oci.image.layer.v1.tar',
];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function check(value: unknown): asserts value {
  if (!value) throw new Error('Archived restore target is unavailable');
}

function object(value: unknown): Obj {
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value as Obj;
}

/** Opt-in only for protected production entry points. General registry readers
 * and standalone historical alias retirement retain their original policy.
 */
export async function preloadArchivedOriginalForProtectedRelease(
  env: NodeJS.ProcessEnv = process.env,
  source = env.IMAGE_TAG ?? '',
) {
  if (env.OWNER_RELEASE_RESTORE_TARGET_PROOF === undefined) return undefined;
  check(env.OWNER_RELEASE_RESTORE_TARGET_PROOF);
  const current = reviewedCurrentEnvironment(env, source);
  check(current?.kind === 'disabled-bootstrap');
  const pack = await loadReviewedArchivedRuntimePack();
  const review = protectedRestoreTargetReview(env, current, pack.sha256);
  registerReviewedArchivedOriginal(current, pack);
  return { current, pack, review };
}

/** Only callers which have loaded the independently verified source-pinned pack
 * may prime the historical image relationship for this protected process.
 * The archive's Automatic service/output hashes are deliberately distinct from
 * the drained receipt. Their shared template and both UIDs bind the same pair.
 */
export function registerReviewedArchivedOriginal(current: BootstrapReceipt, pack: ArchivedPack) {
  check(current.kind === 'disabled-bootstrap');
  const native = object(pack.nativeBinding);
  check(native.format === 1);
  const baseline = object(native.roles);
  const bindings = roleNames.map((role) => {
    const currentRole = current.services[role];
    const nativeRole = object(baseline[role]);
    const { parent, child } = pack.roles[role];
    const ref = `${host}/${repository}/${role}@`;
    check(
      currentRole.revision === nativeRole.revision &&
        bootstrapDigest(currentRole.uid) === nativeRole.serviceUidSha256 &&
        currentRole.proof.uid === archivedRevisionUid[role] &&
        currentRole.proof.source === archivedSource &&
        currentRole.proof.manifest === archivedManifest &&
        currentRole.proof.runId === '44263661117' &&
        currentRole.proof.attempt === '1' &&
        !currentRole.proof.paused &&
        currentRole.proof.templateSha256 === archivedRevisionTemplate[role] &&
        currentRole.image === ref + digest(parent) &&
        currentRole.proof.image === currentRole.image &&
        typeof nativeRole.revisionUidSha256 === 'string' &&
        digestPattern.test(`sha256:${nativeRole.revisionUidSha256}`),
    );
    return { currentRole, parent, child };
  });
  for (const { currentRole, parent, child } of bindings)
    registerImageResolution(currentRole.image, parent, child);
}

export function verifyArchivedOriginalNativePair(
  current: BootstrapReceipt,
  pack: ArchivedPack,
  pair: NativePair,
) {
  const baseline = object(object(pack.nativeBinding).roles);
  for (const role of roleNames) {
    const service = object(pair[role].service);
    const revision = object(pair[role].revision);
    const binding = object(baseline[role]);
    check(
      typeof service.uid === 'string' &&
        bootstrapDigest(service.uid) === binding.serviceUidSha256 &&
        typeof revision.uid === 'string' &&
        bootstrapDigest(revision.uid) === binding.revisionUidSha256 &&
        tagHash(revision.uid) === current.services[role].proof.uid &&
        bootstrapDigest(service.template) === archivedServiceTemplate[role],
    );
  }
}

function descriptor(value: unknown, mediaTypes: string[]) {
  const row = object(value);
  check(
    typeof row.digest === 'string' &&
      digestPattern.test(row.digest) &&
      typeof row.size === 'number' &&
      Number.isSafeInteger(row.size) &&
      row.size > 0 &&
      typeof row.mediaType === 'string' &&
      mediaTypes.includes(row.mediaType) &&
      row.urls === undefined &&
      row.data === undefined &&
      row.artifactType === undefined,
  );
  return { digest: row.digest, size: row.size };
}

function roleReadSet(role: Role, target: Targets[Role], archive: ArchivedRoleEvidence) {
  check(
    Buffer.isBuffer(archive.parent) &&
      Buffer.isBuffer(archive.child) &&
      archive.parent.length > 0 &&
      archive.parent.length <= 16 * 1024 &&
      archive.child.length > 0 &&
      archive.child.length <= 16 * 1024 &&
      digest(archive.parent) === target.parent &&
      digest(archive.child) === target.child &&
      target.image === `${host}/${repository}/${role}@${target.child}`,
  );
  // The pack reader has already verified the complete executable graph.
  const manifest = object(JSON.parse(archive.child.toString('utf8')));
  const { layers } = manifest;
  check(
    manifest.schemaVersion === 2 &&
      manifest.mediaType === manifestType &&
      manifest.subject === undefined &&
      manifest.artifactType === undefined &&
      Array.isArray(layers) &&
      layers.length > 0 &&
      layers.length <= 128,
  );
  const unique = new Map<string, number>();
  for (const blob of [
    descriptor(manifest.config, [configType]),
    ...layers.map((layer) => descriptor(layer, layerTypes)),
  ]) {
    check(!unique.has(blob.digest) || unique.get(blob.digest) === blob.size);
    unique.set(blob.digest, blob.size);
  }
  return { role, target, archive, blobs: [...unique] };
}

/** Fresh, fixed-repository availability checks. The archived graph supplied the
 * verified config and layer bytes. HEAD checks current blob availability, not
 * file contents, provider startup or permission to deploy.
 */
export async function recheckArchivedRestoreTargets(
  token: string,
  targets: Targets,
  archives: Record<Role, ArchivedRoleEvidence>,
  request: typeof fetch = fetch,
  deadline = Date.now() + 60_000,
) {
  try {
    check(/^[A-Za-z0-9._~-]{1,16384}$/.test(token));
    const reads = roleNames.map((role) => roleReadSet(role, targets[role], archives[role]));
    await Promise.all(
      reads.map(async ({ role, target, archive, blobs }) => {
        const base = `https://${host}/v2/${repository}/${role}`;
        async function lookup(path: string, method: 'GET' | 'HEAD') {
          const timeout = Math.min(deadline - Date.now(), 15_000);
          check(timeout > 0);
          return request(base + path, {
            method,
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(timeout),
            headers: {
              Authorization: `Bearer ${token}`,
              ...(method === 'GET' ? { Accept: manifestType } : {}),
            },
          });
        }
        const response = await lookup(`/manifests/${target.child}`, 'GET');
        if (
          response.status !== 200 ||
          !response.body ||
          response.headers.get('content-type')?.split(';')[0]?.trim() !== manifestType
        ) {
          void response.body?.cancel().catch(() => undefined);
          check(false);
        }
        const reader = response.body.getReader();
        try {
          let offset = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            check(
              offset + value.length <= archive.child.length &&
                archive.child.subarray(offset, offset + value.length).equals(value),
            );
            offset += value.length;
          }
          check(offset === archive.child.length && Date.now() < deadline);
        } finally {
          void reader.cancel().catch(() => undefined);
        }

        for (let index = 0; index < blobs.length; index += 4) {
          await Promise.all(
            blobs.slice(index, index + 4).map(async ([id, size]) => {
              const blob = await lookup(`/blobs/${id}`, 'HEAD');
              void blob.body?.cancel().catch(() => undefined);
              const declaredDigest = blob.headers.get('docker-content-digest');
              check(
                blob.status === 200 &&
                  blob.headers.get('content-length') === String(size) &&
                  (declaredDigest === null || declaredDigest === id) &&
                  Date.now() < deadline,
              );
            }),
          );
        }
      }),
    );
  } catch {
    // Provider errors may include private URLs or token-bearing transport details.
    throw new Error('Archived restore target is unavailable');
  }
}
