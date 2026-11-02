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
type ReadStage =
  | 'owner_first_read'
  | 'privacy_first_read'
  | 'epoch_first_read'
  | 'owner_second_read'
  | 'privacy_second_read'
  | 'epoch_second_read'
  | 'consistency_check'
  | 'owner_first_validation'
  | 'privacy_first_validation'
  | 'epoch_first_validation'
  | 'owner_second_validation'
  | 'privacy_second_validation'
  | 'epoch_second_validation'
  | 'complete';
type ReadFailureReason =
  | 'read_http_denied'
  | 'read_http_unavailable'
  | 'read_transport_unavailable'
  | 'read_body_too_large'
  | 'read_response_invalid'
  | 'read_deadline_expired'
  | 'metadata_schema_invalid'
  | 'metadata_unstable';
class MetadataReadFailure extends Error {
  constructor(
    readonly reason: ReadFailureReason,
    readonly httpStatus: number | null = null,
  ) {
    super(reason);
  }
}
const metadataFailure = (reason: ReadFailureReason, httpStatus: number | null = null) =>
  new MetadataReadFailure(reason, httpStatus);
function canonicalObservation(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, child]) => [name, normalize(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}
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
      throw metadataFailure(
        Date.now() >= deadline ? 'read_deadline_expired' : 'read_transport_unavailable',
      );
    const controller = new AbortController();
    let deadlineAbort = false;
    const timer = setTimeout(
      () => {
        deadlineAbort = true;
        controller.abort();
      },
      Math.min(8000, deadline - Date.now()),
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (deadlineAbort || Date.now() >= deadline) throw metadataFailure('read_deadline_expired');
      if (response.status === 404) return null;
      if (!response.ok)
        throw metadataFailure(
          response.status === 401 || response.status === 403
            ? 'read_http_denied'
            : 'read_http_unavailable',
          response.status,
        );
      if (!response.body) throw metadataFailure('read_response_invalid', response.status);
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (deadlineAbort || Date.now() >= deadline)
          throw metadataFailure('read_deadline_expired', response.status);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16_384) throw metadataFailure('read_body_too_large', response.status);
        chunks.push(part.value);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw metadataFailure('read_response_invalid', response.status);
      }
    } catch (error) {
      if (error instanceof MetadataReadFailure) throw error;
      if (deadlineAbort || Date.now() >= deadline) throw metadataFailure('read_deadline_expired');
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  };
}

const stringField = (doc: ObjectValue, field: string): string => {
  const value = object(object(doc.fields)[field]);
  if (Object.keys(value).length !== 1 || typeof value.stringValue !== 'string')
    throw new Error('invalid masked string field');
  return value.stringValue;
};
function firestoreTimestamp(value: unknown): { seconds: number; nanoseconds: number } {
  if (typeof value !== 'string') throw new Error('invalid Firestore update time');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) throw new Error('invalid Firestore update time');
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1])
    throw new Error('invalid Firestore update time');
  return {
    seconds: millis / 1000,
    nanoseconds: Number((match[2] ?? '').padEnd(9, '0')),
  };
}
function privacyDigest(job: unknown, ownerId: string): string {
  let token: string | null = null;
  if (job !== null) {
    const doc = object(job),
      generation = stringField(doc, 'generation');
    if (
      stringField(doc, 'agentId') !== ownerId ||
      stringField(doc, 'status') !== 'complete' ||
      typeof generation !== 'string'
    )
      throw new Error('privacy unavailable');
    const timestamp = firestoreTimestamp(doc.updateTime);
    // Exact native seconds/nanos token and string digest match feature1ead's helper.
    token = JSON.stringify({
      generation,
      seconds: timestamp.seconds,
      nanoseconds: timestamp.nanoseconds,
    });
  }
  return createHash('sha256')
    .update('owner-editor-privacy-v1\n')
    .update(JSON.stringify(token))
    .digest('hex');
}

interface EditorMetadataObservation {
  canonical: string;
  ownerPopulationVerified: boolean;
  privacyDigest: string;
  epochState: {
    epoch: string;
    ownerId: string;
    privacyGenerationDigest: string;
    ready: boolean;
  } | null;
}

function validateEditorMetadataObservation(
  snapshot: unknown[],
  target: EditorMetadataTarget,
  urls: readonly [string, string, string],
  pass: 'first' | 'second',
  setStage: (stage: ReadStage) => void,
): EditorMetadataObservation {
  setStage(pass === 'first' ? 'owner_first_validation' : 'owner_second_validation');
  const owners = object(snapshot[0]);
  if (!Array.isArray(owners.documents)) throw new Error('invalid owner set');
  if (owners.nextPageToken !== undefined && typeof owners.nextPageToken !== 'string')
    throw new Error('invalid owner pagination');
  const ownerPath = new URL(urls[0]).pathname.replace(/^\/v1\//, '').split('/agents')[0];
  const ownerMembers = owners.documents.map((raw) => {
    const owner = object(raw);
    const id = stringField(owner, 'id');
    const name = owner.name;
    if (typeof id !== 'string' || !uuid.test(id) || name !== `${ownerPath}/agents/${key(id)}`)
      throw new Error('owner identity mismatch');
    return { id, name: name as string, updateTime: firestoreTimestamp(owner.updateTime) };
  });
  const ownerPopulationVerified =
    ownerMembers.length === 1 && !owners.nextPageToken && ownerMembers[0]?.id === target.ownerId;
  if (ownerMembers.length === 1 && ownerMembers[0]?.id !== target.ownerId)
    throw new Error('owner mismatch');

  setStage(pass === 'first' ? 'privacy_first_validation' : 'privacy_second_validation');
  const privacy = snapshot[1];
  if (privacy !== null && object(privacy).name !== new URL(urls[1]).pathname.replace(/^\/v1\//, ''))
    throw new Error('privacy identity mismatch');
  const expectedPrivacyDigest = privacyDigest(privacy, target.ownerId);
  const privacyObservation =
    privacy === null
      ? null
      : {
          name: object(privacy).name,
          agentId: stringField(object(privacy), 'agentId'),
          status: stringField(object(privacy), 'status'),
          generation: stringField(object(privacy), 'generation'),
          updateTime: firestoreTimestamp(object(privacy).updateTime),
        };

  setStage(pass === 'first' ? 'epoch_first_validation' : 'epoch_second_validation');
  const epochRaw = snapshot[2];
  let epochState: EditorMetadataObservation['epochState'] = null;
  let epochObservation: unknown = null;
  if (epochRaw !== null) {
    const epoch = object(epochRaw);
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
    epochState = {
      epoch: state.epoch,
      ownerId: state.ownerId,
      privacyGenerationDigest: state.privacyGenerationDigest,
      ready: state.ready,
    };
    epochObservation = {
      name: epoch.name,
      storedName: stringField(epoch, 'name'),
      updateTime: firestoreTimestamp(epoch.updateTime),
      state: epochState,
    };
  }

  return {
    canonical: canonicalObservation({
      ownerMembers: [...ownerMembers].sort((left, right) => left.id.localeCompare(right.id)),
      ownerHasNextPage: Boolean(owners.nextPageToken),
      privacy: privacyObservation,
      epoch: epochObservation,
    }),
    ownerPopulationVerified,
    privacyDigest: expectedPrivacyDigest,
    epochState,
  };
}

export async function observeEditorReadiness(
  read: EditorMetadataRead,
  target: EditorMetadataTarget,
) {
  const urls = editorMetadataUrls(target);
  let stage: ReadStage = 'owner_first_read';
  try {
    const first: unknown[] = [],
      second: unknown[] = [];
    const [ownerUrl, privacyUrl, epochUrl] = urls;
    stage = 'owner_first_read';
    first.push(await read(ownerUrl));
    stage = 'privacy_first_read';
    first.push(await read(privacyUrl));
    stage = 'epoch_first_read';
    first.push(await read(epochUrl));
    stage = 'owner_second_read';
    second.push(await read(ownerUrl));
    stage = 'privacy_second_read';
    second.push(await read(privacyUrl));
    stage = 'epoch_second_read';
    second.push(await read(epochUrl));
    const firstObservation = validateEditorMetadataObservation(
      first,
      target,
      urls,
      'first',
      (nextStage) => (stage = nextStage),
    );
    const secondObservation = validateEditorMetadataObservation(
      second,
      target,
      urls,
      'second',
      (nextStage) => (stage = nextStage),
    );
    stage = 'consistency_check';
    if (firstObservation.canonical !== secondObservation.canonical)
      throw metadataFailure('metadata_unstable');
    stage = 'complete';
    if (!firstObservation.ownerPopulationVerified)
      return {
        status: 'unavailable',
        reason: 'single_owner_not_verified',
        stage,
        httpStatus: null,
        epochPresent: null,
        epochReady: null,
      };
    if (firstObservation.epochState === null)
      return {
        status: 'missing',
        reason: 'editor_epoch_missing',
        epochPresent: false,
        epochReady: false,
        stage,
        httpStatus: null,
      };
    const state = firstObservation.epochState;
    const bound = state.privacyGenerationDigest === firstObservation.privacyDigest;
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
      stage,
      httpStatus: null,
    };
  } catch (error) {
    // No permission changes, raw responses, cursor, owner UUID, generation or tokens in receipts.
    const failure =
      error instanceof MetadataReadFailure
        ? error
        : metadataFailure(
            stage === 'consistency_check'
              ? 'metadata_unstable'
              : stage.endsWith('_validation')
                ? 'metadata_schema_invalid'
                : 'read_transport_unavailable',
          );
    return {
      status: 'unknown',
      reason: failure.reason,
      stage,
      httpStatus: failure.httpStatus,
      epochPresent: null,
      epochReady: null,
    };
  }
}
