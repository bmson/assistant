import { Buffer } from 'node:buffer';
import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  FieldValue,
  Firestore,
  Timestamp,
  VectorValue,
} from '@google-cloud/firestore';
import type { AuthClient } from 'google-auth-library';
import { retryEmulatorTransactions } from './emulator-transaction.js';

const CODEC_TAG = 'assistantFirestoreCodecV1';
const CODEC_MARKER = Buffer.from('assistant-firestore-codec-v1', 'utf8');

type CodecPayload =
  | {
      kind: 'array' | 'object';
      length?: number;
      marker: Buffer;
      items: Record<string, unknown>;
    }
  | { kind: 'bigint'; marker: Buffer; value: string };

function codecPayload(input: unknown): CodecPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const entries = Object.entries(input);
  if (entries.length !== 1 || entries[0]?.[0] !== CODEC_TAG) return null;
  const payload = entries[0][1];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (!Buffer.isBuffer(value.marker) || !value.marker.equals(CODEC_MARKER)) return null;
  if (value.kind === 'bigint')
    return typeof value.value === 'string' && /^-?(0|[1-9]\d*)$/.test(value.value)
      ? (value as CodecPayload)
      : null;
  if ((value.kind !== 'array' && value.kind !== 'object') || !value.items) return null;
  if (typeof value.items !== 'object' || Array.isArray(value.items)) return null;
  if (
    value.kind === 'array' &&
    (!Number.isSafeInteger(value.length) || (value.length as number) < 0)
  )
    return null;
  return value as CodecPayload;
}

/** Encode IDs reversibly so slashes, provider IDs, and reserved names cannot change scope. */
export function documentKey(id: string): string {
  if (!id || Buffer.byteLength(id, 'utf8') > 1000) throw new Error('Invalid document identifier');
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeRecord<T>(value: unknown): T {
  function visit(input: unknown): unknown {
    if (input instanceof Timestamp) return input.toDate();
    if (input instanceof VectorValue) return input.toArray();
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object' && !(input instanceof Date) && !Buffer.isBuffer(input)) {
      const tagged = codecPayload(input);
      if (tagged?.kind === 'bigint') return BigInt(tagged.value);
      if (tagged?.kind === 'array')
        return Array.from({ length: tagged.length as number }, (_, index) =>
          visit(tagged.items[index]),
        );
      if (tagged?.kind === 'object')
        return Object.fromEntries(
          Object.entries(tagged.items).map(([key, field]) => [key, visit(field)]),
        );
      return Object.fromEntries(Object.entries(input).map(([key, field]) => [key, visit(field)]));
    }
    return input;
  }
  return visit(value) as T;
}

/** Skip absent optional object fields; an undefined array element is always a programming error. */
export function encodeRecord(value: DocumentData): DocumentData {
  function visit(input: unknown, insideArray = false): unknown {
    if (input === undefined) throw new Error('Undefined array value cannot be persisted');
    // The SDK decodes native int64 values as Number by default. Preserve bigint
    // fields without changing every ordinary integer in application records.
    if (typeof input === 'bigint')
      return { [CODEC_TAG]: { kind: 'bigint', marker: CODEC_MARKER, value: input.toString() } };
    if (input instanceof Date) {
      if (!Number.isFinite(input.getTime())) throw new Error('Invalid persisted timestamp');
      return input;
    }
    if (
      input instanceof FieldValue ||
      input instanceof VectorValue ||
      input instanceof Timestamp ||
      Buffer.isBuffer(input)
    ) {
      return input;
    }
    if (Array.isArray(input)) {
      if (insideArray)
        return {
          [CODEC_TAG]: {
            kind: 'array',
            marker: CODEC_MARKER,
            length: input.length,
            items: Object.fromEntries(input.map((item, index) => [index, visit(item)])),
          },
        };
      return input.map((item) => visit(item, true));
    }
    if (input && typeof input === 'object') {
      const encoded = Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .map(([key, v]) => [key, visit(v)]),
      );
      if (CODEC_TAG in input)
        return { [CODEC_TAG]: { kind: 'object', marker: CODEC_MARKER, items: encoded } };
      return encoded;
    }
    if (typeof input === 'number' && !Number.isFinite(input))
      throw new Error('Nonfinite persisted number');
    return input;
  }
  const message =
    value &&
    typeof value === 'object' &&
    typeof value.conversationId === 'string' &&
    typeof value.role === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.parts) &&
    value.createdAt instanceof Date;
  // Firestore assigns serverTimestamp at commit. It is the polling order key:
  // client-created/transaction-start timestamps can be arbitrarily older than
  // a row that commits after a page cursor has advanced.
  const persisted = message ? { ...value, appendedAt: FieldValue.serverTimestamp() } : value;
  return visit(persisted) as DocumentData;
}

export class InstallationStore {
  readonly root: DocumentReference;

  constructor(
    readonly db: Firestore,
    readonly installationId: string,
    readonly now: () => Date = () => new Date(),
    readonly projectId?: string,
    readonly databaseId = '(default)',
  ) {
    this.root = db.collection('installations').doc(documentKey(installationId));
    retryEmulatorTransactions(db);
  }

  collection(name: string): CollectionReference {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid collection');
    return this.root.collection(name);
  }

  doc(collection: string, id: string): DocumentReference {
    return this.collection(collection).doc(documentKey(id));
  }
}

export function createInstallationStore(input: {
  projectId: string;
  installationId: string;
  databaseId?: string;
  /** Optional operator auth client, forwarded through Firestore's GAPIC settings. */
  authClient?: AuthClient;
}): InstallationStore {
  if (!input.projectId) throw new Error('Firestore requires a project ID');
  const settings = {
    projectId: input.projectId,
    databaseId: input.databaseId ?? '(default)',
    ...(input.authClient ? { authClient: input.authClient, preferRest: true } : {}),
  } as ConstructorParameters<typeof Firestore>[0] & { authClient?: AuthClient };
  return new InstallationStore(
    new Firestore(settings),
    input.installationId,
    undefined,
    input.projectId,
    input.databaseId ?? '(default)',
  );
}
