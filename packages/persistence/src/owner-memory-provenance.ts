import { createHash } from 'node:crypto';

export type OwnerMemoryProvenanceDriver = 'postgres' | 'firestore';

export type OwnerMemoryProvenanceCollection =
  | 'memoryImportLineage'
  | 'importSources'
  | 'tasks'
  | 'conversations'
  | 'messages'
  | 'emailIngest'
  | 'contacts'
  | 'memoryTombstones';

export type OwnerMemoryProvenanceNativeVersion =
  | { kind: 'postgres_timestamp'; value: string }
  | { kind: 'firestore_timestamp'; seconds: number; nanoseconds: number }
  | null;

export type OwnerMemoryProvenanceJsonValue =
  | string
  | number
  | boolean
  | null
  | OwnerMemoryProvenanceJsonValue[]
  | { [key: string]: OwnerMemoryProvenanceJsonValue };

export interface OwnerMemoryProvenanceDependency {
  collection: OwnerMemoryProvenanceCollection;
  key: string;
  state: 'present' | 'missing';
  value: OwnerMemoryProvenanceJsonValue | null;
  nativeVersion: OwnerMemoryProvenanceNativeVersion;
}

export interface OwnerMemoryProvenanceQuery {
  collection: OwnerMemoryProvenanceCollection;
  scope: OwnerMemoryProvenanceJsonValue;
  limit: number;
  complete: boolean;
  keys: string[];
}

export interface OwnerMemoryProvenancePayload {
  version: 1;
  driver: OwnerMemoryProvenanceDriver;
  ownerId: string;
  memoryId: string;
  contentHash: string;
  targetSource: {
    source: string | null;
    sourceTaskId: string | null;
    subjectContactId: string | null;
  };
  dependencies: OwnerMemoryProvenanceDependency[];
  queries: OwnerMemoryProvenanceQuery[];
}

const COLLECTIONS = new Set<OwnerMemoryProvenanceCollection>([
  'memoryImportLineage',
  'importSources',
  'tasks',
  'conversations',
  'messages',
  'emailIngest',
  'contacts',
  'memoryTombstones',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// Exact UTC microsecond form; do not use Date because it rounds away sub-millisecond data.
const POSTGRES_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Computes the operation-bound external dependency fingerprint. Valid but
 * incomplete or cap-saturated reads return null; malformed payloads throw.
 * This is a fingerprint only and does not qualify a saved readback.
 */
export function ownerMemoryProvenanceFingerprint(value: unknown): string | null {
  const payload = parseOwnerMemoryProvenancePayload(value);
  const canonicalPayload = canonicalizeJsonValue(payload);

  if (payload.queries.some((query) => !query.complete || query.keys.length === query.limit)) {
    return null;
  }

  return createHash('sha256')
    .update('owner-memory-provenance-v1\n', 'utf8')
    .update(JSON.stringify(canonicalPayload), 'utf8')
    .digest('hex');
}

export function parseOwnerMemoryProvenancePayload(value: unknown): OwnerMemoryProvenancePayload {
  assertExactRecord(
    value,
    [
      'version',
      'driver',
      'ownerId',
      'memoryId',
      'contentHash',
      'targetSource',
      'dependencies',
      'queries',
    ],
    'owner-memory provenance payload',
  );

  if (value.version !== 1) throw new TypeError('Unsupported owner-memory provenance version');
  const driver = value.driver;
  if (driver !== 'postgres' && driver !== 'firestore') {
    throw new TypeError('Invalid owner-memory provenance driver');
  }
  assertUuid(value.ownerId, 'ownerId');
  assertUuid(value.memoryId, 'memoryId');
  assertSha256(value.contentHash, 'contentHash');

  assertExactRecord(
    value.targetSource,
    ['source', 'sourceTaskId', 'subjectContactId'],
    'owner-memory provenance targetSource',
  );
  if (
    value.targetSource.source !== null &&
    (typeof value.targetSource.source !== 'string' || value.targetSource.source.length === 0)
  ) {
    throw new TypeError('Invalid owner-memory provenance targetSource.source');
  }
  if (value.targetSource.sourceTaskId !== null)
    assertUuid(value.targetSource.sourceTaskId, 'sourceTaskId');
  if (value.targetSource.subjectContactId !== null) {
    assertUuid(value.targetSource.subjectContactId, 'subjectContactId');
  }

  const dependencies = readDenseArray(
    value.dependencies,
    'owner-memory provenance dependencies',
  ).map((dependency) => parseDependency(dependency, driver));
  dependencies.sort(compareDependencies);
  for (let index = 1; index < dependencies.length; index += 1) {
    if (compareDependencies(dependencies[index - 1]!, dependencies[index]!) === 0) {
      throw new TypeError('Duplicate owner-memory provenance dependency key');
    }
  }

  const queries = readDenseArray(value.queries, 'owner-memory provenance queries').map(parseQuery);
  queries.sort(compareQueries);
  for (let index = 1; index < queries.length; index += 1) {
    if (compareQueries(queries[index - 1]!, queries[index]!) === 0) {
      throw new TypeError('Duplicate owner-memory provenance query');
    }
  }

  return {
    version: 1,
    driver,
    ownerId: value.ownerId,
    memoryId: value.memoryId,
    contentHash: value.contentHash,
    targetSource: {
      source: value.targetSource.source,
      sourceTaskId: value.targetSource.sourceTaskId,
      subjectContactId: value.targetSource.subjectContactId,
    },
    dependencies,
    queries,
  };
}

function parseDependency(
  value: unknown,
  driver: OwnerMemoryProvenanceDriver,
): OwnerMemoryProvenanceDependency {
  assertExactRecord(
    value,
    ['collection', 'key', 'state', 'value', 'nativeVersion'],
    'owner-memory provenance dependency',
  );
  assertCollection(value.collection);
  assertNonemptyString(value.key, 'dependency key');
  if (value.state !== 'present' && value.state !== 'missing') {
    throw new TypeError('Invalid owner-memory provenance dependency state');
  }
  if (value.state === 'missing') {
    if (value.value !== null || value.nativeVersion !== null) {
      throw new TypeError(
        'Missing owner-memory provenance dependency must have null value and nativeVersion',
      );
    }
  } else if (!isPlainRecord(value.value)) {
    throw new TypeError('Present owner-memory provenance dependency requires an object value');
  } else if (driver === 'firestore' && value.nativeVersion === null) {
    throw new TypeError('Present Firestore dependency requires a native update timestamp');
  }

  const normalizedValue = value.value === null ? null : canonicalizeJsonValue(value.value);
  const nativeVersion = parseNativeVersion(value.nativeVersion, driver);
  return {
    collection: value.collection,
    key: value.key,
    state: value.state,
    value: normalizedValue,
    nativeVersion,
  };
}

function parseNativeVersion(
  value: unknown,
  driver: OwnerMemoryProvenanceDriver,
): OwnerMemoryProvenanceNativeVersion {
  if (value === null) return null;

  if (driver === 'postgres') {
    assertExactRecord(value, ['kind', 'value'], 'PostgreSQL nativeVersion');
    if (
      value.kind !== 'postgres_timestamp' ||
      typeof value.value !== 'string' ||
      !isValidPostgresTimestamp(value.value)
    ) {
      throw new TypeError('Invalid PostgreSQL nativeVersion timestamp');
    }
    return { kind: 'postgres_timestamp', value: value.value };
  }

  assertExactRecord(value, ['kind', 'seconds', 'nanoseconds'], 'Firestore nativeVersion');
  if (
    value.kind !== 'firestore_timestamp' ||
    typeof value.seconds !== 'number' ||
    !Number.isSafeInteger(value.seconds) ||
    typeof value.nanoseconds !== 'number' ||
    !Number.isInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds > 999_999_999
  ) {
    throw new TypeError('Invalid Firestore nativeVersion timestamp');
  }
  return {
    kind: 'firestore_timestamp',
    seconds: value.seconds,
    nanoseconds: value.nanoseconds,
  };
}

function parseQuery(value: unknown): OwnerMemoryProvenanceQuery {
  assertExactRecord(
    value,
    ['collection', 'scope', 'limit', 'complete', 'keys'],
    'owner-memory provenance query',
  );
  assertCollection(value.collection);
  if (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit <= 0) {
    throw new TypeError('Invalid owner-memory provenance query limit');
  }
  if (typeof value.complete !== 'boolean')
    throw new TypeError('Invalid owner-memory provenance query complete flag');

  const keys = readDenseArray(value.keys, 'owner-memory provenance query keys').map((key) => {
    assertNonemptyString(key, 'query key');
    return key;
  });
  if (keys.length > value.limit)
    throw new TypeError('Owner-memory provenance query exceeds its limit');
  const sortedKeys = [...keys].sort(compareStrings);
  for (let index = 1; index < sortedKeys.length; index += 1) {
    if (sortedKeys[index - 1] === sortedKeys[index]) {
      throw new TypeError('Duplicate owner-memory provenance query key');
    }
  }

  return {
    collection: value.collection,
    scope: canonicalizeJsonValue(value.scope),
    limit: value.limit,
    complete: value.complete,
    keys: sortedKeys,
  };
}

function compareDependencies(
  left: OwnerMemoryProvenanceDependency,
  right: OwnerMemoryProvenanceDependency,
): number {
  return compareStrings(left.collection, right.collection) || compareStrings(left.key, right.key);
}

function compareQueries(
  left: OwnerMemoryProvenanceQuery,
  right: OwnerMemoryProvenanceQuery,
): number {
  return (
    compareStrings(left.collection, right.collection) ||
    compareStrings(JSON.stringify(left.scope), JSON.stringify(right.scope)) ||
    left.limit - right.limit
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCollection(value: unknown): asserts value is OwnerMemoryProvenanceCollection {
  if (typeof value !== 'string' || !COLLECTIONS.has(value as OwnerMemoryProvenanceCollection)) {
    throw new TypeError('Invalid owner-memory provenance collection');
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`Invalid owner-memory provenance ${label}`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`Invalid owner-memory provenance ${label}`);
  }
}

function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Invalid owner-memory provenance ${label}`);
  }
}

function isValidPostgresTimestamp(value: string): boolean {
  const match = POSTGRES_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  return true;
}

function assertExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}`);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError(`Invalid ${label} keys`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      throw new TypeError(`Invalid ${label} property ${key}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDenseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
    throw new TypeError(`Invalid ${label} keys`);
  }

  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError(`Invalid ${label} item`);
    result.push(descriptor.value);
  }
  return result;
}

function canonicalizeJsonValue(value: unknown): OwnerMemoryProvenanceJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Invalid non-finite provenance JSON number');
    return value;
  }
  if (Array.isArray(value)) {
    return readDenseArray(value, 'provenance JSON array').map(canonicalizeJsonValue);
  }
  if (!isPlainRecord(value)) throw new TypeError('Invalid provenance JSON value');

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string'))
    throw new TypeError('Invalid provenance JSON object key');
  const sortedKeys = (keys as string[]).sort(compareStrings);
  const normalized: { [key: string]: OwnerMemoryProvenanceJsonValue } = Object.create(null) as {
    [key: string]: OwnerMemoryProvenanceJsonValue;
  };
  for (const key of sortedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      throw new TypeError('Invalid provenance JSON object property');
    normalized[key] = canonicalizeJsonValue(descriptor.value);
  }
  return normalized;
}
