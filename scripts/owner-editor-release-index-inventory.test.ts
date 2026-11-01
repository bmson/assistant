import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareIndexInventory,
  OWNER_EDITOR_RELEASE_MANIFEST_SHA256,
} from './owner-editor-release-index-inventory.js';

const manifest = readFileSync(
  new URL('./fixtures/owner-editor-release-indexes.json', import.meta.url),
);
const spec = JSON.parse(manifest.toString('utf8')) as {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<Record<string, unknown>>;
  }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
};
const prefix = 'projects/bmson-assistant/databases/assistant-production/collectionGroups/';

function liveComposites() {
  return spec.indexes.map((index, position) => {
    const fields = index.fields.map((field) => ({ ...field }));
    if (!fields.some((field) => field.fieldPath === '__name__')) {
      const vectorPosition = fields.findIndex((field) => field.vectorConfig !== undefined);
      const nameField = {
        fieldPath: '__name__',
        order: fields.at(-1)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
      };
      if (vectorPosition >= 0) fields.splice(vectorPosition, 0, nameField);
      else fields.push(nameField);
    }
    return {
      name: `${prefix}${index.collectionGroup}/indexes/index-${position}`,
      queryScope: index.queryScope,
      apiScope: 'ANY_API',
      state: 'READY',
      fields,
    };
  });
}

function liveOverrides() {
  return spec.fieldOverrides.map((field) => ({
    name: `${prefix}${field.collectionGroup}/fields/${field.fieldPath}`,
    indexConfig: { usesAncestorConfig: false, reverting: false, indexes: [] },
  }));
}

const complete = { compositesComplete: true, fieldsComplete: true } as const;

describe('compareIndexInventory', () => {
  it('compares the full target inventory through the canonical readiness verifier', async () => {
    const result = await compareIndexInventory(
      manifest,
      liveComposites(),
      liveOverrides(),
      complete,
    );

    expect(result.status).toBe('exact_manifest_parity');
    expect(result.manifestSha256).toBe(OWNER_EDITOR_RELEASE_MANIFEST_SHA256);
    expect(result.globalReadiness).toBe('not_established');
  });

  it('accepts only the manifest default API scope, not another recognized scope', async () => {
    const composites = liveComposites();
    const first = composites[0];
    if (!first) throw new Error('missing composite fixture');
    composites[0] = { ...first, apiScope: 'DATASTORE_MODE_API' };

    await expect(
      compareIndexInventory(manifest, composites, liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'inventory_not_exact',
    });
  });

  it('does not report parity when the unpinned default field configuration is present', async () => {
    const overrides = [
      ...liveOverrides(),
      {
        name: `${prefix}__default__/fields/*`,
        indexConfig: {
          indexes: [
            { queryScope: 'COLLECTION', fields: [{ fieldPath: '*', order: 'ASCENDING' }] },
            { queryScope: 'COLLECTION', fields: [{ fieldPath: '*', order: 'DESCENDING' }] },
            { queryScope: 'COLLECTION', fields: [{ fieldPath: '*', arrayConfig: 'CONTAINS' }] },
          ],
        },
      },
    ];

    await expect(
      compareIndexInventory(manifest, liveComposites(), overrides, complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'default_configuration_unverified',
    });
  });

  it('keeps default field TTL configuration unverified', async () => {
    const ttlDefault = [
      ...liveOverrides(),
      {
        name: `${prefix}__default__/fields/*`,
        indexConfig: { indexes: [] },
        ttlConfig: { state: 'ENABLED' },
      },
    ];

    await expect(
      compareIndexInventory(manifest, liveComposites(), ttlDefault, complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'default_configuration_unverified',
    });
  });

  it('keeps inventory coverage unknown when either caller completeness assertion is absent', async () => {
    const composites = liveComposites();
    const overrides = liveOverrides();

    await expect(
      compareIndexInventory(manifest, composites, overrides, {
        compositesComplete: true,
        fieldsComplete: false,
      }),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'inventory_incomplete' });
  });

  it('classifies only the approved owner editor index as missing', async () => {
    const composites = liveComposites().filter(
      (row) => !row.name.includes('/ownerEditorOperations/'),
    );

    await expect(
      compareIndexInventory(manifest, composites, liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'only_approved_owner_editor_index_missing',
      missingIndex: {
        collectionGroup: 'ownerEditorOperations',
        queryScope: 'COLLECTION',
      },
    });
  });

  it('rejects a changed unrelated index instead of proposing a create', async () => {
    const composites = liveComposites();
    const changed = composites.find((row) => row.name.includes('/tasks/'));
    if (!changed) throw new Error('test fixture missing tasks index');
    changed.fields[0] = { fieldPath: 'differentField', order: 'ASCENDING' };

    await expect(
      compareIndexInventory(manifest, composites, liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'inventory_not_exact',
    });
  });

  it('does not treat a CREATING approved index as parity or as a missing-index plan', async () => {
    const composites = liveComposites();
    const target = composites.find((row) => row.name.includes('/ownerEditorOperations/'));
    if (!target) throw new Error('test fixture missing approved index');
    target.state = 'CREATING';

    await expect(
      compareIndexInventory(manifest, composites, liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'inventory_not_exact',
    });
  });

  it('rejects duplicate resources, unsafe exemptions, and unknown API scopes', async () => {
    const composites = liveComposites();
    const first = composites[0];
    if (!first) throw new Error('missing composite fixture');
    composites.push({ ...first });
    await expect(
      compareIndexInventory(manifest, composites, liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'inventory_not_exact',
    });

    const unsafeOverrides: unknown[] = liveOverrides();
    const firstOverride = liveOverrides()[0];
    if (!firstOverride) throw new Error('missing override fixture');
    unsafeOverrides[0] = { ...firstOverride, ttlConfig: { state: 'ENABLED' } };
    await expect(
      compareIndexInventory(manifest, liveComposites(), unsafeOverrides, complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'inventory_not_exact',
    });

    const unknownScope = liveComposites();
    const firstUnknownScope = unknownScope[0];
    if (!firstUnknownScope) throw new Error('missing composite fixture');
    unknownScope[0] = { ...firstUnknownScope, apiScope: 'FUTURE_API' };
    await expect(
      compareIndexInventory(manifest, unknownScope, liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'inventory_not_exact',
    });
  });

  it('rejects an unpinned manifest without inspecting caller inventories', async () => {
    const changed = Buffer.from(manifest);
    changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;

    await expect(compareIndexInventory(changed, [], [], complete)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'manifest_not_pinned',
    });
  });
});
