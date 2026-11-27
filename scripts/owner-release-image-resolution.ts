/** Content-addressed OCI proof, not signature, source, or deployment authorization.
 * Callers still bind the expected parent to their reviewed release evidence.
 * The private cache contains only SHA256-verified immutable content relationships;
 * it never rewrites native responses or caches a revision/configuration decision.
 */
import { createHash } from 'node:crypto';

const ROOT = 'us-west1-docker.pkg.dev/bmson-assistant/assistant/';
const IMAGE =
  /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/(agent|web|browser|code|processor)@sha256:([a-f0-9]{64})$/;
const INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const LIMIT = 2 * 1024 * 1024;
type Obj = Record<string, unknown>;
const verified = new Map<string, string>();
function requireImage(value: unknown): asserts value {
  if (!value) throw new Error('Immutable image resolution unproven');
}
function obj(value: unknown): Obj {
  requireImage(value && typeof value === 'object' && !Array.isArray(value));
  return value as Obj;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function document(bytes: Uint8Array): Obj {
  requireImage(bytes.byteLength > 0 && bytes.byteLength <= LIMIT);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = obj(JSON.parse(source));
  // JSON.parse alone silently accepts duplicate keys. Reject them at every
  // object depth so registry and verifier interpretations cannot disagree.
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\],:]/gs;
  for (const token of source.matchAll(tokens)) {
    const text = token[0];
    if (text === '{' || text === '[') {
      stack.push(text === '{' ? new Set() : null);
      requireImage(stack.length <= 64);
    } else if (text === '}' || text === ']') stack.pop();
    else if (text.startsWith('"') && /^\s*:/.test(source.slice((token.index ?? 0) + text.length))) {
      const keys = stack.at(-1),
        key = JSON.parse(text) as string;
      requireImage(keys && !keys.has(key));
      keys.add(key);
    }
  }
  requireImage(
    value.schemaVersion === 2 && value.subject === undefined && value.artifactType === undefined,
  );
  return value;
}
function descriptor(value: unknown): Obj {
  const d = obj(value);
  requireImage(typeof d.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(d.digest));
  requireImage(Number.isSafeInteger(d.size) && Number(d.size) > 0);
  requireImage(typeof d.mediaType === 'string' && d.mediaType.length > 0);
  requireImage(d.urls === undefined && d.data === undefined);
  return d;
}
function manifest(value: Obj) {
  requireImage(value.mediaType === MANIFEST);
  requireImage(descriptor(value.config).mediaType === 'application/vnd.oci.image.config.v1+json');
  requireImage(
    Array.isArray(value.layers) && value.layers.length > 0 && value.layers.length <= 256,
  );
  for (const layer of value.layers) {
    requireImage(
      [
        'application/vnd.oci.image.layer.v1.tar',
        'application/vnd.oci.image.layer.v1.tar+gzip',
        'application/vnd.oci.image.layer.v1.tar+zstd',
      ].includes(String(descriptor(layer).mediaType)),
    );
  }
}
function selected(parent: Obj): Obj {
  requireImage(parent.mediaType === INDEX && Array.isArray(parent.manifests));
  requireImage(parent.manifests.length > 0 && parent.manifests.length <= 32);
  const entries = parent.manifests.map(descriptor);
  for (const entry of entries) {
    requireImage(entry.mediaType === MANIFEST);
    const platform = obj(entry.platform);
    requireImage(typeof platform.os === 'string' && typeof platform.architecture === 'string');
  }
  const candidates = entries.filter((entry) => {
    const p = obj(entry.platform);
    return p.os === 'linux' && p.architecture === 'amd64';
  });
  requireImage(candidates.length === 1);
  const child = candidates[0];
  requireImage(child);
  requireImage(Object.keys(obj(child.platform)).sort().join(',') === 'architecture,os');
  requireImage(entries.filter((entry) => entry.digest === child.digest).length === 1);
  return child;
}
/** Verify exact raw parent/child bytes without changing the image cache. */
export function validateImageResolution(
  image: string,
  parentBytes: Uint8Array,
  childBytes: Uint8Array,
) {
  requireImage(IMAGE.test(image) && image.endsWith(`@sha256:${sha(parentBytes)}`));
  const parent = document(parentBytes),
    child = document(childBytes);
  manifest(child);
  const childDigest = `sha256:${sha(childBytes)}`;
  if (parent.mediaType === INDEX) {
    const entry = selected(parent);
    requireImage(
      entry.digest === childDigest &&
        entry.size === childBytes.byteLength &&
        entry.mediaType === child.mediaType,
    );
  } else {
    manifest(parent);
    requireImage(Buffer.from(parentBytes).equals(Buffer.from(childBytes)));
  }
  const resolved = `${image.split('@')[0]}@${childDigest}`;
  return { image, resolved, parentSha256: sha(parentBytes), childSha256: sha(childBytes) };
}

export function registerImageResolution(
  image: string,
  parentBytes: Uint8Array,
  childBytes: Uint8Array,
) {
  const proof = validateImageResolution(image, parentBytes, childBytes);
  const { resolved } = proof;
  requireImage(verified.size < 128 || verified.has(image));
  requireImage(!verified.has(image) || verified.get(image) === resolved);
  verified.set(image, resolved);
  return proof;
}
/** Exact legacy equality stays valid. A different digest requires content and native status proof. */
export function verifyRevisionImage(revision: unknown, expected: string): void {
  const r = obj(revision),
    cs = r.containers;
  requireImage(Array.isArray(cs) && cs.length === 1);
  const container = obj(cs[0]);
  if (container.image === expected) return;
  requireImage(IMAGE.test(expected) && verified.get(expected) === container.image);
  const statuses = r.containerStatuses;
  requireImage(Array.isArray(statuses) && statuses.length === 1);
  const status = obj(statuses[0]);
  requireImage(typeof container.name === 'string' && container.name.length > 0);
  requireImage(status.name === container.name && status.imageDigest === container.image);
}
/** A semantic copy for template comparison only. Raw revision hashes must use the original. */
export function revisionWithRequestedImage(revision: unknown, expected: string): Obj {
  verifyRevisionImage(revision, expected);
  const r = obj(revision),
    containers = r.containers as unknown[];
  return { ...r, containers: [{ ...obj(containers[0]), image: expected }] };
}
/** Fixed-repository digest GETs only, using the caller's already-authorized release credential. */
export function createImageResolutionReader(
  token: string,
  request: typeof fetch = fetch,
  deadline = Date.now() + 60_000,
  retained?: { registerServingImage(image: string): boolean },
) {
  requireImage(/^[A-Za-z0-9._~-]{1,16384}$/.test(token));
  let calls = 0;
  async function raw(image: string): Promise<Buffer> {
    requireImage(IMAGE.test(image) && ++calls <= 32);
    const remaining = Math.min(15_000, deadline - Date.now());
    requireImage(remaining > 0);
    const [component, digest] = image.slice(ROOT.length).split('@');
    const url = `https://us-west1-docker.pkg.dev/v2/bmson-assistant/assistant/${component}/manifests/${digest}`;
    const response = await request(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(remaining),
      headers: { Authorization: `Bearer ${token}`, Accept: `${INDEX}, ${MANIFEST}` },
    });
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Image content read rejected');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        requireImage(size <= LIMIT && Date.now() < deadline);
        chunks.push(part.value);
      }
      const bytes = Buffer.concat(chunks);
      requireImage(image.endsWith(`@sha256:${sha(bytes)}`));
      return bytes;
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }
  return async (image: string) => {
    requireImage(IMAGE.test(image));
    if (verified.has(image) || retained?.registerServingImage(image)) return;
    try {
      const parentBytes = await raw(image),
        parent = document(parentBytes);
      const childBytes =
        parent.mediaType === INDEX
          ? await raw(`${image.split('@')[0]}@${selected(parent).digest}`)
          : parentBytes;
      registerImageResolution(image, parentBytes, childBytes);
    } catch {
      // Never propagate provider bodies, URLs or token-bearing transport exceptions.
      throw new Error('Image content resolution failed');
    }
  };
}
