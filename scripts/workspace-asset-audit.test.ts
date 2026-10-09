import { describe, expect, it, vi } from 'vitest';
import type { MigrationBundle, MigrationRecord } from '../packages/persistence/src/migration.js';
import {
  ASSET_REFERENCE_FIELDS,
  type AssetAuditStorage,
  auditWorkspaceAssets,
  migrationAssetReferences,
} from './workspace-asset-audit.js';

const bundle = (records: MigrationRecord[]) =>
  ({
    manifest: {
      format: 'assistant-workspace-migration',
      formatVersion: 3,
      mode: 'export',
      source: { kind: 'postgresql', agentId: 'agent', scope: 'installation', snapshot: 'snapshot' },
      target: {
        projectId: 'project',
        databaseId: 'assistant-production',
        installationId: 'install',
      },
      tables: {},
      coverage: { complete: true, supportedTables: [], omittedTables: [] },
      recordCount: records.length,
      bundleChecksum: 'x',
      unsupportedTables: [],
    },
    records,
  }) as unknown as MigrationBundle;

const file = (id: string, path: string, bytes = 3, sha256?: string) =>
  ({
    table: 'files',
    collection: 'files',
    id,
    data: { id, workspacePath: path, bytes, sha256: sha256 ?? null, taskId: null },
    checksum: 'x',
  }) as unknown as MigrationRecord;

const source = (id: string, path: string) =>
  ({
    table: 'import_sources',
    collection: 'importSources',
    id,
    data: { id, workspacePath: path, status: 'done' },
    checksum: 'x',
  }) as unknown as MigrationRecord;

const custody = (
  id: string,
  path: string,
  status = 'object_written',
  actualBytes: number | null = 43,
  sha256: string | null = 'c'.repeat(64),
) =>
  ({
    table: 'email_attachment_custodies',
    collection: 'emailAttachmentCustodies',
    id,
    data: { id, workspacePath: path, status, actualBytes, sha256 },
    checksum: 'x',
  }) as unknown as MigrationRecord;

describe('workspace asset audit', () => {
  it('declares and extracts every direct workspace path field in the source schema', async () => {
    const { readFile } = await import('node:fs/promises');
    const schema = await readFile(new URL('../packages/db/src/schema.ts', import.meta.url), 'utf8');
    expect(schema.match(/workspacePath: text\('workspace_path'\)/g)).toHaveLength(
      ASSET_REFERENCE_FIELDS.length,
    );
    expect(ASSET_REFERENCE_FIELDS).toEqual([
      { table: 'files', field: 'workspacePath' },
      { table: 'email_attachment_custodies', field: 'workspacePath' },
      { table: 'import_sources', field: 'workspacePath' },
    ]);
    expect(
      migrationAssetReferences(
        bundle([file('f1', 'browser/shot.png'), source('s1', 'import/archive.mbox')]),
      ),
    ).toEqual([
      {
        table: 'files',
        id: 'f1',
        path: 'browser/shot.png',
        lifecycleStatus: 'unlinked',
        expectedBytes: 3,
        expectedSha256: undefined,
      },
      {
        table: 'import_sources',
        id: 's1',
        path: 'import/archive.mbox',
        lifecycleStatus: 'done',
        expectedBytes: undefined,
        expectedSha256: undefined,
      },
    ]);
    const bigintFile = file('f2', 'documents/report.pdf');
    bigintFile.data.bytes = { $assistantMigration: ['bigint', '42'] } as never;
    expect(migrationAssetReferences(bundle([bigintFile]))[0]?.expectedBytes).toBe(42);
    expect(migrationAssetReferences(bundle([file('f3', 'browser\\shot.png')]))[0]?.path).toBe(
      'browser/shot.png',
    );
    expect(
      migrationAssetReferences(
        bundle([custody('c1', 'email-attachments/custody/123e4567-e89b-42d3-a456-426614174000')]),
      ),
    ).toEqual([
      {
        table: 'email_attachment_custodies',
        id: 'c1',
        path: 'email-attachments/custody/123e4567-e89b-42d3-a456-426614174000',
        lifecycleStatus: 'object_written',
        expectedBytes: 43,
        expectedSha256: 'c'.repeat(64),
      },
    ]);
    expect(
      migrationAssetReferences(
        bundle([
          custody(
            'c2',
            'email-attachments/custody/123e4567-e89b-42d3-a456-426614174001',
            'erased',
            null,
            null,
          ),
        ]),
      )[0],
    ).toMatchObject({
      table: 'email_attachment_custodies',
      lifecycleStatus: 'erased',
      expectedBytes: undefined,
      expectedSha256: undefined,
    });
  });

  it('compares current and historical generations and checks bytes/digests without mutating storage', async () => {
    const storage: AssetAuditStorage = {
      list: vi.fn(async () => [
        { name: 'workspace/install/browser/shot.png', generation: '11', size: 3 },
        {
          name: 'workspace/install/import/old.mbox',
          generation: '8',
          size: 40,
          timeDeleted: '2026-01-01T00:00:00Z',
        },
      ]),
      sha256: vi.fn(async () => 'a'.repeat(64)),
    };
    const failedTask = {
      table: 'tasks',
      collection: 'tasks',
      id: 'task-failed',
      data: { status: 'failed' },
      checksum: 'x',
    } as unknown as MigrationRecord;
    const failedArtifact = file('failed-artifact', 'browser/failed.png');
    failedArtifact.data.taskId = 'task-failed' as never;
    const result = await auditWorkspaceAssets(
      bundle([
        file('present', 'browser/shot.png', 3, 'a'.repeat(64)),
        file('historical', 'import/old.mbox'),
        file('missing', 'documents/missing.pdf'),
        file('wrong-size', 'browser/shot.png', 4),
        failedTask,
        failedArtifact,
        source('done-source', 'import/no-source.mbox'),
      ]),
      storage,
      { verifyDigests: true },
    );
    expect(result).toEqual({
      references: 6,
      referencesByTable: { email_attachment_custodies: 0, files: 5, import_sources: 1 },
      expectedSizeReferences: 5,
      expectedDigestReferences: 1,
      currentObjects: 2,
      generationChecked: 2,
      missingObjects: 3,
      missingByLifecycleStatus: { unlinked: 1, failed: 1, done: 1 },
      missingByTableAndLifecycleStatus: {
        files: { unlinked: 1, failed: 1 },
        import_sources: { done: 1 },
      },
      historicalOnlyObjects: 1,
      sizeCompared: 2,
      sizeMismatches: 1,
      digestChecked: 1,
      digestUnverifiable: 5,
      digestMismatches: 0,
      objectGenerationsListed: 2,
    });
    expect(storage.sha256).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe paths and invalid digests from the snapshot', () => {
    expect(() => migrationAssetReferences(bundle([file('bad', '../escape')]))).toThrow('Unsafe');
    expect(() => migrationAssetReferences(bundle([file('bad', 'a/../../escape')]))).toThrow(
      'Unsafe',
    );
    expect(() => migrationAssetReferences(bundle([file('bad', 'a', 1, 'bad')]))).toThrow('SHA-256');
  });
});
