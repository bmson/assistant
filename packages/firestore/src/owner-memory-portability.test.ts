import { createHash } from 'node:crypto';
import {
  checksumForMigrationVersion,
  deserializeMigrationValue,
  type MigrationBundle,
  type MigrationRecord,
  migrationBundleChecksum,
  nextOwnerCorrection,
  parseOwnerCorrection,
  serializeMigrationValue,
  validateMigrationBundle,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import { FirestorePrivacyExportRepository } from './privacy-export.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import type { InstallationStore } from './store.js';
import { importWorkspaceBundle } from './workspace-migration.js';

const owner = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const contentHash = hash('Corrected saved note');
const marker = nextOwnerCorrection({
  previous: null,
  priorContentHash: hash('Prior saved note'),
  currentContentHash: contentHash,
  correctedAt: '2026-10-26T00:00:00.000Z',
});
const variants = [
  { name: 'omitted', fields: {} },
  { name: 'null', fields: { ownerCorrection: null } },
  { name: 'corrected', fields: { ownerCorrection: marker } },
];

function bundle(version: 1 | 2 | 3, fields: Record<string, unknown>): MigrationBundle {
  const record = (
    table: 'agents' | 'memories',
    id: string,
    value: Record<string, unknown>,
  ): MigrationRecord => {
    const data = serializeMigrationValue(value) as MigrationRecord['data'];
    return {
      table,
      collection: table,
      id,
      data,
      checksum: checksumForMigrationVersion(data, version),
    };
  };
  const records = [
    record('agents', owner, {
      id: owner,
      name: 'Owner',
      email: 'owner@example.test',
      workspacePrefix: 'workspace/test',
    }),
    record('memories', memoryId, {
      id: memoryId,
      agentId: owner,
      content: 'Corrected saved note',
      contentHash,
      category: 'knowledge',
      source: 'original-import-source',
      sourceTaskId: null,
      ownerConfirmed: true,
      originTrust: 'owner',
      createdAt: new Date('2026-10-25T00:00:00.000Z'),
      ...fields,
    }),
  ];
  return {
    manifest: {
      format: 'assistant-workspace-migration',
      formatVersion: version,
      mode: 'export',
      source: { kind: 'postgresql', agentId: owner, scope: 'installation', snapshot: '1:1:' },
      target: {
        projectId: 'customer-project',
        databaseId: '(default)',
        installationId: 'assistant',
      },
      coverage: {
        complete: false,
        supportedTables: ['agents', 'memories'],
        omittedTables: ['tasks'],
      },
      tables: Object.fromEntries(
        records.map((row) => [
          row.table,
          {
            collection: row.collection,
            count: 1,
            checksum: checksumForMigrationVersion([row], version),
          },
        ]),
      ) as MigrationBundle['manifest']['tables'],
      recordCount: records.length,
      bundleChecksum: migrationBundleChecksum(records, version),
      unsupportedTables: [],
    },
    records,
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing portability fixture record');
  return value;
}
const noStorage = new Proxy({} as InstallationStore, {
  get() {
    throw new Error('Offline migration preview must not access destination storage');
  },
});

function validate(input: MigrationBundle) {
  validateMigrationBundle(input, { sourceAgentId: owner, target: input.manifest.target });
}

describe('owner correction portable compatibility', () => {
  for (const version of [1, 2, 3] as const) {
    it.each(variants)(
      `preserves $name marker and checksums in format ${version} through real import preview`,
      async ({ fields }) => {
        const input = bundle(version, fields);
        const before = JSON.stringify(input);
        const oldChecksum = input.manifest.bundleChecksum;
        validate(input);
        expect(
          await importWorkspaceBundle(noStorage, input, {
            sourceAgentId: owner,
            target: input.manifest.target,
            mode: 'preview',
          }),
        ).toMatchObject({ mode: 'preview', records: 2, destinationOwnerChecked: false });
        expect(JSON.stringify(input)).toBe(before);
        expect(migrationBundleChecksum(input.records, version)).toBe(oldChecksum);
        const restored = deserializeMigrationValue(required(input.records[1]).data) as Record<
          string,
          unknown
        >;
        expect(restored).toMatchObject({
          source: 'original-import-source',
          ownerConfirmed: true,
          originTrust: 'owner',
        });
        expect(Object.hasOwn(restored, 'ownerCorrection')).toBe(
          Object.hasOwn(fields, 'ownerCorrection'),
        );
        expect(parseOwnerCorrection(restored.ownerCorrection, contentHash)).toEqual(
          fields.ownerCorrection ?? null,
        );
      },
    );

    it(`binds marker content to format ${version} record/table/bundle checksums and rejects stale attribution`, () => {
      const input = bundle(version, { ownerCorrection: marker });
      const originalChecksum = input.manifest.bundleChecksum;
      const memory = required(input.records[1]);
      memory.data.ownerCorrection = { ...marker, correctedAt: '2026-10-26T00:00:01.000Z' };
      expect(() => validate(input)).toThrow('checksum');
      expect(migrationBundleChecksum(input.records, version)).not.toBe(originalChecksum);
      // Even a self-consistent checksum cannot make stale or extra attribution valid.
      for (const invalid of [
        { ...marker, currentContentHash: hash('Other note') },
        { ...marker, draft: 'private unsaved text' },
        { ...marker, correctedAt: '2026-10-26' },
      ])
        expect(() => validate(bundle(version, { ownerCorrection: invalid }))).toThrow(
          'Invalid owner correction marker',
        );
    });
  }
});

describe('generic memory mutations and privacy export retain exact marker state', () => {
  it.each(variants)(
    'does not infer or backfill $name attribution from owner trust, confirmation, restore or pin',
    async ({ fields }) => {
      const f = ownerEditorTestStore();
      f.seed('agents', owner, { id: owner });
      f.seed('memories', memoryId, {
        id: memoryId,
        agentId: owner,
        contentHash,
        content: 'Corrected saved note',
        category: 'knowledge',
        kind: 'fact',
        source: 'original-import-source',
        ownerConfirmed: true,
        originTrust: 'owner',
        quarantined: false,
        importance: 3,
        confidence: '1.00',
        pinned: false,
        expiresAt: null,
        createdAt: new Date('2026-10-25T00:00:00.000Z'),
        ...fields,
      });
      const repo = new FirestoreProfileMemoryManagementRepository(f.store, {
        provider: 'test',
        model: 'unit',
        dimensions: 3,
        revision: '1',
      });
      for (const mutate of [
        () => repo.confirm(memoryId),
        () => repo.restore(memoryId),
        () => repo.setProminence(memoryId, 'always'),
      ]) {
        expect(await mutate()).toMatchObject({ status: 'updated' });
        const row = required(f.rows('memories')[0]);
        expect(Object.hasOwn(row, 'ownerCorrection')).toBe(
          Object.hasOwn(fields, 'ownerCorrection'),
        );
        expect(row.ownerCorrection).toEqual(fields.ownerCorrection);
        expect(row.contentHash).toBe(contentHash);
        expect(row.source).toBe('original-import-source');
      }
      const exported = await new FirestorePrivacyExportRepository(f.store, owner).exportOwnerData();
      expect(exported.memories).toHaveLength(1);
      expect(exported.memories[0]?.ownerCorrection).toEqual(fields.ownerCorrection);
      expect(JSON.stringify(exported)).not.toContain('Prior saved note');
      expect(f.stats.readsAfterWrites).toBe(0);
    },
  );
});
