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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

function liveOverrides(): unknown[] {
  const explicit = spec.fieldOverrides.map((field) => ({
    name: `${prefix}${field.collectionGroup}/fields/${field.fieldPath}`,
    indexConfig: { usesAncestorConfig: false, reverting: false, indexes: [] },
  }));
  const defaultName = `${prefix}__default__/fields/*`;
  return [
    ...explicit,
    {
      name: defaultName,
      indexConfig: {
        usesAncestorConfig: false,
        reverting: false,
        indexes: [
          {
            queryScope: 'COLLECTION',
            state: 'READY',
            fields: [{ fieldPath: '*', order: 'ASCENDING' }],
          },
          {
            queryScope: 'COLLECTION',
            state: 'READY',
            fields: [{ fieldPath: '*', order: 'DESCENDING' }],
          },
          {
            queryScope: 'COLLECTION',
            state: 'READY',
            fields: [{ fieldPath: '*', arrayConfig: 'CONTAINS' }],
          },
        ],
      },
    },
  ];
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

    if (result.status !== 'exact_manifest_parity')
      throw new Error('expected exact manifest parity');
    expect(result.status).toBe('exact_manifest_parity');
    expect(result.manifestSha256).toBe(OWNER_EDITOR_RELEASE_MANIFEST_SHA256);
    expect(result.fieldOverrideCount).toBe(spec.fieldOverrides.length + 1);
    expect(result.explicitFieldOverrideCount).toBe(spec.fieldOverrides.length);
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

  it('validates the documented global default modes then excludes only that sentinel from parity', async () => {
    await expect(
      compareIndexInventory(manifest, liveComposites(), liveOverrides(), complete),
    ).resolves.toMatchObject({
      status: 'exact_manifest_parity',
      fieldOverrideCount: spec.fieldOverrides.length + 1,
    });
  });

  it('accepts documented canonical ancestor metadata without treating it as inherited configuration', async () => {
    const overrides = liveOverrides();
    const defaultName = `${prefix}__default__/fields/*`;
    const index = overrides.findIndex((row) => isRecord(row) && row.name === defaultName);
    const row = overrides[index];
    if (!row || !isRecord(row)) throw new Error('missing default fixture');
    const config = row.indexConfig as Record<string, unknown>;
    overrides[index] = { ...row, indexConfig: { ...config, ancestorField: defaultName } };
    await expect(
      compareIndexInventory(manifest, liveComposites(), overrides, complete),
    ).resolves.toMatchObject({ status: 'exact_manifest_parity' });
  });

  it('keeps default field TTL configuration unverified', async () => {
    const ttlDefault = liveOverrides();
    const defaultIndex = ttlDefault.findIndex((row) =>
      isRecord(row) ? row.name === `${prefix}__default__/fields/*` : false,
    );
    const defaultRow = ttlDefault[defaultIndex];
    if (!defaultRow || !isRecord(defaultRow)) throw new Error('missing default fixture');
    ttlDefault[defaultIndex] = { ...defaultRow, ttlConfig: { state: 'ENABLED' } };

    await expect(
      compareIndexInventory(manifest, liveComposites(), ttlDefault, complete),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'default_configuration_unverified',
    });
  });

  it.each([
    {
      label: 'missing',
      change: (rows: unknown[]) =>
        rows.filter((row) => !(isRecord(row) && row.name === `${prefix}__default__/fields/*`)),
    },
    {
      label: 'duplicate',
      change: (rows: unknown[]) => [
        ...rows,
        rows.find((row) => isRecord(row) && row.name === `${prefix}__default__/fields/*`),
      ],
    },
    {
      label: 'missing a standard mode',
      change: (rows: unknown[]) =>
        rows.map((row) => {
          if (!isRecord(row) || row.name !== `${prefix}__default__/fields/*`) return row;
          const config = row.indexConfig as Record<string, unknown>;
          return {
            ...row,
            indexConfig: { ...config, indexes: (config.indexes as unknown[]).slice(0, 2) },
          };
        }),
    },
    {
      label: 'building a standard mode',
      change: (rows: unknown[]) =>
        rows.map((row) => {
          if (!isRecord(row) || row.name !== `${prefix}__default__/fields/*`) return row;
          const config = row.indexConfig as Record<string, unknown>;
          const indexes = config.indexes as Array<Record<string, unknown>>;
          return {
            ...row,
            indexConfig: {
              ...config,
              indexes: indexes.map((index, position) =>
                position === 0 ? { ...index, state: 'CREATING' } : index,
              ),
            },
          };
        }),
    },
    {
      label: 'missing an explicit READY state',
      change: (rows: unknown[]) =>
        rows.map((row) => {
          if (!isRecord(row) || row.name !== `${prefix}__default__/fields/*`) return row;
          const config = row.indexConfig as Record<string, unknown>;
          const indexes = config.indexes as Array<Record<string, unknown>>;
          const first = { ...(indexes[0] ?? {}) };
          delete first.state;
          return { ...row, indexConfig: { ...config, indexes: [first, ...indexes.slice(1)] } };
        }),
    },
    {
      label: 'inheriting ancestor configuration',
      change: (rows: unknown[]) =>
        rows.map((row) => {
          if (!isRecord(row) || row.name !== `${prefix}__default__/fields/*`) return row;
          const config = row.indexConfig as Record<string, unknown>;
          return { ...row, indexConfig: { ...config, usesAncestorConfig: true } };
        }),
    },
    {
      label: 'extra mode',
      change: (rows: unknown[]) =>
        rows.map((row) => {
          if (!isRecord(row) || row.name !== `${prefix}__default__/fields/*`) return row;
          const config = row.indexConfig as Record<string, unknown>;
          return {
            ...row,
            indexConfig: {
              ...config,
              indexes: [
                ...(config.indexes as unknown[]),
                { queryScope: 'COLLECTION', fields: [{ fieldPath: '*', order: 'ASCENDING' }] },
              ],
            },
          };
        }),
    },
  ])('keeps the global default configuration unverified when $label', async ({ change }) => {
    await expect(
      compareIndexInventory(manifest, liveComposites(), change(liveOverrides()), complete),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'default_configuration_unverified' });
  });

  it('accepts only a documented same-database ancestor field on explicit exemptions', async () => {
    const overrides = liveOverrides();
    const first = overrides[0];
    if (!first || !isRecord(first)) throw new Error('missing explicit override');
    const config = first.indexConfig as Record<string, unknown>;
    overrides[0] = {
      ...first,
      indexConfig: { ...config, ancestorField: `${prefix}__default__/fields/*` },
    };
    await expect(
      compareIndexInventory(manifest, liveComposites(), overrides, complete),
    ).resolves.toMatchObject({ status: 'exact_manifest_parity' });

    const invalid = liveOverrides();
    const invalidFirst = invalid[0];
    if (!invalidFirst || !isRecord(invalidFirst)) throw new Error('missing explicit override');
    const invalidConfig = invalidFirst.indexConfig as Record<string, unknown>;
    invalid[0] = {
      ...invalidFirst,
      indexConfig: {
        ...invalidConfig,
        ancestorField: 'projects/other/databases/private/collectionGroups/tasks/fields/*',
      },
    };
    await expect(
      compareIndexInventory(manifest, liveComposites(), invalid, complete),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'inventory_not_exact' });

    const inherited = liveOverrides();
    const inheritedFirst = inherited[0];
    if (!inheritedFirst || !isRecord(inheritedFirst)) throw new Error('missing explicit override');
    const inheritedConfig = inheritedFirst.indexConfig as Record<string, unknown>;
    inherited[0] = {
      ...inheritedFirst,
      indexConfig: { ...inheritedConfig, usesAncestorConfig: true },
    };
    await expect(
      compareIndexInventory(manifest, liveComposites(), inherited, complete),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'inventory_not_exact' });
  });

  it('rejects unknown top-level field resource settings without reporting parity', async () => {
    const overrides = liveOverrides();
    const first = overrides[0];
    if (!first || !isRecord(first)) throw new Error('missing explicit override');
    overrides[0] = { ...first, unrelatedConfiguration: true };
    await expect(
      compareIndexInventory(manifest, liveComposites(), overrides, complete),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'inventory_not_exact' });

    const defaultRows = liveOverrides();
    const defaultName = `${prefix}__default__/fields/*`;
    const index = defaultRows.findIndex((row) => isRecord(row) && row.name === defaultName);
    const defaultRow = defaultRows[index];
    if (!defaultRow || !isRecord(defaultRow)) throw new Error('missing default fixture');
    defaultRows[index] = { ...defaultRow, unrelatedConfiguration: true };
    await expect(
      compareIndexInventory(manifest, liveComposites(), defaultRows, complete),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'default_configuration_unverified' });
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
      explicitFieldOverrideCount: spec.fieldOverrides.length,
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
