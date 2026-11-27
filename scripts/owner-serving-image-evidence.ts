/** Verify the retained identities selected by the ordinary API 3 recovery review. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { verifyRoleReceipt } from '../infra/gcp/verify-prebuilt-firestore.mjs';
import { ORDINARY_IDENTITY } from './owner-api3-recovery-pins.js';
import {
  registerImageResolution,
  validateImageResolution,
} from './owner-release-image-resolution.js';

export const RETAINED_SERVING_IMAGE_FILE = 'ordinary-api3-identity.json';
export const RETAINED_SERVING_IMAGE_LIMIT = 256 * 1024;
export const PRIOR_SERVING_IMAGE_SOURCE = 'd6954975b72e5cf41357f050d9d6b036ccad7753';
export const PRIOR_SERVING_IMAGE_BUILD = '44676416157';
const IMAGE_ROOT = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';
const SERVICE_ROLES = ['agent', 'web'] as const;
const PARENT_DIGESTS = {
  agent: '6b2a435bde4b1789ed8a190925dc6d4e1d4addf9b2dc8acf9086a011b82ce40e',
  web: '19f1750ac9d36b8fd4556c6132f3ddf75e20b6b7d020068a87902301385bf9c4',
} as const;
type Role = keyof typeof PARENT_DIGESTS;
export type RetainedServingImageEvidence = {
  generation: string;
  sha256: string;
  registerServingImage(image: string): boolean;
};

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('Retained serving image evidence held');
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireEvidence(value && typeof value === 'object' && !Array.isArray(value));
  const fields = Object.keys(value);
  requireEvidence(fields.length === keys.length && keys.every((key) => fields.includes(key)));
  return value as Record<string, unknown>;
}

function decode(value: unknown, max: number): Buffer {
  requireEvidence(typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4);
  const bytes = Buffer.from(value, 'base64');
  requireEvidence(bytes.length > 0 && bytes.length <= max && bytes.toString('base64') === value);
  return bytes;
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function readOrdinaryReleasePacket(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireEvidence(stat.isFile() && stat.size > 0 && stat.size <= limit);
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    requireEvidence(size === stat.size);
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

function verifyRetainedSignature(bundleValue: unknown, parentDigest: string) {
  const bundle = exactObject(bundleValue, ['mediaType', 'dsseEnvelope', 'verificationMaterial']);
  requireEvidence(bundle.mediaType === 'application/vnd.dev.sigstore.bundle.v0.3+json');
  const envelope = exactObject(bundle.dsseEnvelope, ['payload', 'payloadType', 'signatures']);
  const statement = exactObject(json(decode(envelope.payload, 16 * 1024)), [
    '_type',
    'predicateType',
    'subject',
    'predicate',
  ]);
  requireEvidence(
    statement._type === 'https://in-toto.io/Statement/v1' &&
      statement.predicateType === 'https://sigstore.dev/cosign/sign/v1' &&
      Array.isArray(statement.subject) &&
      statement.subject.length === 1,
  );
  const subject = exactObject(statement.subject[0], ['digest', 'annotations']);
  requireEvidence(exactObject(subject.digest, ['sha256']).sha256 === parentDigest);
}

function reviewedImage(role: Role, receipt: unknown): string {
  const digest = verifyRoleReceipt(
    receipt,
    role,
    PRIOR_SERVING_IMAGE_SOURCE,
    PRIOR_SERVING_IMAGE_BUILD,
  );
  requireEvidence(digest === `sha256:${PARENT_DIGESTS[role]}`);
  return `${IMAGE_ROOT}/${role}@${digest}`;
}

/** Use only after the protected release has retrieved the independently reviewed generation. */
export function loadRetainedServingImageEvidence(
  env: NodeJS.ProcessEnv = process.env,
): RetainedServingImageEvidence | undefined {
  const generation = env.OWNER_API3_RECOVERY_GENERATION;
  const sha256 = env.OWNER_API3_RECOVERY_SHA256;
  if (generation === undefined && sha256 === undefined) return undefined;

  try {
    requireEvidence(
      generation &&
        generation === ORDINARY_IDENTITY.generation &&
        sha256 &&
        sha256 === ORDINARY_IDENTITY.sha256 &&
        env.RUNNER_TEMP &&
        isAbsolute(env.RUNNER_TEMP),
    );
    const bytes = readOrdinaryReleasePacket(
      join(env.RUNNER_TEMP, RETAINED_SERVING_IMAGE_FILE),
      RETAINED_SERVING_IMAGE_LIMIT,
    );
    requireEvidence(createHash('sha256').update(bytes).digest('hex') === sha256);
    const packet = exactObject(json(bytes), ['format', 'kind', 'source', 'buildRun', 'roles']);
    requireEvidence(
      packet.format === 1 &&
        packet.kind === 'serving-image-identity' &&
        packet.source === PRIOR_SERVING_IMAGE_SOURCE &&
        packet.buildRun === PRIOR_SERVING_IMAGE_BUILD,
    );
    const services = exactObject(packet.roles, SERVICE_ROLES);
    const registered = new Map<string, { parent: Buffer; child: Buffer }>();
    for (const role of SERVICE_ROLES) {
      const item = exactObject(services[role], [
        'image',
        'buildReceipt',
        'parentBase64',
        'linuxAmd64Base64',
        'signatureBundle',
      ]);
      const image = reviewedImage(role, item.buildReceipt);
      requireEvidence(item.image === image);
      const parent = decode(item.parentBase64, 16 * 1024);
      const child = decode(item.linuxAmd64Base64, 16 * 1024);
      validateImageResolution(image, parent, child);
      // The fixed capsule SHA binds the previously verified bundle in full.
      verifyRetainedSignature(item.signatureBundle, PARENT_DIGESTS[role]);
      registered.set(image, { parent, child });
    }
    return {
      generation,
      sha256,
      registerServingImage(image) {
        const entry = registered.get(image);
        if (!entry) return false;
        registerImageResolution(image, entry.parent, entry.child);
        return true;
      },
    };
  } catch {
    // Paths, receipts, environment values and parser diagnostics may contain private data.
    throw new Error('Retained serving image evidence held');
  }
}
