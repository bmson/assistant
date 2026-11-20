import { createHash } from 'node:crypto';
import { loadReviewedArchivedRuntimePack } from './owner-archived-runtime-input.js';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  type ReclosedPair,
  reviewedCurrentEnvironment,
} from './owner-release-current-snapshot.js';
import { registerImageResolution } from './owner-release-image-resolution.js';
import {
  ARCHIVED_RESTORE_REPOSITORY,
  protectedRestoreTargetReview,
} from './owner-restore-target-review.js';
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
  reclosed?: ReclosedPair,
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
        (reclosed
          ? bootstrapDigest(reclosed[role].originalTemplate) === archivedServiceTemplate[role] &&
            bootstrapDigest(service) === current.services[role].serviceSha256
          : bootstrapDigest(service.template) === archivedServiceTemplate[role]),
    );
  }
}

const maxRegistryGraphBytes = 256 * 1024 * 1024;

function descriptor(value: unknown, mediaTypes: string[]) {
  const row = object(value);
  check(
    typeof row.digest === 'string' &&
      digestPattern.test(row.digest) &&
      typeof row.size === 'number' &&
      Number.isSafeInteger(row.size) &&
      row.size > 0 &&
      row.size <= maxRegistryGraphBytes &&
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
      target.image === `${ARCHIVED_RESTORE_REPOSITORY}/${role}@${target.child}`,
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

/** Observe the exact archived child and rehash every executable blob from the
 * fixed recovery repository. Blob redirects stay within the reviewed HTTPS origin.
 */
export async function recheckArchivedRestoreTargets(
  token: string,
  targets: Targets,
  archives: Record<Role, ArchivedRoleEvidence>,
  request: typeof fetch = fetch,
  deadline = Date.now() + 60_000,
) {
  const controller = new AbortController();
  try {
    check(/^[A-Za-z0-9._~-]{1,16384}$/.test(token));
    const reads = roleNames.map((role) => roleReadSet(role, targets[role], archives[role]));
    const total = reads.reduce(
      (bytes, role) => bytes + role.blobs.reduce((sum, [, size]) => sum + size, 0),
      0,
    );
    check(total <= maxRegistryGraphBytes);
    await Promise.all(
      reads.map(async ({ role, target, archive, blobs }) => {
        const repo = ARCHIVED_RESTORE_REPOSITORY.slice(host.length + 1);
        const base = `https://${host}/v2/${repo}/${role}`;
        async function lookup(url: string, accept?: string) {
          const timeout = deadline - Date.now();
          check(timeout > 0 && !controller.signal.aborted);
          return request(url, {
            method: 'GET',
            cache: 'no-store',
            redirect: accept ? 'error' : 'manual',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
            headers: {
              Authorization: `Bearer ${token}`,
              'Accept-Encoding': 'identity',
              ...(accept ? { Accept: accept } : {}),
            },
          });
        }

        async function readBlob(id: string) {
          const url = `${base}/blobs/${id}`;
          const response = await lookup(url);
          if (response.status !== 302) return response;
          void response.body?.cancel().catch(() => undefined);
          const location = response.headers.get('location');
          check(
            location &&
              location.length <= 8192 &&
              location.startsWith('/artifacts-downloads/') &&
              /^[!-~]+$/.test(location) &&
              !/[\\#]/.test(location),
          );
          const next = new URL(location, url);
          check(
            next.protocol === 'https:' &&
              next.hostname === host &&
              next.pathname.startsWith('/artifacts-downloads/') &&
              !next.port &&
              !next.username &&
              !next.password &&
              !next.hash,
          );
          // A second redirect is rejected by the body checker.
          return lookup(next.href);
        }

        const manifest = await lookup(`${base}/manifests/${target.child}`, manifestType);
        await checkRegistryBody(
          manifest,
          archive.child.length,
          target.child,
          deadline,
          manifestType,
        );

        for (let index = 0; index < blobs.length; index += 4) {
          await Promise.all(
            blobs.slice(index, index + 4).map(async ([id, size]) => {
              const blob = await readBlob(id);
              await checkRegistryBody(blob, size, id, deadline);
            }),
          );
        }
      }),
    );
  } catch {
    controller.abort();
    // Provider errors may include private URLs or token-bearing transport details.
    throw new Error('Archived restore target is unavailable');
  }
}

async function checkRegistryBody(
  response: Response,
  size: number,
  expectedDigest: string,
  deadline: number,
  mediaType?: string,
) {
  const declaredSize = response.headers.get('content-length');
  const declaredDigest = response.headers.get('docker-content-digest');
  if (
    response.status !== 200 ||
    !response.body ||
    response.headers.get('content-encoding') !== null ||
    (declaredSize !== null && declaredSize !== String(size)) ||
    (declaredDigest !== null && declaredDigest !== expectedDigest) ||
    (mediaType && response.headers.get('content-type')?.split(';')[0]?.trim() !== mediaType)
  ) {
    void response.body?.cancel().catch(() => undefined);
    check(false);
  }
  const hash = createHash('sha256');
  let count = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      check(Date.now() < deadline);
      if (done) break;
      count += value.length;
      check(count <= size);
      hash.update(value);
    }
    check(count === size && `sha256:${hash.digest('hex')}` === expectedDigest);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Check the authenticated archive's executable children before any native
 * maintenance or promotion writes. The signed transition review separately
 * binds these same digests to the resulting disabled bootstrap.
 */
export async function recheckReviewedArchivedRuntimeGraph(
  token: string,
  pack: ArchivedPack,
  request: typeof fetch = fetch,
  deadline = Date.now() + 60_000,
) {
  const target = (role: Role) => {
    const { parent, child } = pack.roles[role];
    const childDigest = digest(child);
    return {
      image: `${ARCHIVED_RESTORE_REPOSITORY}/${role}@${childDigest}`,
      parent: digest(parent),
      child: childDigest,
    };
  };
  await recheckArchivedRestoreTargets(
    token,
    { agent: target('agent'), web: target('web') },
    pack.roles,
    request,
    deadline,
  );
}
