import { createHash } from 'node:crypto';
import type { ReadOnlyJsonClient } from './owner-editor-readonly-http.js';

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_GROUPS = 256;
const MAX_PAGES_PER_GROUP = 8;
const PAGE_SIZE = 100;
const MAX_RESULTS_PER_GROUP = 1_000;
const FIRESTORE_API_ORIGIN = 'https://firestore.googleapis.com';
const FIELD_FILTER = 'indexConfig.usesAncestorConfig:false';

export type OwnerEditorIndexObservationDiagnostic =
  | 'manifest_invalid'
  | 'target_invalid'
  | 'observation_failed'
  | 'scoped_parity_differs'
  | 'index_build_incomplete';

export interface OwnerEditorIndexObservationReport {
  schemaVersion: 'owner-editor-index-observation/v1';
  scopedIndexParity: 'matches' | 'not_ready' | 'unknown';
  manifestSha256: string | null;
  counts: {
    expectedCompositeIndexes: number;
    observedCompositeIndexes: number;
    expectedFieldOverrides: number;
    observedFieldOverrides: number;
    collectionGroups: number;
  };
  diagnostics: OwnerEditorIndexObservationDiagnostic[];
  globalIndexReadiness: 'unsupported_incomplete_field_inventory';
}

type CanonicalField =
  | { fieldPath: string; order: 'ASCENDING' | 'DESCENDING' }
  | { fieldPath: string; arrayConfig: 'CONTAINS' }
  | { fieldPath: string; vectorConfig: { dimension: number; flat: Record<string, never> } };

interface CanonicalIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  apiScope: 'ANY_API' | 'DATASTORE_MODE_API' | 'MONGODB_COMPATIBLE_API';
  fields: CanonicalField[];
  state?: 'READY' | 'CREATING' | 'NEEDS_REPAIR';
}

interface CanonicalOverride {
  collectionGroup: string;
  fieldPath: string;
}

interface ManifestSpec {
  indexes: CanonicalIndex[];
  fieldOverrides: CanonicalOverride[];
}

class ObservationFailure extends Error {
  constructor(readonly diagnostic: OwnerEditorIndexObservationDiagnostic) {
    super(diagnostic);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid');
  return value;
}

function collectionGroup(value: unknown): string {
  const result = requiredString(value);
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(result)) throw new Error('invalid');
  return result;
}

function canonicalField(raw: unknown): CanonicalField {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['fieldPath', 'order', 'arrayConfig', 'vectorConfig']))
    throw new Error('invalid');
  const fieldPath = requiredString(raw.fieldPath);
  if (fieldPath.length > 1_500) throw new Error('invalid');
  const modes = ['order', 'arrayConfig', 'vectorConfig'].filter((key) => raw[key] !== undefined);
  if (modes.length !== 1) throw new Error('invalid');
  if (raw.order !== undefined) {
    if (raw.order !== 'ASCENDING' && raw.order !== 'DESCENDING') throw new Error('invalid');
    return { fieldPath, order: raw.order };
  }
  if (raw.arrayConfig !== undefined) {
    if (raw.arrayConfig !== 'CONTAINS') throw new Error('invalid');
    return { fieldPath, arrayConfig: 'CONTAINS' };
  }
  const vector = raw.vectorConfig;
  if (
    !isRecord(vector) ||
    !hasOnlyKeys(vector, ['dimension', 'flat']) ||
    !Number.isSafeInteger(vector.dimension) ||
    (vector.dimension as number) <= 0 ||
    !isRecord(vector.flat) ||
    Object.keys(vector.flat).length !== 0
  )
    throw new Error('invalid');
  return { fieldPath, vectorConfig: { dimension: vector.dimension as number, flat: {} } };
}

function canonicalIndex(
  raw: unknown,
  trusted: boolean,
  project = '',
  database = '',
  expectedGroup?: string,
): CanonicalIndex {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(
      raw,
      trusted
        ? ['collectionGroup', 'queryScope', 'apiScope', 'fields']
        : ['name', 'queryScope', 'apiScope', 'fields', 'state'],
    )
  )
    throw new Error('invalid');

  let group: string;
  if (trusted) {
    group = collectionGroup(raw.collectionGroup);
  } else {
    const name = requiredString(raw.name);
    const prefix = `projects/${project}/databases/${database}/collectionGroups/`;
    if (!name.startsWith(prefix)) throw new Error('invalid');
    const suffix = name.slice(prefix.length);
    const match = /^([A-Za-z0-9_-]{1,150})\/indexes\/[^/]+$/.exec(suffix);
    if (!match?.[1]) throw new Error('invalid');
    group = match[1];
    if (expectedGroup !== undefined && group !== expectedGroup) throw new Error('invalid');
  }

  if (raw.queryScope !== 'COLLECTION' && raw.queryScope !== 'COLLECTION_GROUP')
    throw new Error('invalid');
  const apiScope = raw.apiScope === undefined ? 'ANY_API' : raw.apiScope;
  // Official Index.ApiScope enum; ANY_API is its omitted ProtoJSON default.
  if (
    apiScope !== 'ANY_API' &&
    apiScope !== 'DATASTORE_MODE_API' &&
    apiScope !== 'MONGODB_COMPATIBLE_API'
  )
    throw new Error('invalid');
  if (!Array.isArray(raw.fields) || raw.fields.length < 2 || raw.fields.length > 100)
    throw new Error('invalid');
  const fields = raw.fields.map(canonicalField);
  const fieldPaths = fields.map((field) => field.fieldPath);
  if (new Set(fieldPaths).size !== fieldPaths.length) throw new Error('invalid');
  const namePositions = fields.flatMap((field, index) =>
    field.fieldPath === '__name__' ? [index] : [],
  );
  const vectorPosition = fields.findIndex((field) => 'vectorConfig' in field);
  if (fields.filter((field) => 'vectorConfig' in field).length > 1) throw new Error('invalid');
  if (
    namePositions.length > 1 ||
    (namePositions.length === 1 &&
      namePositions[0] !== fields.length - 1 &&
      (trusted || namePositions[0] !== vectorPosition - 1))
  )
    throw new Error('invalid');
  if (
    vectorPosition >= 0 &&
    vectorPosition !== fields.length - 1 &&
    !(namePositions[0] === fields.length - 1 && vectorPosition === fields.length - 2)
  )
    throw new Error('invalid');
  if (trusted) {
    if (namePositions.length === 1) {
      const precedingOrder = fields.at(-2);
      const expectedOrder =
        precedingOrder && 'order' in precedingOrder && precedingOrder.order === 'DESCENDING'
          ? 'DESCENDING'
          : 'ASCENDING';
      const nameField = fields.at(-1);
      if (!nameField || !('order' in nameField) || nameField.order !== expectedOrder)
        throw new Error('invalid');
    } else {
      const last = fields.at(-1);
      fields.push({
        fieldPath: '__name__',
        order: last && 'order' in last && last.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
      });
    }
  }
  // Match packages/setup's pure canonicalIndex: Firestore places the implicit
  // document-name field immediately before a terminal vector field in its API
  // response; the manifest-side identity keeps that field at the end.
  if (!trusted && vectorPosition === fields.length - 1 && namePositions[0] === vectorPosition - 1) {
    const [documentName] = fields.splice(fields.length - 2, 1);
    if (documentName) fields.push(documentName);
  }

  let state: CanonicalIndex['state'];
  if (!trusted) {
    if (raw.state !== 'READY' && raw.state !== 'CREATING' && raw.state !== 'NEEDS_REPAIR')
      throw new Error('invalid');
    state = raw.state;
  }
  return {
    collectionGroup: group,
    queryScope: raw.queryScope,
    apiScope,
    fields,
    ...(state ? { state } : {}),
  };
}

function canonicalManifest(bytes: Uint8Array): ManifestSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('invalid');
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['indexes', 'fieldOverrides']))
    throw new Error('invalid');
  if (!Array.isArray(parsed.indexes) || !Array.isArray(parsed.fieldOverrides))
    throw new Error('invalid');
  if (parsed.indexes.length > 1_000 || parsed.fieldOverrides.length > 1_000)
    throw new Error('invalid');
  const indexes = parsed.indexes.map((value) => canonicalIndex(value, true));
  const fieldOverrides = parsed.fieldOverrides.map((value): CanonicalOverride => {
    if (!isRecord(value) || !hasOnlyKeys(value, ['collectionGroup', 'fieldPath', 'indexes']))
      throw new Error('invalid');
    if (!Array.isArray(value.indexes) || value.indexes.length !== 0) throw new Error('invalid');
    const fieldPath = requiredString(value.fieldPath);
    if (fieldPath.length > 1_500) throw new Error('invalid');
    return { collectionGroup: collectionGroup(value.collectionGroup), fieldPath };
  });
  const indexKeys = indexes.map(indexIdentity);
  const overrideKeys = fieldOverrides.map(overrideIdentity);
  if (
    new Set(indexKeys).size !== indexKeys.length ||
    new Set(overrideKeys).size !== overrideKeys.length
  )
    throw new Error('invalid');
  const groups = new Set([
    ...indexes.map((index) => index.collectionGroup),
    ...fieldOverrides.map((field) => field.collectionGroup),
  ]);
  if (groups.size === 0 || groups.size > MAX_GROUPS) throw new Error('invalid');
  return { indexes, fieldOverrides };
}

function indexIdentity(index: CanonicalIndex): string {
  return JSON.stringify([index.collectionGroup, index.queryScope, index.apiScope, index.fields]);
}

function overrideIdentity(field: CanonicalOverride): string {
  return JSON.stringify([field.collectionGroup, field.fieldPath]);
}

function baseReport(
  parity: OwnerEditorIndexObservationReport['scopedIndexParity'],
  manifestSha256: string | null,
  diagnostic?: OwnerEditorIndexObservationDiagnostic,
  counts?: Partial<OwnerEditorIndexObservationReport['counts']>,
): OwnerEditorIndexObservationReport {
  return {
    schemaVersion: 'owner-editor-index-observation/v1',
    scopedIndexParity: parity,
    manifestSha256,
    counts: {
      expectedCompositeIndexes: counts?.expectedCompositeIndexes ?? 0,
      observedCompositeIndexes: counts?.observedCompositeIndexes ?? 0,
      expectedFieldOverrides: counts?.expectedFieldOverrides ?? 0,
      observedFieldOverrides: counts?.observedFieldOverrides ?? 0,
      collectionGroups: counts?.collectionGroups ?? 0,
    },
    diagnostics: diagnostic ? [diagnostic] : [],
    globalIndexReadiness: 'unsupported_incomplete_field_inventory',
  };
}

function validTarget(project: string, database: string): boolean {
  return (
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) &&
    (database === '(default)' || /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(database)) &&
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(database)
  );
}

function endpoint(project: string, database: string, group: string, kind: 'indexes' | 'fields') {
  return new URL(
    `/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(database)}/collectionGroups/${encodeURIComponent(group)}/${kind}`,
    FIRESTORE_API_ORIGIN,
  );
}

async function listGroup(
  client: ReadOnlyJsonClient,
  project: string,
  database: string,
  group: string,
  kind: 'indexes' | 'fields',
): Promise<unknown[]> {
  const results: unknown[] = [];
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_GROUP; page++) {
    const url = endpoint(project, database, group, kind);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (kind === 'fields') url.searchParams.set('filter', FIELD_FILTER);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let response: unknown;
    try {
      response = await client.get(url);
    } catch {
      throw new ObservationFailure('observation_failed');
    }
    if (!isRecord(response) || !hasOnlyKeys(response, [kind, 'nextPageToken']))
      throw new ObservationFailure('observation_failed');
    // Proto3 JSON omits empty repeated fields; an explicit null is not a list.
    // https://protobuf.dev/programming-guides/json/#presence-and-default-values
    const rawRows = response[kind];
    const rows = rawRows === undefined ? [] : rawRows;
    if (
      !Array.isArray(rows) ||
      rows.length > PAGE_SIZE ||
      results.length + rows.length > MAX_RESULTS_PER_GROUP
    )
      throw new ObservationFailure('observation_failed');
    results.push(...rows);
    const next = response.nextPageToken;
    if (next === undefined || next === '') return results;
    if (typeof next !== 'string' || next.length > 2_048 || tokens.has(next))
      throw new ObservationFailure('observation_failed');
    tokens.add(next);
    pageToken = next;
  }
  throw new ObservationFailure('observation_failed');
}

function canonicalLiveOverride(
  raw: unknown,
  project: string,
  database: string,
  group: string,
): CanonicalOverride {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['name', 'indexConfig', 'ttlConfig']))
    throw new Error('invalid');
  const prefix = `projects/${project}/databases/${database}/collectionGroups/${group}/fields/`;
  const name = requiredString(raw.name);
  if (!name.startsWith(prefix)) throw new Error('invalid');
  const fieldPath = name.slice(prefix.length);
  if (!fieldPath || fieldPath.includes('/')) throw new Error('invalid');
  if (raw.ttlConfig !== undefined) throw new Error('invalid');
  const config = raw.indexConfig;
  // Field.IndexConfig is a proto3 message: empty repeated indexes and false
  // booleans may be omitted from JSON. Preserve null/type failures and reject
  // explicit true values. See
  // https://github.com/googleapis/googleapis/blob/master/google/firestore/admin/v1/field.proto.
  const configuredIndexes = isRecord(config) ? config.indexes : undefined;
  const indexes = configuredIndexes === undefined ? [] : configuredIndexes;
  const usesAncestorConfig = isRecord(config) ? config.usesAncestorConfig : undefined;
  const reverting = isRecord(config) ? config.reverting : undefined;
  if (
    !isRecord(config) ||
    !hasOnlyKeys(config, ['indexes', 'usesAncestorConfig', 'ancestorField', 'reverting']) ||
    (usesAncestorConfig !== undefined && usesAncestorConfig !== false) ||
    (reverting !== undefined && reverting !== false) ||
    !Array.isArray(indexes) ||
    indexes.length !== 0
  )
    throw new Error('invalid');
  if (config.ancestorField !== undefined) {
    // This inheritance reference is informational, but must not point outside
    // the inspected project/database; it does not expand the parity inventory.
    const ancestor = requiredString(config.ancestorField);
    const prefix = `projects/${project}/databases/${database}/collectionGroups/`;
    if (
      !ancestor.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]{1,150}\/fields\/[^/]+$/.test(ancestor.slice(prefix.length))
    )
      throw new Error('invalid');
  }
  return { collectionGroup: group, fieldPath };
}

/** Read-only parity for manifest-enumerated collection groups; never proves global field coverage. */
export async function observeOwnerEditorIndexes(
  input: {
    project: string;
    database: string;
    manifestBytes: Uint8Array;
    expectedManifestSha256: string;
  },
  client: ReadOnlyJsonClient,
): Promise<OwnerEditorIndexObservationReport> {
  if (!validTarget(input.project, input.database))
    return baseReport('unknown', null, 'target_invalid');
  if (
    !(input.manifestBytes instanceof Uint8Array) ||
    input.manifestBytes.byteLength === 0 ||
    input.manifestBytes.byteLength > MAX_MANIFEST_BYTES ||
    !/^[a-f0-9]{64}$/.test(input.expectedManifestSha256)
  )
    return baseReport('unknown', null, 'manifest_invalid');
  const manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex');
  if (manifestSha256 !== input.expectedManifestSha256)
    return baseReport('unknown', manifestSha256, 'manifest_invalid');

  let manifest: ManifestSpec;
  try {
    manifest = canonicalManifest(input.manifestBytes);
  } catch {
    return baseReport('unknown', manifestSha256, 'manifest_invalid');
  }
  const groups = [
    ...new Set([
      ...manifest.indexes.map((index) => index.collectionGroup),
      ...manifest.fieldOverrides.map((field) => field.collectionGroup),
    ]),
  ].sort();
  const counts = {
    expectedCompositeIndexes: manifest.indexes.length,
    observedCompositeIndexes: 0,
    expectedFieldOverrides: manifest.fieldOverrides.length,
    observedFieldOverrides: 0,
    collectionGroups: groups.length,
  };
  try {
    const composites: CanonicalIndex[] = [];
    const overrides: CanonicalOverride[] = [];
    for (const group of groups) {
      const [liveIndexes, liveFields] = await Promise.all([
        listGroup(client, input.project, input.database, group, 'indexes'),
        listGroup(client, input.project, input.database, group, 'fields'),
      ]);
      composites.push(
        ...liveIndexes.map((raw) =>
          canonicalIndex(raw, false, input.project, input.database, group),
        ),
      );
      overrides.push(
        ...liveFields.map((raw) =>
          canonicalLiveOverride(raw, input.project, input.database, group),
        ),
      );
      if (
        composites.length > MAX_RESULTS_PER_GROUP * groups.length ||
        overrides.length > MAX_RESULTS_PER_GROUP * groups.length
      )
        throw new ObservationFailure('observation_failed');
    }
    counts.observedCompositeIndexes = composites.length;
    counts.observedFieldOverrides = overrides.length;
    if (
      new Set(composites.map(indexIdentity)).size !== composites.length ||
      new Set(overrides.map(overrideIdentity)).size !== overrides.length
    )
      throw new ObservationFailure('scoped_parity_differs');
    const expectedIndexes = new Set(manifest.indexes.map(indexIdentity));
    const actualIndexes = new Set(composites.map(indexIdentity));
    const expectedOverrides = new Set(manifest.fieldOverrides.map(overrideIdentity));
    const actualOverrides = new Set(overrides.map(overrideIdentity));
    if (
      expectedIndexes.size !== actualIndexes.size ||
      [...expectedIndexes].some((key) => !actualIndexes.has(key)) ||
      expectedOverrides.size !== actualOverrides.size ||
      [...expectedOverrides].some((key) => !actualOverrides.has(key))
    )
      return baseReport('unknown', manifestSha256, 'scoped_parity_differs', counts);
    if (composites.some((index) => index.state !== 'READY'))
      return baseReport('not_ready', manifestSha256, 'index_build_incomplete', counts);
    return baseReport('matches', manifestSha256, undefined, counts);
  } catch (error) {
    return baseReport(
      'unknown',
      manifestSha256,
      error instanceof ObservationFailure ? error.diagnostic : 'observation_failed',
      counts,
    );
  }
}
