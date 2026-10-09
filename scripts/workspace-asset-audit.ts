import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  type MigrationBundle,
  type MigrationTable,
  validateMigrationBundle,
} from '../packages/persistence/src/migration.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

export type AssetObjectVersion = {
  name: string;
  generation: string;
  size: number;
  crc32c?: string;
  timeDeleted?: string;
};

export type AssetReference = {
  table: 'email_attachment_custodies' | 'files' | 'import_sources';
  id: string;
  path: string;
  lifecycleStatus: string;
  expectedBytes?: number;
  expectedSha256?: string;
};

export type AssetAuditResult = {
  references: number;
  referencesByTable: Record<AssetReference['table'], number>;
  expectedSizeReferences: number;
  expectedDigestReferences: number;
  currentObjects: number;
  generationChecked: number;
  missingObjects: number;
  missingByLifecycleStatus: Record<string, number>;
  missingByTableAndLifecycleStatus: Record<string, Record<string, number>>;
  historicalOnlyObjects: number;
  sizeCompared: number;
  sizeMismatches: number;
  digestChecked: number;
  digestUnverifiable: number;
  digestMismatches: number;
  objectGenerationsListed: number;
};

export type AssetAuditStorage = {
  list(prefix: string): Promise<AssetObjectVersion[]>;
  sha256(name: string, generation: string): Promise<string>;
};

/** Every database field whose value is a direct path beneath the installation workspace prefix. */
export const ASSET_REFERENCE_FIELDS: ReadonlyArray<{
  table: MigrationTable;
  field: 'workspacePath';
}> = [
  { table: 'files', field: 'workspacePath' },
  { table: 'email_attachment_custodies', field: 'workspacePath' },
  { table: 'import_sources', field: 'workspacePath' },
];

const TASK_LIFECYCLE_STATUSES = new Set([
  'pending',
  'running',
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'done',
  'failed',
  'needs_attention',
  'cancelled',
]);
const IMPORT_LIFECYCLE_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'purged']);
const EMAIL_ATTACHMENT_CUSTODY_LIFECYCLE_STATUSES = new Set([
  'marker_pending',
  'marker_ready',
  'content_authorized',
  'object_written',
  'catalogued',
  'cleanup_pending',
  'duplicate_cleaned',
  'erased',
]);

function normalizeLifecycleStatus(
  table: AssetReference['table'],
  status: string | undefined,
): string {
  if (!status) return 'unknown';
  if (table === 'import_sources') return IMPORT_LIFECYCLE_STATUSES.has(status) ? status : 'unknown';
  if (table === 'email_attachment_custodies')
    return EMAIL_ATTACHMENT_CUSTODY_LIFECYCLE_STATUSES.has(status) ? status : 'unknown';
  return TASK_LIFECYCLE_STATUSES.has(status) ? status : 'unknown';
}

function decodedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function migrationAssetReferences(
  bundle: MigrationBundle,
  options: { requireVersion3?: boolean } = {},
): AssetReference[] {
  if (options.requireVersion3 !== false && bundle.manifest.formatVersion !== 3)
    throw new Error('Workspace asset audit requires a version 3 migration bundle');
  const references: AssetReference[] = [];
  const taskStatuses = new Map(
    bundle.records
      .filter((record) => record.table === 'tasks')
      .map((record) => [
        record.id,
        normalizeLifecycleStatus('files', decodedString(record.data.status)),
      ]),
  );
  for (const record of bundle.records) {
    const assetField = ASSET_REFERENCE_FIELDS.find((candidate) => candidate.table === record.table);
    if (!assetField) continue;
    const path = decodedString(record.data[assetField.field]);
    if (path === undefined) throw new Error(`Invalid ${record.table} ${assetField.field}`);
    const normalized = normalizeWorkspacePath(path);
    if (!normalized || normalized === '.' || normalized.startsWith('..'))
      throw new Error(`Unsafe ${record.table} workspacePath`);
    const rawBytes =
      record.table === 'files'
        ? record.data.bytes
        : record.table === 'email_attachment_custodies'
          ? (record.data.actualBytes ?? undefined)
          : undefined;
    const bigintValue =
      rawBytes &&
      typeof rawBytes === 'object' &&
      !Array.isArray(rawBytes) &&
      '$assistantMigration' in rawBytes &&
      Array.isArray(rawBytes.$assistantMigration) &&
      rawBytes.$assistantMigration[0] === 'bigint'
        ? rawBytes.$assistantMigration[1]
        : undefined;
    const expectedBytes =
      typeof rawBytes === 'number'
        ? rawBytes
        : options.requireVersion3 === false &&
            typeof rawBytes === 'string' &&
            /^\d+$/.test(rawBytes)
          ? Number(rawBytes)
          : typeof bigintValue === 'string' && /^\d+$/.test(bigintValue)
            ? Number(bigintValue)
            : undefined;
    if (rawBytes !== undefined && expectedBytes === undefined)
      throw new Error(`Invalid ${record.table} byte count`);
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0))
      throw new Error(`Invalid ${record.table} byte count`);
    const rawSha =
      record.table === 'files' || record.table === 'email_attachment_custodies'
        ? record.data.sha256
        : undefined;
    const expectedSha256 =
      typeof rawSha === 'string' && rawSha.length > 0 ? rawSha.toLowerCase() : undefined;
    if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256))
      throw new Error('Invalid file SHA-256 in migration bundle');
    const recordLifecycleStatus =
      record.table === 'import_sources'
        ? normalizeLifecycleStatus('import_sources', decodedString(record.data.status))
        : record.table === 'email_attachment_custodies'
          ? normalizeLifecycleStatus(
              'email_attachment_custodies',
              decodedString(record.data.status),
            )
          : decodedString(record.data.taskId)
            ? (taskStatuses.get(decodedString(record.data.taskId) as string) ?? 'task-unavailable')
            : 'unlinked';
    references.push({
      table: assetField.table as AssetReference['table'],
      id: record.id,
      path: normalized,
      lifecycleStatus: recordLifecycleStatus,
      expectedBytes,
      expectedSha256,
    });
  }
  return references;
}

function normalizeWorkspacePath(value: string): string {
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\/+/, '');
}

/** Read-only comparison of bundle references with current and retained GCS object versions. */
export async function auditWorkspaceAssets(
  bundle: MigrationBundle,
  storage: AssetAuditStorage,
  options: { verifyDigests?: boolean } = {},
): Promise<AssetAuditResult> {
  const installationId = bundle.manifest.target.installationId;
  if (!/^[a-zA-Z0-9_-]+$/.test(installationId))
    throw new Error('Invalid installation ID in bundle');
  const references = migrationAssetReferences(bundle);
  const prefix = `workspace/${installationId}/`;
  const listed = await storage.list(prefix);
  const byName = new Map<string, AssetObjectVersion[]>();
  for (const object of listed) {
    if (
      !object.name.startsWith(prefix) ||
      !/^[1-9]\d*$/.test(object.generation) ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0
    )
      throw new Error('GCS inventory returned invalid or out-of-prefix metadata');
    const versions = byName.get(object.name) ?? [];
    versions.push(object);
    byName.set(object.name, versions);
  }
  let currentObjects = 0;
  let generationChecked = 0;
  let missingObjects = 0;
  const missingByLifecycleStatus: Record<string, number> = {};
  const missingByTableAndLifecycleStatus: Record<string, Record<string, number>> = {};
  let historicalOnlyObjects = 0;
  let sizeCompared = 0;
  let sizeMismatches = 0;
  let digestChecked = 0;
  let digestMismatches = 0;
  const referencesByTable: Record<AssetReference['table'], number> = {
    email_attachment_custodies: 0,
    files: 0,
    import_sources: 0,
  };
  for (const reference of references) {
    referencesByTable[reference.table]++;
    const name = `${prefix}${reference.path}`;
    const versions = byName.get(name) ?? [];
    const current = versions.find((version) => !version.timeDeleted);
    if (!current) {
      if (versions.length) historicalOnlyObjects++;
      else {
        missingObjects++;
        missingByLifecycleStatus[reference.lifecycleStatus] =
          (missingByLifecycleStatus[reference.lifecycleStatus] ?? 0) + 1;
        let byStatus = missingByTableAndLifecycleStatus[reference.table];
        if (!byStatus) {
          byStatus = {};
          missingByTableAndLifecycleStatus[reference.table] = byStatus;
        }
        byStatus[reference.lifecycleStatus] = (byStatus[reference.lifecycleStatus] ?? 0) + 1;
      }
      continue;
    }
    currentObjects++;
    generationChecked++;
    if (reference.expectedBytes !== undefined) {
      sizeCompared++;
      if (current.size !== reference.expectedBytes) sizeMismatches++;
    }
    if (options.verifyDigests && reference.expectedSha256) {
      digestChecked++;
      if ((await storage.sha256(name, current.generation)) !== reference.expectedSha256)
        digestMismatches++;
    }
  }
  const digestExpected = references.filter((reference) => reference.expectedSha256).length;
  return {
    references: references.length,
    referencesByTable,
    expectedSizeReferences: references.filter((reference) => reference.expectedBytes !== undefined)
      .length,
    expectedDigestReferences: digestExpected,
    currentObjects,
    generationChecked,
    missingObjects,
    missingByLifecycleStatus,
    missingByTableAndLifecycleStatus,
    historicalOnlyObjects,
    sizeCompared,
    sizeMismatches,
    digestChecked,
    digestUnverifiable: options.verifyDigests ? references.length - digestChecked : 0,
    digestMismatches,
    objectGenerationsListed: listed.length,
  };
}

function parseGsUri(uri: string): { bucket: string; object: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2]) throw new Error('Snapshot must be a gs://bucket/object URI');
  return { bucket: match[1], object: match[2] };
}

async function createGcsStorage(bucket: string, token: string): Promise<AssetAuditStorage> {
  const headers = { authorization: `Bearer ${token}` };
  return {
    async list(prefix) {
      const result: AssetObjectVersion[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({
          prefix,
          versions: 'true',
          fields: 'nextPageToken,items(name,generation,size,crc32c,timeDeleted)',
        });
        if (pageToken) query.set('pageToken', pageToken);
        const response = await fetch(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`,
          { headers, signal: AbortSignal.timeout(60_000) },
        );
        if (!response.ok) throw new Error(`GCS inventory failed with HTTP ${response.status}`);
        const body = (await response.json()) as {
          nextPageToken?: string;
          items?: Array<{
            name?: string;
            generation?: string;
            size?: string;
            crc32c?: string;
            timeDeleted?: string;
          }>;
        };
        for (const item of body.items ?? []) {
          if (!item.name || !item.generation || item.size === undefined || !/^\d+$/.test(item.size))
            throw new Error('GCS inventory returned incomplete object metadata');
          result.push({
            name: item.name,
            generation: item.generation,
            size: Number(item.size),
            crc32c: item.crc32c,
            timeDeleted: item.timeDeleted,
          });
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
      return result;
    },
    async sha256(name, generation) {
      const url = new URL(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`,
      );
      url.searchParams.set('alt', 'media');
      url.searchParams.set('generation', generation);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok) throw new Error(`GCS content read failed with HTTP ${response.status}`);
      const hash = createHash('sha256');
      for await (const chunk of response.body ?? []) hash.update(chunk);
      return hash.digest('hex');
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      snapshot: { type: 'string' },
      generation: { type: 'string' },
      sha256: { type: 'string' },
      bundle: { type: 'string' },
      bucket: { type: 'string' },
      'gcloud-auth': { type: 'boolean', default: false },
      'verify-digests': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'Read-only audit of version-3 migration workspace asset references against GCS. Provide --bundle PATH or a pinned --snapshot gs:// URI with --generation and --sha256.',
    );
    return;
  }
  if (!values.bucket) throw new Error('--bucket is required');
  let bytes: Buffer;
  if (values.bundle) {
    if (values.snapshot || values.generation || values.sha256)
      throw new Error('Use either --bundle or pinned --snapshot options');
    bytes = await readFile(values.bundle);
  } else {
    if (
      !values.snapshot ||
      !values.generation ||
      !values.sha256 ||
      !/^[1-9]\d*$/.test(values.generation) ||
      !/^[0-9a-f]{64}$/i.test(values.sha256)
    )
      throw new Error('Pinned --snapshot, --generation, and --sha256 are required');
    const { bucket: snapshotBucket, object } = parseGsUri(values.snapshot);
    const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
    const { GoogleAuth } = await import('google-auth-library');
    const auth =
      authClient ??
      (await new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
      }).getClient());
    const accessToken = (await auth.getAccessToken())?.token;
    if (!accessToken) throw new Error('Google authentication did not provide an access token');
    const headers = { authorization: `Bearer ${accessToken}` };
    const metadataUrl = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(snapshotBucket)}/o/${encodeURIComponent(object)}`,
    );
    metadataUrl.searchParams.set('generation', values.generation);
    metadataUrl.searchParams.set('fields', 'name,generation,size');
    const metadataResponse = await fetch(metadataUrl, { headers });
    if (!metadataResponse.ok)
      throw new Error(`Snapshot metadata read failed with HTTP ${metadataResponse.status}`);
    const metadata = (await metadataResponse.json()) as { generation?: string; size?: string };
    if (metadata.generation !== values.generation || !metadata.size)
      throw new Error('Pinned snapshot generation is unavailable');
    const dataUrl = new URL(metadataUrl);
    dataUrl.searchParams.set('alt', 'media');
    const dataResponse = await fetch(dataUrl, {
      headers,
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!dataResponse.ok)
      throw new Error(`Snapshot content read failed with HTTP ${dataResponse.status}`);
    bytes = Buffer.from(await dataResponse.arrayBuffer());
    if (
      String(bytes.length) !== metadata.size ||
      createHash('sha256').update(bytes).digest('hex') !== values.sha256.toLowerCase()
    )
      throw new Error('Pinned snapshot size or SHA-256 does not match');
  }
  const bundle = JSON.parse(bytes.toString('utf8')) as MigrationBundle;
  validateMigrationBundle(bundle, {
    sourceAgentId: bundle.manifest.source.agentId,
    target: bundle.manifest.target,
  });
  if (bundle.manifest.mode !== 'export' || bundle.manifest.formatVersion !== 3)
    throw new Error('Expected a version-3 PostgreSQL export bundle');
  const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
  const { GoogleAuth } = await import('google-auth-library');
  const gcsAuth =
    authClient ??
    (await new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
    }).getClient());
  const accessToken = (await gcsAuth.getAccessToken())?.token;
  if (!accessToken) throw new Error('Google authentication did not provide an access token');
  const storage = await createGcsStorage(values.bucket, accessToken);
  const result = await auditWorkspaceAssets(bundle, storage, {
    verifyDigests: values['verify-digests'],
  });
  console.log(
    JSON.stringify(
      {
        mode: 'read-only',
        scope: ASSET_REFERENCE_FIELDS,
        bucket: values.bucket,
        snapshot: values.snapshot ?? 'local-bundle',
        snapshotGeneration: values.generation ?? null,
        verifyDigests: values['verify-digests'],
        ...result,
      },
      null,
      2,
    ),
  );
  if (
    result.missingObjects ||
    result.historicalOnlyObjects ||
    result.sizeMismatches ||
    result.digestMismatches
  )
    process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
