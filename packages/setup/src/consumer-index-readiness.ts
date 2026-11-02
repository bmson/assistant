import type { InstallationIdentity } from './installation-manifest.js';
import type { CommandRunner } from './runner.js';

type IndexField = {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
  vectorConfig?: { dimension: number; flat: Record<string, never> };
};

type Index = { collectionGroup: string; queryScope: string; fields: IndexField[] };
type FieldOverride = { collectionGroup: string; fieldPath: string; indexes: unknown[] };
type IndexSpec = { indexes: Index[]; fieldOverrides: FieldOverride[] };

export class ConsumerIndexBuildingError extends Error {
  constructor(name: string) {
    super(`Firestore index ${name} is CREATING`);
  }
}

export class ConsumerIndexDefaultConfigurationUnverifiedError extends Error {
  constructor() {
    super('Firestore default field configuration is not verified');
  }
}

export interface ConsumerIndexWaitOptions {
  /** Bounded wait; a timed-out installation stays resumable at bootstrapped. */
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is malformed`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value;
}

function validDefaultAncestor(value: unknown, defaultName: string, prefix: string): boolean {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const match = /^([^/]+)\/fields\/([^/]+)$/.exec(value.slice(prefix.length));
  return match?.[1] === '__default__' && match[2] === '*' && value === defaultName;
}

function validateDefaultField(
  raw: Record<string, unknown>,
  defaultName: string,
  prefix: string,
): void {
  if (
    Object.keys(raw).some((key) => !['name', 'indexConfig', 'ttlConfig'].includes(key)) ||
    raw.name !== defaultName ||
    raw.ttlConfig !== undefined
  )
    throw new ConsumerIndexDefaultConfigurationUnverifiedError();
  const config = raw.indexConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new ConsumerIndexDefaultConfigurationUnverifiedError();
  const indexConfig = config as Record<string, unknown>;
  if (
    Object.keys(indexConfig).some(
      (key) => !['indexes', 'usesAncestorConfig', 'ancestorField', 'reverting'].includes(key),
    ) ||
    (indexConfig.usesAncestorConfig !== undefined && indexConfig.usesAncestorConfig !== false) ||
    (indexConfig.reverting !== undefined && indexConfig.reverting !== false) ||
    (indexConfig.ancestorField !== undefined &&
      !validDefaultAncestor(indexConfig.ancestorField, defaultName, prefix))
  )
    throw new ConsumerIndexDefaultConfigurationUnverifiedError();
  if (!Array.isArray(indexConfig.indexes) || indexConfig.indexes.length !== 3)
    throw new ConsumerIndexDefaultConfigurationUnverifiedError();

  const modes = new Set<string>();
  for (const rawIndex of indexConfig.indexes) {
    if (!rawIndex || typeof rawIndex !== 'object' || Array.isArray(rawIndex))
      throw new ConsumerIndexDefaultConfigurationUnverifiedError();
    const index = rawIndex as Record<string, unknown>;
    if (
      Object.keys(index).some(
        (key) => !['queryScope', 'fields', 'apiScope', 'state'].includes(key),
      ) ||
      index.queryScope !== 'COLLECTION' ||
      (index.apiScope !== undefined && index.apiScope !== 'ANY_API') ||
      index.state !== 'READY' ||
      !Array.isArray(index.fields) ||
      index.fields.length !== 1
    )
      throw new ConsumerIndexDefaultConfigurationUnverifiedError();
    const rawField = index.fields[0];
    if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField))
      throw new ConsumerIndexDefaultConfigurationUnverifiedError();
    const field = rawField as Record<string, unknown>;
    if (field.fieldPath !== '*') throw new ConsumerIndexDefaultConfigurationUnverifiedError();
    const keys = Object.keys(field).sort().join(',');
    const mode =
      keys === 'fieldPath,order' && (field.order === 'ASCENDING' || field.order === 'DESCENDING')
        ? `order:${String(field.order)}`
        : keys === 'arrayConfig,fieldPath' && field.arrayConfig === 'CONTAINS'
          ? 'array:CONTAINS'
          : null;
    if (!mode || modes.has(mode)) throw new ConsumerIndexDefaultConfigurationUnverifiedError();
    modes.add(mode);
  }
  if (
    modes.size !== 3 ||
    !modes.has('order:ASCENDING') ||
    !modes.has('order:DESCENDING') ||
    !modes.has('array:CONTAINS')
  )
    throw new ConsumerIndexDefaultConfigurationUnverifiedError();
}

/** Validate the unmanifested global sentinel before excluding it from parity or provisioning. */
export function validateFirestoreDefaultFieldConfiguration(
  rows: unknown[],
  identity: Pick<InstallationIdentity, 'projectId' | 'databaseId'>,
): unknown[] {
  const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;
  const defaultName = `${prefix}__default__/fields/*`;
  let defaultCount = 0;
  const explicit: unknown[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      explicit.push(raw);
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (record.name === defaultName) {
      defaultCount++;
      if (defaultCount !== 1) throw new ConsumerIndexDefaultConfigurationUnverifiedError();
      validateDefaultField(record, defaultName, prefix);
    } else {
      explicit.push(raw);
    }
  }
  if (defaultCount !== 1) throw new ConsumerIndexDefaultConfigurationUnverifiedError();
  return explicit;
}

function canonicalField(raw: unknown): IndexField {
  const value = object(raw, 'Firestore index field');
  const fieldPath = string(value.fieldPath, 'Firestore index field path');
  const modes = ['order', 'arrayConfig', 'vectorConfig'].filter((key) => value[key] !== undefined);
  if (modes.length !== 1) throw new Error(`Firestore index field ${fieldPath} has invalid mode`);
  if (value.order !== undefined) {
    if (value.order !== 'ASCENDING' && value.order !== 'DESCENDING')
      throw new Error(`Firestore index field ${fieldPath} has invalid order`);
    return { fieldPath, order: value.order };
  }
  if (value.arrayConfig !== undefined) {
    if (value.arrayConfig !== 'CONTAINS')
      throw new Error(`Firestore index field ${fieldPath} has invalid array mode`);
    return { fieldPath, arrayConfig: value.arrayConfig };
  }
  const vector = object(value.vectorConfig, `Firestore index field ${fieldPath} vector`);
  if (!Number.isSafeInteger(vector.dimension) || (vector.dimension as number) <= 0)
    throw new Error(`Firestore index field ${fieldPath} has invalid vector dimension`);
  const flat = object(vector.flat, `Firestore index field ${fieldPath} flat vector`);
  if (Object.keys(flat).length !== 0)
    throw new Error(`Firestore index field ${fieldPath} has unknown flat vector settings`);
  return { fieldPath, vectorConfig: { dimension: vector.dimension as number, flat: {} } };
}

function canonicalIndex(
  raw: unknown,
  prefix: string,
  trusted: boolean,
  requireReady = true,
): Index {
  const value = object(raw, 'Firestore composite index');
  let collectionGroup: string;
  if (trusted) {
    collectionGroup = string(value.collectionGroup, 'Trusted index collection group');
  } else {
    const name = string(value.name, 'Firestore composite index name');
    if (!name.startsWith(prefix)) throw new Error(`Foreign Firestore index ${name}`);
    const suffix = name.slice(prefix.length);
    const match = /^([^/]+)\/indexes\/([^/]+)$/.exec(suffix);
    if (!match?.[1] || !match[2]) throw new Error(`Ambiguous Firestore index name ${name}`);
    collectionGroup = match[1];
    if (requireReady && value.state !== 'READY')
      throw new Error(`Firestore index ${name} is ${String(value.state ?? 'not READY')}`);
  }
  const queryScope = string(value.queryScope, 'Firestore index query scope');
  if (queryScope !== 'COLLECTION' && queryScope !== 'COLLECTION_GROUP')
    throw new Error('Firestore index query scope is invalid');
  const fields = array(value.fields, 'Firestore index fields').map(canonicalField);
  if (fields.length < 2) throw new Error('Firestore composite index has too few fields');
  if (trusted) {
    const ordinaryFields = fields.filter((field) => field.fieldPath !== '__name__');
    if (ordinaryFields.length === 1 && ordinaryFields[0]?.order)
      throw new Error('Trusted composite index duplicates an automatic single-field index');
    const documentNamePosition = fields.findIndex((field) => field.fieldPath === '__name__');
    if (documentNamePosition >= 0) {
      if (documentNamePosition !== fields.length - 1)
        throw new Error('Trusted index document-name field must be last');
      const precedingOrder = fields.at(-2)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING';
      if (fields.at(-1)?.order !== precedingOrder)
        throw new Error('Trusted index document-name order must match the preceding field order');
    } else {
      const last = fields.at(-1);
      fields.push({
        fieldPath: '__name__',
        order: last?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
      });
    }
  } else {
    // Firestore lists the implicit document-name field immediately before the
    // terminal vector field. The manifest describes the same index without that
    // implicit field, so canonicalize it to the end used by trusted definitions.
    const vectorPosition = fields.findIndex((field) => field.vectorConfig !== undefined);
    if (
      vectorPosition === fields.length - 1 &&
      fields[vectorPosition - 1]?.fieldPath === '__name__'
    ) {
      const [documentName] = fields.splice(vectorPosition - 1, 1);
      if (documentName) fields.push(documentName);
    }
  }
  return { collectionGroup, queryScope, fields };
}

/** Add only missing shared-manifest indexes and exemptions to an existing database. */
export async function provisionTargetFirestoreIndexes(
  runner: CommandRunner,
  identity: InstallationIdentity,
  verifiedSpec: Buffer,
): Promise<{ indexesCreated: number; exemptionsCreated: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedSpec.toString('utf8'));
  } catch {
    throw new Error('Trusted Firestore index manifest is invalid JSON');
  }
  const spec = object(parsed, 'Trusted Firestore index manifest') as IndexSpec;
  const expectedIndexes = array(spec.indexes, 'Trusted Firestore indexes').map((index) =>
    canonicalIndex(index, '', true),
  );
  const expectedFields = array(spec.fieldOverrides, 'Trusted Firestore field overrides').map(
    (raw) => {
      const field = object(raw, 'Trusted Firestore field override');
      if (array(field.indexes, 'Trusted Firestore field indexes').length !== 0)
        throw new Error('Trusted Firestore field override contains unsupported indexes');
      return {
        collectionGroup: string(field.collectionGroup, 'Trusted field collection group'),
        fieldPath: string(field.fieldPath, 'Trusted field path'),
      };
    },
  );
  const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;
  const flags = [
    `--project=${identity.projectId}`,
    `--database=${identity.databaseId}`,
    '--format=json',
  ];
  const [composites, overrides] = await Promise.all([
    list(runner, ['firestore', 'indexes', 'composite', 'list', ...flags], 'Composite indexes'),
    list(runner, ['firestore', 'indexes', 'fields', 'list', ...flags], 'Field overrides'),
  ]);
  const explicitOverrides = validateFirestoreDefaultFieldConfiguration(overrides, identity);
  const existingIndexes = new Set(
    composites.map((index) => indexKey(canonicalIndex(index, prefix, false, false))),
  );
  let indexesCreated = 0;
  for (const index of expectedIndexes) {
    if (existingIndexes.has(indexKey(index))) continue;
    const args = [
      'firestore',
      'indexes',
      'composite',
      'create',
      `--collection-group=${index.collectionGroup}`,
      `--database=${identity.databaseId}`,
      `--project=${identity.projectId}`,
      `--query-scope=${index.queryScope === 'COLLECTION_GROUP' ? 'collection-group' : 'collection'}`,
      '--async',
      '--quiet',
    ];
    for (const field of index.fields.filter((field) => field.fieldPath !== '__name__')) {
      const config = [`field-path=${field.fieldPath}`];
      if (field.order) config.push(`order=${field.order.toLowerCase()}`);
      if (field.arrayConfig) config.push(`array-config=${field.arrayConfig.toLowerCase()}`);
      // gcloud 586+ only accepts the JSON form documented for vector indexes.
      if (field.vectorConfig)
        config.push(`vector-config={"dimension":"${field.vectorConfig.dimension}","flat":"{}"}`);
      args.push(`--field-config=${config.join(',')}`);
    }
    const result = await runner.run('gcloud', args);
    if (!result.ok)
      throw new Error(
        `Firestore index create failed for ${index.collectionGroup}: ${result.stderr || 'unknown error'}`,
      );
    indexesCreated++;
  }
  // Existing non-manifest resources are intentionally left untouched. The exact verifier
  // will report them, keeping this tool from taking destructive ownership of the database.
  const existingFieldKeys = new Set<string>();
  for (const raw of explicitOverrides) {
    const field = object(raw, 'Firestore field override');
    const name = string(field.name, 'Firestore field name');
    if (!name.startsWith(prefix)) throw new Error(`Foreign Firestore field override ${name}`);
    const match = /^([^/]+)\/fields\/([^/]+)$/.exec(name.slice(prefix.length));
    if (!match?.[1] || !match[2]) throw new Error(`Ambiguous Firestore field override ${name}`);
    existingFieldKeys.add(fieldKey(match[1], match[2]));
  }
  let exemptionsCreated = 0;
  for (const field of expectedFields) {
    if (existingFieldKeys.has(fieldKey(field.collectionGroup, field.fieldPath))) continue;
    const result = await runner.run('gcloud', [
      'firestore',
      'indexes',
      'fields',
      'update',
      field.fieldPath,
      `--collection-group=${field.collectionGroup}`,
      `--database=${identity.databaseId}`,
      `--project=${identity.projectId}`,
      '--disable-indexes',
      '--async',
      '--quiet',
    ]);
    if (!result.ok)
      throw new Error(
        `Firestore field exemption failed for ${field.collectionGroup}/${field.fieldPath}: ${result.stderr || 'unknown error'}`,
      );
    exemptionsCreated++;
  }
  return { indexesCreated, exemptionsCreated };
}

function indexKey(index: Index): string {
  return JSON.stringify([index.collectionGroup, index.queryScope, index.fields]);
}

function fieldKey(collectionGroup: string, fieldPath: string): string {
  return JSON.stringify([collectionGroup, fieldPath]);
}

function exactlyExpected(expected: string[], actual: string[], kind: string): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length || actualSet.size !== actual.length)
    throw new Error(`Duplicate ${kind} identity`);
  if (expectedSet.size !== actualSet.size || expected.some((key) => !actualSet.has(key)))
    throw new Error(`${kind} differ from the trusted installation manifest`);
}

async function list(runner: CommandRunner, args: string[], label: string): Promise<unknown[]> {
  const result = await runner.run('gcloud', args);
  if (!result.ok) throw new Error(`${label} read failed: ${result.stderr || 'unknown error'}`);
  try {
    return array(JSON.parse(result.stdout), `${label} response`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} returned invalid JSON`);
    throw error;
  }
}

/** Read only: do not persist `provisioned` until every trusted index is READY. */
export async function verifyConsumerIndexReadiness(
  runner: CommandRunner,
  identity: InstallationIdentity,
  verifiedSpec: Buffer,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedSpec.toString('utf8'));
  } catch {
    throw new Error('Trusted Firestore index manifest is invalid JSON');
  }
  const spec = object(parsed, 'Trusted Firestore index manifest') as IndexSpec;
  const expectedIndexes = array(spec.indexes, 'Trusted Firestore indexes').map((index) =>
    canonicalIndex(index, '', true),
  );
  const expectedFields = array(spec.fieldOverrides, 'Trusted Firestore field overrides').map(
    (raw) => {
      const field = object(raw, 'Trusted Firestore field override');
      if (array(field.indexes, 'Trusted Firestore field indexes').length !== 0)
        throw new Error('Trusted Firestore field override contains unsupported indexes');
      return fieldKey(
        string(field.collectionGroup, 'Trusted field collection group'),
        string(field.fieldPath, 'Trusted field path'),
      );
    },
  );
  const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;
  const flags = [
    `--project=${identity.projectId}`,
    `--database=${identity.databaseId}`,
    '--format=json',
  ];
  const [composites, overrides] = await Promise.all([
    list(runner, ['firestore', 'indexes', 'composite', 'list', ...flags], 'Composite indexes'),
    list(runner, ['firestore', 'indexes', 'fields', 'list', ...flags], 'Field overrides'),
  ]);
  const explicitOverrides = validateFirestoreDefaultFieldConfiguration(overrides, identity);
  // Check every definition before waiting on a build. A foreign or changed
  // index must fail immediately even if a different index is still CREATING.
  exactlyExpected(
    expectedIndexes.map(indexKey),
    composites.map((index) => indexKey(canonicalIndex(index, prefix, false, false))),
    'Firestore composite indexes',
  );
  const actualFields = explicitOverrides.flatMap((raw) => {
    const field = object(raw, 'Firestore field override');
    const name = string(field.name, 'Firestore field name');
    if (!name.startsWith(prefix)) throw new Error(`Foreign Firestore field override ${name}`);
    const match = /^([^/]+)\/fields\/([^/]+)$/.exec(name.slice(prefix.length));
    if (!match?.[1] || !match[2]) throw new Error(`Ambiguous Firestore field override ${name}`);
    const indexConfig = object(field.indexConfig, `Firestore field override ${name} config`);
    if (
      (indexConfig.usesAncestorConfig !== undefined && indexConfig.usesAncestorConfig !== false) ||
      (indexConfig.reverting !== undefined && indexConfig.reverting !== false) ||
      (indexConfig.indexes !== undefined &&
        array(indexConfig.indexes, `Firestore field override ${name} indexes`).length !== 0) ||
      field.ttlConfig !== undefined
    )
      throw new Error(`Firestore field override ${name} is not an active exemption`);
    return [fieldKey(match[1], match[2])];
  });
  exactlyExpected(expectedFields, actualFields, 'Firestore field overrides');
  for (const raw of composites) {
    const index = object(raw, 'Firestore composite index');
    const name = string(index.name, 'Firestore composite index name');
    if (index.state === 'CREATING') throw new ConsumerIndexBuildingError(name);
    if (index.state !== 'READY')
      throw new Error(`Firestore index ${name} is ${String(index.state ?? 'not READY')}`);
  }
}

/** Wait for expected new indexes only; never retry drift, malformed data, or read failures. */
export async function waitForConsumerIndexReadiness(
  runner: CommandRunner,
  identity: InstallationIdentity,
  verifiedSpec: Buffer,
  options: ConsumerIndexWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const intervalMs = options.intervalMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    throw new Error('Index readiness timeout must be a nonnegative integer');
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    throw new Error('Index readiness interval must be a positive integer');
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      await verifyConsumerIndexReadiness(runner, identity, verifiedSpec);
      return;
    } catch (error) {
      if (!(error instanceof ConsumerIndexBuildingError)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0)
        throw new Error(
          `Firestore indexes did not become READY within ${timeoutMs}ms; ${error.message}`,
        );
      await sleep(Math.min(intervalMs, remaining));
    }
  }
}
