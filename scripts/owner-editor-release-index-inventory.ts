import { createHash } from 'node:crypto';
import { verifyConsumerIndexReadiness } from '../packages/setup/src/consumer-index-readiness.js';
import type { InstallationIdentity } from '../packages/setup/src/installation-manifest.js';
import type { CommandResult, CommandRunner } from '../packages/setup/src/runner.js';

export const OWNER_EDITOR_RELEASE_MANIFEST_SHA256 =
  '5baaca10aa089b2eac771de7c9086317206bd937d09a89ea6e937ac945e03cd1';
const PROJECT_ID = 'bmson-assistant';
const DATABASE_ID = 'assistant-production';
const PREFIX = `projects/${PROJECT_ID}/databases/${DATABASE_ID}/collectionGroups/`;
const OWNER_EDITOR_GROUP = 'ownerEditorOperations';
const MAX_INVENTORY_ROWS = 10_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const OWNER_EDITOR_INDEX = {
  collectionGroup: OWNER_EDITOR_GROUP,
  queryScope: 'COLLECTION',
  fields: [
    { fieldPath: 'ownerId', order: 'ASCENDING' },
    { fieldPath: 'formIssuedAt', order: 'ASCENDING' },
    { fieldPath: 'id', order: 'ASCENDING' },
  ],
} as const;

export interface IndexInventoryCoverage {
  /** Trusted caller evidence that every composite index page was collected. */
  compositesComplete: boolean;
  /** Trusted caller evidence that every field override page was collected. */
  fieldsComplete: boolean;
}

export type OwnerEditorIndexInventoryResult =
  | {
      status: 'exact_manifest_parity';
      manifestSha256: string;
      compositeCount: number;
      fieldOverrideCount: number;
      explicitFieldOverrideCount: number;
      coverage: 'caller_asserted_complete';
      globalReadiness: 'not_established';
    }
  | {
      status: 'only_approved_owner_editor_index_missing';
      manifestSha256: string;
      compositeCount: number;
      fieldOverrideCount: number;
      explicitFieldOverrideCount: number;
      missingIndex: typeof OWNER_EDITOR_INDEX;
      coverage: 'caller_asserted_complete';
      globalReadiness: 'not_established';
    }
  | {
      status: 'unknown';
      manifestSha256: string | null;
      compositeCount: number | null;
      fieldOverrideCount: number | null;
      reason:
        | 'manifest_not_pinned'
        | 'inventory_incomplete'
        | 'malformed_inventory'
        | 'default_configuration_unverified'
        | 'inventory_not_exact';
      coverage: 'not_proven';
      globalReadiness: 'not_established';
    };

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

class DefaultFieldConfigurationUnverified extends Error {}

function validAncestorField(value: unknown, currentName: string): boolean {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return false;
  const ancestor = /^([^/]+)\/fields\/([^/]+)$/.exec(value.slice(PREFIX.length));
  const current = /^([^/]+)\/fields\/([^/]+)$/.exec(currentName.slice(PREFIX.length));
  if (!ancestor?.[1] || !ancestor[2] || !current?.[1] || !current[2]) return false;
  return ancestor[1] === '__default__'
    ? ancestor[2] === '*'
    : ancestor[1] === current[1] && ancestor[2] === '*';
}

function validateDefaultField(raw: Record<string, unknown>): void {
  if (raw.ttlConfig !== undefined) throw new DefaultFieldConfigurationUnverified();
  const config = raw.indexConfig;
  if (!isRecord(config)) throw new DefaultFieldConfigurationUnverified();
  if (
    Object.keys(config).some(
      (key) => !['usesAncestorConfig', 'ancestorField', 'reverting', 'indexes'].includes(key),
    ) ||
    config.usesAncestorConfig === true ||
    (config.usesAncestorConfig !== undefined && config.usesAncestorConfig !== false) ||
    config.reverting === true ||
    (config.reverting !== undefined && config.reverting !== false) ||
    (config.ancestorField !== undefined &&
      !validAncestorField(config.ancestorField, raw.name as string))
  )
    throw new DefaultFieldConfigurationUnverified();
  if (!Array.isArray(config.indexes) || config.indexes.length !== 3)
    throw new DefaultFieldConfigurationUnverified();

  const modes = new Set<string>();
  for (const index of config.indexes) {
    if (!isRecord(index)) throw new DefaultFieldConfigurationUnverified();
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
      throw new DefaultFieldConfigurationUnverified();
    const field = index.fields[0];
    if (!isRecord(field) || field.fieldPath !== '*')
      throw new DefaultFieldConfigurationUnverified();
    const keys = Object.keys(field).sort().join(',');
    const mode =
      keys === 'fieldPath,order' && (field.order === 'ASCENDING' || field.order === 'DESCENDING')
        ? `order:${String(field.order)}`
        : keys === 'arrayConfig,fieldPath' && field.arrayConfig === 'CONTAINS'
          ? 'array:CONTAINS'
          : null;
    if (!mode || modes.has(mode)) throw new DefaultFieldConfigurationUnverified();
    modes.add(mode);
  }
  if (
    modes.size !== 3 ||
    !modes.has('order:ASCENDING') ||
    !modes.has('order:DESCENDING') ||
    !modes.has('array:CONTAINS')
  )
    throw new DefaultFieldConfigurationUnverified();
}

function validateInventory(composites: unknown[], overrides: unknown[]): unknown[] {
  if (composites.length > MAX_INVENTORY_ROWS || overrides.length > MAX_INVENTORY_ROWS)
    fail('inventory row limit exceeded');

  const resourceNames = new Set<string>();
  for (const raw of composites) {
    if (!isRecord(raw)) fail('composite row is malformed');
    if (typeof raw.name !== 'string' || !raw.name.startsWith(PREFIX))
      fail('composite resource is outside the pinned database');
    if (
      !/^projects\/bmson-assistant\/databases\/assistant-production\/collectionGroups\/[^/]+\/indexes\/[^/]+$/.test(
        raw.name,
      )
    )
      fail('composite resource name is malformed');
    if (resourceNames.has(raw.name)) fail('duplicate composite resource name');
    resourceNames.add(raw.name);
    // The pinned manifest omits apiScope, whose Firestore default is ANY_API.
    // Other known scopes are valid API values, but they are not equivalent to
    // the manifest's default and therefore cannot establish parity.
    if (raw.apiScope !== undefined && raw.apiScope !== 'ANY_API')
      fail('composite API scope differs from the manifest default');
  }

  const fieldNames = new Set<string>();
  let defaultConfigurationSeen = false;
  const explicitOverrides: unknown[] = [];
  for (const raw of overrides) {
    if (!isRecord(raw) || typeof raw.name !== 'string') fail('field override row is malformed');
    if (raw.name !== `${PREFIX}__default__/fields/*` && !raw.name.startsWith(PREFIX))
      fail('field override is outside the pinned database');
    if (
      raw.name !== `${PREFIX}__default__/fields/*` &&
      !/^projects\/bmson-assistant\/databases\/assistant-production\/collectionGroups\/[^/]+\/fields\/[^/]+$/.test(
        raw.name,
      )
    )
      fail('field override resource name is malformed');
    if (Object.keys(raw).some((key) => !['name', 'indexConfig', 'ttlConfig'].includes(key))) {
      if (raw.name === `${PREFIX}__default__/fields/*`)
        throw new DefaultFieldConfigurationUnverified();
      fail('field override contains unknown resource settings');
    }
    if (fieldNames.has(raw.name)) {
      if (raw.name === `${PREFIX}__default__/fields/*`)
        throw new DefaultFieldConfigurationUnverified();
      fail('duplicate field override resource name');
    }
    fieldNames.add(raw.name);

    if (raw.name === `${PREFIX}__default__/fields/*`) {
      if (defaultConfigurationSeen) throw new DefaultFieldConfigurationUnverified();
      defaultConfigurationSeen = true;
      validateDefaultField(raw);
      continue;
    }

    // The canonical verifier compares exemption identity, but not all Admin API
    // configuration. Reject any non-default behavior before delegating parity.
    const config = raw.indexConfig;
    if (!isRecord(config)) fail('field override config is unknown');
    if (
      Object.keys(config).some(
        (key) => !['usesAncestorConfig', 'ancestorField', 'reverting', 'indexes'].includes(key),
      )
    )
      fail('field override config contains unknown settings');
    if (config.usesAncestorConfig !== undefined && config.usesAncestorConfig !== false)
      fail('field override inherits an unknown ancestor config');
    if (config.reverting !== undefined && config.reverting !== false)
      fail('field override is reverting');
    if (config.ancestorField !== undefined && !validAncestorField(config.ancestorField, raw.name))
      fail('field override ancestor is outside the pinned canonical hierarchy');
    if (config.indexes !== undefined && !Array.isArray(config.indexes))
      fail('field override index configuration is malformed');
    if (config.indexes !== undefined && config.indexes.length !== 0)
      fail('field override contains active indexes');
    if (raw.ttlConfig !== undefined) fail('field override has TTL configuration');
    explicitOverrides.push(raw);
  }
  if (!defaultConfigurationSeen) throw new DefaultFieldConfigurationUnverified();
  return explicitOverrides;
}

function createInventoryRunner(composites: unknown[], overrides: unknown[]): CommandRunner {
  let compositeReads = 0;
  let fieldReads = 0;
  return {
    async run(command: string, args: readonly string[]): Promise<CommandResult> {
      if (command !== 'gcloud') return { ok: false, stdout: '', stderr: 'unexpected command' };
      const expectedArgs = [
        'firestore',
        'indexes',
        args[2],
        'list',
        `--project=${PROJECT_ID}`,
        `--database=${DATABASE_ID}`,
        '--format=json',
      ];
      if (
        args.length !== 7 ||
        (args[2] !== 'composite' && args[2] !== 'fields') ||
        expectedArgs.some((argument, index) => args[index] !== argument)
      )
        return { ok: false, stdout: '', stderr: 'unexpected target' };
      if (args.slice(0, 4).join(' ') === 'firestore indexes composite list') {
        compositeReads++;
        return compositeReads === 1
          ? { ok: true, stdout: JSON.stringify(composites), stderr: '' }
          : { ok: false, stdout: '', stderr: 'duplicate inventory read' };
      }
      if (args.slice(0, 4).join(' ') === 'firestore indexes fields list') {
        fieldReads++;
        return fieldReads === 1
          ? { ok: true, stdout: JSON.stringify(overrides), stderr: '' }
          : { ok: false, stdout: '', stderr: 'duplicate inventory read' };
      }
      return { ok: false, stdout: '', stderr: 'unexpected command arguments' };
    },
  };
}

const identity: InstallationIdentity = {
  installationId: 'release-index-audit',
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  region: 'us-west1',
  release: { commitSha: '0'.repeat(40), archiveDigest: `sha256:${'0'.repeat(64)}` },
};

/**
 * Compare a caller-collected complete target-database inventory to the byte-pinned
 * release manifest. This is read-only and never establishes global Firestore readiness.
 */
export async function compareIndexInventory(
  manifest: Buffer,
  composites: unknown[],
  overrides: unknown[],
  coverage: IndexInventoryCoverage,
): Promise<OwnerEditorIndexInventoryResult> {
  const digest = sha256(manifest);
  if (manifest.length > MAX_MANIFEST_BYTES || digest !== OWNER_EDITOR_RELEASE_MANIFEST_SHA256)
    return {
      status: 'unknown',
      manifestSha256: digest,
      compositeCount: null,
      fieldOverrideCount: null,
      reason: 'manifest_not_pinned',
      coverage: 'not_proven',
      globalReadiness: 'not_established',
    };
  if (!Array.isArray(composites) || !Array.isArray(overrides))
    return {
      status: 'unknown',
      manifestSha256: digest,
      compositeCount: null,
      fieldOverrideCount: null,
      reason: 'malformed_inventory',
      coverage: 'not_proven',
      globalReadiness: 'not_established',
    };
  if (coverage.compositesComplete !== true || coverage.fieldsComplete !== true)
    return {
      status: 'unknown',
      manifestSha256: digest,
      compositeCount: composites.length,
      fieldOverrideCount: overrides.length,
      reason: 'inventory_incomplete',
      coverage: 'not_proven',
      globalReadiness: 'not_established',
    };
  try {
    const explicitOverrides = validateInventory(composites, overrides);
    const runner = createInventoryRunner(composites, explicitOverrides);
    try {
      await verifyConsumerIndexReadiness(runner, identity, manifest);
      return {
        status: 'exact_manifest_parity',
        manifestSha256: digest,
        compositeCount: composites.length,
        fieldOverrideCount: overrides.length,
        explicitFieldOverrideCount: explicitOverrides.length,
        coverage: 'caller_asserted_complete',
        globalReadiness: 'not_established',
      };
    } catch {
      // Classify a create-plan candidate only by asking the canonical verifier
      // to validate the exact same inventory with the one approved row present.
    }

    const expectedName = `${PREFIX}${OWNER_EDITOR_GROUP}/indexes/release-approved`;
    const withApproved = [
      ...composites,
      {
        name: expectedName,
        state: 'READY',
        ...OWNER_EDITOR_INDEX,
        fields: [...OWNER_EDITOR_INDEX.fields, { fieldPath: '__name__', order: 'ASCENDING' }],
      },
    ];
    await verifyConsumerIndexReadiness(
      createInventoryRunner(withApproved, explicitOverrides),
      identity,
      manifest,
    );
    return {
      status: 'only_approved_owner_editor_index_missing',
      manifestSha256: digest,
      compositeCount: composites.length,
      fieldOverrideCount: overrides.length,
      explicitFieldOverrideCount: explicitOverrides.length,
      missingIndex: OWNER_EDITOR_INDEX,
      coverage: 'caller_asserted_complete',
      globalReadiness: 'not_established',
    };
  } catch (error) {
    return {
      status: 'unknown',
      manifestSha256: digest,
      compositeCount: composites.length,
      fieldOverrideCount: overrides.length,
      reason:
        error instanceof DefaultFieldConfigurationUnverified
          ? 'default_configuration_unverified'
          : 'inventory_not_exact',
      coverage: 'not_proven',
      globalReadiness: 'not_established',
    };
  }
}
