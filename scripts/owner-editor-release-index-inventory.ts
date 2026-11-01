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
      coverage: 'caller_asserted_complete';
      globalReadiness: 'not_established';
    }
  | {
      status: 'only_approved_owner_editor_index_missing';
      manifestSha256: string;
      compositeCount: number;
      fieldOverrideCount: number;
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

function validateInventory(composites: unknown[], overrides: unknown[]): void {
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
    if (fieldNames.has(raw.name)) fail('duplicate field override resource name');
    fieldNames.add(raw.name);

    if (raw.name === `${PREFIX}__default__/fields/*`)
      throw new DefaultFieldConfigurationUnverified();

    // The canonical verifier compares exemption identity, but not all Admin API
    // configuration. Reject any non-default behavior before delegating parity.
    const config = raw.indexConfig;
    if (!isRecord(config)) fail('field override config is unknown');
    if (
      Object.keys(config).some(
        (key) => !['usesAncestorConfig', 'reverting', 'indexes'].includes(key),
      )
    )
      fail('field override config contains unknown settings');
    if (config.usesAncestorConfig !== undefined && config.usesAncestorConfig !== false)
      fail('field override inherits an unknown ancestor config');
    if (config.reverting !== undefined && config.reverting !== false)
      fail('field override is reverting');
    if (config.indexes !== undefined && !Array.isArray(config.indexes))
      fail('field override index configuration is malformed');
    if (config.indexes !== undefined && config.indexes.length !== 0)
      fail('field override contains active indexes');
    if (raw.ttlConfig !== undefined) fail('field override has TTL configuration');
  }
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
    validateInventory(composites, overrides);
    const runner = createInventoryRunner(composites, overrides);
    try {
      await verifyConsumerIndexReadiness(runner, identity, manifest);
      return {
        status: 'exact_manifest_parity',
        manifestSha256: digest,
        compositeCount: composites.length,
        fieldOverrideCount: overrides.length,
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
      createInventoryRunner(withApproved, overrides),
      identity,
      manifest,
    );
    return {
      status: 'only_approved_owner_editor_index_missing',
      manifestSha256: digest,
      compositeCount: composites.length,
      fieldOverrideCount: overrides.length,
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
