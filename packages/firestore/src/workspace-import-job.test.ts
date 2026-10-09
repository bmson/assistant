import { createHash } from 'node:crypto';
import type { MigrationBundle } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from './store.js';
import {
  runWorkspaceImportJob,
  type WorkspaceImportJobEnvironment,
} from './workspace-import-job.js';

const sourceAgentId = '4359911e-244a-4cc8-a1b1-bca4258f9575';
const objectName = 'workspace/assistant/migration/snapshots/assistant-workspace-export-123.json';
const bundle = {
  manifest: {
    formatVersion: 3,
    bundleChecksum: 'bundle-checksum',
    coverage: { complete: true, omittedTables: [] },
  },
  records: [],
} as unknown as MigrationBundle;
const bytes = Buffer.from(JSON.stringify(bundle));
const sha256 = createHash('sha256').update(bytes).digest('hex');

function environment(mode = 'preview'): WorkspaceImportJobEnvironment {
  return {
    GCP_PROJECT: 'customer-project',
    ASSISTANT_WORKSPACE_ID: 'assistant',
    FIRESTORE_TARGET_DATABASE_ID: 'assistant-production',
    MIGRATION_SOURCE_AGENT_ID: sourceAgentId,
    MIGRATION_IMPORT_MODE: mode,
    MIGRATION_SNAPSHOT_URI: `gs://customer-project-workspace/${objectName}`,
    MIGRATION_SNAPSHOT_GENERATION: '1934',
    MIGRATION_SNAPSHOT_SHA256: sha256,
  };
}

function fixture(metadataOverrides: Record<string, unknown> = {}, body = bytes) {
  const requests: Array<{ url: URL; authorization: string | undefined }> = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('http://metadata.google.internal'))
      return Response.json({ access_token: 'private-test-token' });
    const url = new URL(String(input));
    requests.push({
      url,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined,
    });
    if (url.searchParams.get('alt') === 'media') return new Response(body);
    return Response.json({
      bucket: 'customer-project-workspace',
      name: objectName,
      generation: '1934',
      size: String(bytes.length),
      ...metadataOverrides,
    });
  });
  const terminate = vi.fn(async () => undefined);
  const storeFactory = vi.fn(() => ({ db: { terminate } }) as unknown as InstallationStore);
  const importer = vi.fn(async () => ({
    mode: 'preview' as const,
    records: 0,
    derivedMetadata: 0,
    writes: 1,
    collections: {},
    writeBatches: 0,
    maxBatchBytes: 0,
    maxBatchWrites: 0,
  }));
  return { fetcher, requests, storeFactory, terminate, importer };
}

describe('Cloud Run workspace import job', () => {
  it('pins generation and checksum and passes the verified bundle to the requested import mode', async () => {
    const mock = fixture();
    const result = await runWorkspaceImportJob(
      environment('verify'),
      mock.fetcher as typeof fetch,
      mock.importer,
      mock.storeFactory,
    );
    expect(mock.requests).toHaveLength(2);
    for (const request of mock.requests) {
      expect(request.url.pathname).toContain(encodeURIComponent(objectName));
      expect(request.url.searchParams.get('generation')).toBe('1934');
      expect(request.authorization).toBe('Bearer private-test-token');
    }
    expect(mock.requests[1]?.url.searchParams.get('alt')).toBe('media');
    expect(mock.importer).toHaveBeenCalledWith(expect.anything(), bundle, {
      sourceAgentId,
      target: {
        projectId: 'customer-project',
        databaseId: 'assistant-production',
        installationId: 'assistant',
      },
      mode: 'verify',
    });
    expect(mock.terminate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      snapshotGeneration: '1934',
      snapshotSha256: sha256,
      bundleChecksum: 'bundle-checksum',
    });
  });

  it('rejects another installation object before fetching or writing', async () => {
    const mock = fixture();
    const env = environment('write');
    env.MIGRATION_SNAPSHOT_URI =
      'gs://customer-project-workspace/workspace/another/migration/snapshots/x.json';
    await expect(
      runWorkspaceImportJob(env, mock.fetcher as typeof fetch, mock.importer, mock.storeFactory),
    ).rejects.toThrow('Snapshot must belong');
    expect(mock.fetcher).not.toHaveBeenCalled();
    expect(mock.importer).not.toHaveBeenCalled();
  });

  it('rejects changed generation metadata, size, and bytes before opening Firestore', async () => {
    for (const mock of [
      fixture({ generation: '1935' }),
      fixture({ size: '500000001' }),
      fixture({}, Buffer.from('changed')),
    ]) {
      await expect(
        runWorkspaceImportJob(
          environment('write'),
          mock.fetcher as typeof fetch,
          mock.importer,
          mock.storeFactory,
        ),
      ).rejects.toThrow();
      expect(mock.storeFactory).not.toHaveBeenCalled();
      expect(mock.importer).not.toHaveBeenCalled();
    }
  });

  it('rejects a pinned but incomplete source export before opening Firestore', async () => {
    const incomplete = Buffer.from(
      JSON.stringify({
        manifest: { formatVersion: 3, coverage: { complete: false, omittedTables: ['tasks'] } },
        records: [],
      }),
    );
    const mock = fixture({ size: String(incomplete.length) }, incomplete);
    const env = environment('write');
    env.MIGRATION_SNAPSHOT_SHA256 = createHash('sha256').update(incomplete).digest('hex');
    await expect(
      runWorkspaceImportJob(env, mock.fetcher as typeof fetch, mock.importer, mock.storeFactory),
    ).rejects.toThrow('complete version 3');
    expect(mock.storeFactory).not.toHaveBeenCalled();
  });

  it('closes the Firestore client when the strict bundle importer rejects an unsafe write', async () => {
    const mock = fixture();
    mock.importer.mockRejectedValueOnce(new Error('target not empty'));
    await expect(
      runWorkspaceImportJob(
        environment('write'),
        mock.fetcher as typeof fetch,
        mock.importer,
        mock.storeFactory,
      ),
    ).rejects.toThrow('target not empty');
    expect(mock.terminate).toHaveBeenCalledOnce();
  });
});
