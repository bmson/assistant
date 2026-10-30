/** Field-masked metadata observations only. No epoch creation, rotation or activation. */
import { createHash } from 'node:crypto';

const database = 'projects/bmson-assistant/databases/assistant-production';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ObjectValue = Record<string, unknown>;
export interface EditorMetadataTarget {
  workspaceId: string;
  ownerId: string;
}
export type EditorMetadataRead = (url: string) => Promise<unknown | null>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid metadata');
  return value as ObjectValue;
};
const key = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

/** Only explicit matching serving-template values; no guessed installation or owner. */
export function editorMetadataTarget(raw: unknown): EditorMetadataTarget | null {
  const service = object(raw),
    template = object(service.template);
  if (!Array.isArray(template.containers) || template.containers.length !== 1) return null;
  const env = object(template.containers[0]).env;
  if (!Array.isArray(env)) return null;
  const value = (name: string) => {
    const entries = env.map(object).filter((e) => e.name === name);
    if (entries.length !== 1 || entries[0]?.valueSource || entries[0]?.valueFrom) return null;
    return entries[0]?.value;
  };
  const workspaceId = value('ASSISTANT_WORKSPACE_ID'),
    ownerId = value('FIRESTORE_AGENT_ID');
  return typeof workspaceId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) &&
    typeof ownerId === 'string' &&
    uuid.test(ownerId)
    ? { workspaceId, ownerId }
    : null;
}

export function editorMetadataUrls(target: EditorMetadataTarget) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(target.workspaceId) || !uuid.test(target.ownerId))
    throw new Error('invalid metadata target');
  const root = `https://firestore.googleapis.com/v1/${database}/documents/installations/${key(target.workspaceId)}`;
  return [
    `${root}/agents?pageSize=2&mask.fieldPaths=id`,
    `${root}/privacyErasureJobs/${key(target.ownerId)}?mask.fieldPaths=agentId&mask.fieldPaths=status&mask.fieldPaths=generation`,
    `${root}/maintenanceCursors/${key(`owner-editor-epoch:${target.ownerId}`)}?mask.fieldPaths=name&mask.fieldPaths=cursor`,
  ] as const;
}

/** At most6GETs,16KiB each, sharing the collector's absolute deadline. */
export function createEditorMetadataRead(
  token: string,
  deadline: number,
  target: EditorMetadataTarget,
  fetcher: typeof fetch = fetch,
): EditorMetadataRead {
  if (!/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) throw new Error('invalid credential');
  const urls = new Set<string>(editorMetadataUrls(target));
  let calls = 0;
  return async (url) => {
    if (!urls.has(url) || ++calls > 6 || Date.now() >= deadline)
      throw new Error('metadata unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(8000, deadline - Date.now()));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw new Error('metadata unavailable');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (Date.now() >= deadline) throw new Error('metadata unavailable');
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16_384) throw new Error('metadata unavailable');
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  };
}

const stringField = (doc: ObjectValue, field: string) =>
  object(object(doc.fields)[field]).stringValue;
function privacyDigest(job: unknown, ownerId: string): string {
  let token: string | null = null;
  if (job !== null) {
    const doc = object(job),
      generation = stringField(doc, 'generation');
    if (
      stringField(doc, 'agentId') !== ownerId ||
      stringField(doc, 'status') !== 'complete' ||
      typeof generation !== 'string' ||
      typeof doc.updateTime !== 'string'
    )
      throw new Error('privacy unavailable');
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(doc.updateTime);
    if (!match) throw new Error('privacy unavailable');
    const millis = Date.parse(`${match[1]}Z`);
    if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1])
      throw new Error('privacy unavailable');
    // Exact native seconds/nanos token and string digest match feature1ead's helper.
    token = JSON.stringify({
      generation,
      seconds: millis / 1000,
      nanoseconds: Number((match[2] ?? '').padEnd(9, '0')),
    });
  }
  return createHash('sha256')
    .update('owner-editor-privacy-v1\n')
    .update(JSON.stringify(token))
    .digest('hex');
}

export async function observeEditorReadiness(
  read: EditorMetadataRead,
  target: EditorMetadataTarget,
) {
  const urls = editorMetadataUrls(target);
  try {
    const first: unknown[] = [],
      second: unknown[] = [];
    for (const url of urls) first.push(await read(url));
    for (const url of urls) second.push(await read(url));
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('unstable metadata');
    const owners = object(first[0]);
    if (!Array.isArray(owners.documents) || owners.documents.length !== 1 || owners.nextPageToken)
      return {
        status: 'unavailable',
        reason: 'single_owner_not_verified',
        epochPresent: null,
        epochReady: null,
      };
    const owner = object(owners.documents[0]);
    const ownerPath = new URL(urls[0]).pathname.replace(/^\/v1\//, '').split('/agents')[0];
    if (
      owner.name !== `${ownerPath}/agents/${key(target.ownerId)}` ||
      stringField(owner, 'id') !== target.ownerId
    )
      throw new Error('owner mismatch');
    if (
      first[1] !== null &&
      object(first[1]).name !== new URL(urls[1]).pathname.replace(/^\/v1\//, '')
    )
      throw new Error('privacy identity mismatch');
    const expected = privacyDigest(first[1], target.ownerId);
    if (first[2] === null)
      return {
        status: 'missing',
        reason: 'editor_epoch_missing',
        epochPresent: false,
        epochReady: false,
      };
    const epoch = object(first[2]);
    if (epoch.name !== new URL(urls[2]).pathname.replace(/^\/v1\//, ''))
      throw new Error('epoch identity mismatch');
    if (stringField(epoch, 'name') !== `owner-editor-epoch:${target.ownerId}`)
      throw new Error('invalid epoch');
    const cursor = stringField(epoch, 'cursor');
    if (typeof cursor !== 'string') throw new Error('invalid epoch');
    const state = object(JSON.parse(cursor));
    if (
      Object.keys(state).sort().join(',') !== 'epoch,ownerId,privacyGenerationDigest,ready' ||
      state.ownerId !== target.ownerId ||
      typeof state.epoch !== 'string' ||
      !uuid.test(state.epoch) ||
      typeof state.ready !== 'boolean' ||
      typeof state.privacyGenerationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.privacyGenerationDigest)
    )
      throw new Error('invalid epoch');
    const bound = state.privacyGenerationDigest === expected;
    return {
      status: state.ready && bound ? 'ready' : 'unavailable',
      reason: !bound
        ? 'editor_privacy_binding_changed'
        : state.ready
          ? null
          : 'editor_epoch_disabled',
      epochPresent: true,
      epochReady: state.ready,
      ownerMatched: true,
      privacyBound: bound,
      observationStable: true,
      consistentSnapshot: false,
      activationAuthorized: false,
    };
  } catch {
    // No permission changes, raw responses, cursor, owner UUID, generation or tokens in receipts.
    return {
      status: 'unknown',
      reason: 'metadata_read_denied_invalid_or_unstable',
      epochPresent: null,
      epochReady: null,
    };
  }
}
