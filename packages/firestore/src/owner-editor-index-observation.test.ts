import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { observeOwnerEditorIndexes } from './owner-editor-index-observation.js';
import type { ReadOnlyJsonClient } from './owner-editor-readonly-http.js';

const project = 'example-project';
const database = 'assistant-production';
const group = 'ownerEditorOperations';
const indexName = `projects/${project}/databases/${database}/collectionGroups/${group}/indexes/test-index`;
const fieldName = `projects/${project}/databases/${database}/collectionGroups/${group}/fields/privatePayload`;
const manifestValue = {
  indexes: [
    {
      collectionGroup: group,
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'ownerId', order: 'ASCENDING' },
        { fieldPath: 'formIssuedAt', order: 'ASCENDING' },
        { fieldPath: 'id', order: 'ASCENDING' },
      ],
    },
  ],
  fieldOverrides: [{ collectionGroup: group, fieldPath: 'privatePayload', indexes: [] }],
};
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestValue));
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');

function readyIndex(overrides: Record<string, unknown> = {}) {
  return {
    name: indexName,
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'ownerId', order: 'ASCENDING' },
      { fieldPath: 'formIssuedAt', order: 'ASCENDING' },
      { fieldPath: 'id', order: 'ASCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
    state: 'READY',
    ...overrides,
  };
}

function readyField(overrides: Record<string, unknown> = {}) {
  return {
    name: fieldName,
    indexConfig: {
      indexes: [],
      usesAncestorConfig: false,
      ancestorField: `projects/${project}/databases/${database}/collectionGroups/__default__/fields/*`,
      reverting: false,
    },
    ...overrides,
  };
}

function input(
  overrides: Partial<{
    project: string;
    database: string;
    manifestBytes: Uint8Array;
    expectedManifestSha256: string;
  }> = {},
) {
  return {
    project,
    database,
    manifestBytes,
    expectedManifestSha256: manifestSha256,
    ...overrides,
  };
}

function responseClient(handler: (url: URL) => unknown | Promise<unknown>) {
  const requests: URL[] = [];
  const client: ReadOnlyJsonClient = {
    async get(url) {
      requests.push(new URL(url));
      return handler(url);
    },
  };
  return { client, requests };
}

describe('observeOwnerEditorIndexes', () => {
  it('reports only manifest-scoped parity and keeps global readiness unsupported', async () => {
    const { client, requests } = responseClient((url) =>
      url.pathname.endsWith('/indexes') ? { indexes: [readyIndex()] } : { fields: [readyField()] },
    );

    const report = await observeOwnerEditorIndexes(input(), client);

    expect(report).toEqual({
      schemaVersion: 'owner-editor-index-observation/v1',
      scopedIndexParity: 'matches',
      manifestSha256,
      counts: {
        expectedCompositeIndexes: 1,
        observedCompositeIndexes: 1,
        expectedFieldOverrides: 1,
        observedFieldOverrides: 1,
        collectionGroups: 1,
      },
      diagnostics: [],
      globalIndexReadiness: 'unsupported_incomplete_field_inventory',
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.origin === 'https://firestore.googleapis.com')).toBe(true);
    expect(requests.every((url) => url.searchParams.get('pageSize') === '100')).toBe(true);
    const fieldsUrl = requests.find((url) => url.pathname.endsWith('/fields'));
    expect(fieldsUrl?.searchParams.get('filter')).toBe('indexConfig.usesAncestorConfig:false');
  });

  it.each(['DATASTORE_MODE_API', 'MONGODB_COMPATIBLE_API', 'DATASTORE_MODE'])(
    'does not match an API scope %s against the native ANY_API manifest',
    async (apiScope) => {
      const { client } = responseClient((url) =>
        url.pathname.endsWith('/indexes')
          ? { indexes: [readyIndex({ apiScope })] }
          : { fields: [readyField()] },
      );
      const report = await observeOwnerEditorIndexes(input(), client);
      expect(report.scopedIndexParity).toBe('unknown');
      expect(report.globalIndexReadiness).toBe('unsupported_incomplete_field_inventory');
      expect(report.diagnostics).toEqual([
        apiScope === 'DATASTORE_MODE' ? 'observation_failed' : 'scoped_parity_differs',
      ]);
    },
  );

  it('accepts omitted proto3 repeated fields and omitted false or empty index-config defaults', async () => {
    const overrideOnlyManifest = new TextEncoder().encode(
      JSON.stringify({
        indexes: [],
        fieldOverrides: [{ collectionGroup: group, fieldPath: 'privatePayload', indexes: [] }],
      }),
    );
    const overrideOnlyHash = createHash('sha256').update(overrideOnlyManifest).digest('hex');
    const overrideOnlyClient = responseClient((url) =>
      url.pathname.endsWith('/indexes') ? {} : { fields: [readyField({ indexConfig: {} })] },
    );
    const overrideOnlyReport = await observeOwnerEditorIndexes(
      input({ manifestBytes: overrideOnlyManifest, expectedManifestSha256: overrideOnlyHash }),
      overrideOnlyClient.client,
    );
    expect(overrideOnlyReport.scopedIndexParity).toBe('matches');

    const indexOnlyManifest = new TextEncoder().encode(
      JSON.stringify({ indexes: manifestValue.indexes, fieldOverrides: [] }),
    );
    const indexOnlyHash = createHash('sha256').update(indexOnlyManifest).digest('hex');
    const indexOnlyClient = responseClient((url) =>
      url.pathname.endsWith('/indexes') ? { indexes: [readyIndex()] } : {},
    );
    const indexOnlyReport = await observeOwnerEditorIndexes(
      input({ manifestBytes: indexOnlyManifest, expectedManifestSha256: indexOnlyHash }),
      indexOnlyClient.client,
    );
    expect(indexOnlyReport.scopedIndexParity).toBe('matches');
  });

  it('preserves exact pagination query parameters and includes every returned page', async () => {
    const { client, requests } = responseClient((url) => {
      if (url.searchParams.get('pageToken') === 'cursor-2')
        return url.pathname.endsWith('/indexes')
          ? { indexes: [readyIndex()], nextPageToken: '' }
          : { fields: [readyField()], nextPageToken: '' };
      return url.pathname.endsWith('/indexes')
        ? { indexes: [], nextPageToken: 'cursor-2' }
        : { fields: [], nextPageToken: 'cursor-2' };
    });

    const report = await observeOwnerEditorIndexes(input(), client);

    expect(report.scopedIndexParity).toBe('matches');
    expect(requests).toHaveLength(4);
    const secondPages = requests.filter((url) => url.searchParams.has('pageToken'));
    expect(secondPages).toHaveLength(2);
    expect(secondPages.every((url) => url.searchParams.get('pageSize') === '100')).toBe(true);
    expect(
      secondPages
        .filter((url) => url.pathname.endsWith('/fields'))
        .every((url) => url.searchParams.get('filter') === 'indexConfig.usesAncestorConfig:false'),
    ).toBe(true);
  });

  it('marks a matching but building index as not ready', async () => {
    const { client } = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? { indexes: [readyIndex({ state: 'CREATING' })] }
        : { fields: [readyField()] },
    );

    const report = await observeOwnerEditorIndexes(input(), client);

    expect(report.scopedIndexParity).toBe('not_ready');
    expect(report.diagnostics).toEqual(['index_build_incomplete']);
  });

  it('fails closed on extra indexes and wrong resource targets', async () => {
    const extraIndex = readyIndex({
      name: `${indexName}-other`,
      fields: [
        { fieldPath: 'unexpected', order: 'ASCENDING' },
        { fieldPath: 'other', order: 'ASCENDING' },
      ],
    });
    const extraClient = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? { indexes: [readyIndex(), extraIndex] }
        : { fields: [readyField()] },
    );
    expect((await observeOwnerEditorIndexes(input(), extraClient.client)).scopedIndexParity).toBe(
      'unknown',
    );

    const foreignClient = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? { indexes: [readyIndex({ name: indexName.replace(project, 'foreign-project') })] }
        : { fields: [readyField()] },
    );
    expect((await observeOwnerEditorIndexes(input(), foreignClient.client)).diagnostics).toEqual([
      'observation_failed',
    ]);
  });

  it('rejects incomplete pagination, repeated tokens, malformed pages, and API failures safely', async () => {
    const repeatedToken = responseClient((url) => ({
      [url.pathname.endsWith('/indexes') ? 'indexes' : 'fields']: [],
      nextPageToken: 'same',
    }));
    const repeatedReport = await observeOwnerEditorIndexes(input(), repeatedToken.client);
    expect(repeatedReport.scopedIndexParity).toBe('unknown');
    expect(repeatedReport.diagnostics).toEqual(['observation_failed']);
    expect(repeatedToken.requests).toHaveLength(4);

    const malformed = responseClient((url) =>
      url.pathname.endsWith('/indexes') ? { indexes: 'bad' } : { fields: [] },
    );
    expect((await observeOwnerEditorIndexes(input(), malformed.client)).diagnostics).toEqual([
      'observation_failed',
    ]);

    const secretFailure = responseClient(() => {
      throw new Error('access token private payload');
    });
    const failedReport = await observeOwnerEditorIndexes(input(), secretFailure.client);
    expect(JSON.stringify(failedReport)).not.toContain('access token');
    expect(failedReport.diagnostics).toEqual(['observation_failed']);

    const pageNumbers = new Map<string, number>();
    const tooManyPages = responseClient((url) => {
      const kind = url.pathname.endsWith('/indexes') ? 'indexes' : 'fields';
      const previous = pageNumbers.get(kind) ?? 0;
      const page = previous + 1;
      pageNumbers.set(kind, page);
      return {
        [kind]: [],
        nextPageToken: `cursor-${page}`,
      };
    });
    const capped = await observeOwnerEditorIndexes(input(), tooManyPages.client);
    expect(capped.diagnostics).toEqual(['observation_failed']);
    expect(tooManyPages.requests).toHaveLength(16);

    const errorBody = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? { indexes: [readyIndex()] }
        : { error: { message: 'private server response detail' } },
    );
    const errorBodyReport = await observeOwnerEditorIndexes(input(), errorBody.client);
    expect(errorBodyReport.scopedIndexParity).toBe('unknown');
    expect(errorBodyReport.diagnostics).toEqual(['observation_failed']);
    expect(JSON.stringify(errorBodyReport)).not.toContain('private server response detail');
  });

  it('rejects unsafe target, manifest hash mismatch, TTL, and active or reverting overrides', async () => {
    const spy = vi.fn(async () => ({ indexes: [], fields: [] }));
    const client: ReadOnlyJsonClient = { get: spy };
    expect(
      (await observeOwnerEditorIndexes(input({ database: 'invalid/name' }), client)).diagnostics,
    ).toEqual(['target_invalid']);
    expect(
      (await observeOwnerEditorIndexes(input({ expectedManifestSha256: '0'.repeat(64) }), client))
        .diagnostics,
    ).toEqual(['manifest_invalid']);
    expect(spy).not.toHaveBeenCalled();

    for (const invalidField of [
      readyField({ ttlConfig: { state: 'ENABLED' } }),
      readyField({ indexConfig: { indexes: [], usesAncestorConfig: true, reverting: false } }),
      readyField({ indexConfig: { indexes: [], usesAncestorConfig: false, reverting: true } }),
      readyField({ indexConfig: { indexes: null, usesAncestorConfig: false, reverting: false } }),
      readyField({
        indexConfig: {
          indexes: [{ queryScope: 'COLLECTION' }],
          usesAncestorConfig: false,
          reverting: false,
        },
      }),
    ]) {
      const invalid = responseClient((url) =>
        url.pathname.endsWith('/indexes')
          ? { indexes: [readyIndex()] }
          : { fields: [invalidField] },
      );
      expect((await observeOwnerEditorIndexes(input(), invalid.client)).scopedIndexParity).toBe(
        'unknown',
      );
    }

    const nullRows = responseClient((url) =>
      url.pathname.endsWith('/indexes') ? { indexes: null } : { fields: [readyField()] },
    );
    expect((await observeOwnerEditorIndexes(input(), nullRows.client)).diagnostics).toEqual([
      'observation_failed',
    ]);
  });

  it('matches a vector manifest without name against the API implicit name position', async () => {
    const vectorManifest = new TextEncoder().encode(
      JSON.stringify({
        indexes: [
          {
            collectionGroup: group,
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ownerId', order: 'ASCENDING' },
              { fieldPath: 'embedding', vectorConfig: { dimension: 3, flat: {} } },
            ],
          },
        ],
        fieldOverrides: [],
      }),
    );
    const hash = createHash('sha256').update(vectorManifest).digest('hex');
    const vectorClient = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? {
            indexes: [
              {
                name: indexName,
                queryScope: 'COLLECTION',
                fields: [
                  { fieldPath: 'ownerId', order: 'ASCENDING' },
                  { fieldPath: '__name__', order: 'ASCENDING' },
                  { fieldPath: 'embedding', vectorConfig: { dimension: 3, flat: {} } },
                ],
                state: 'READY',
              },
            ],
          }
        : { fields: [] },
    );

    const report = await observeOwnerEditorIndexes(
      input({ manifestBytes: vectorManifest, expectedManifestSha256: hash }),
      vectorClient.client,
    );
    expect(report.scopedIndexParity).toBe('matches');
  });

  it('matches an explicit vector name field and a manifest whose last field is array-configured', async () => {
    const explicitVectorManifest = new TextEncoder().encode(
      JSON.stringify({
        indexes: [
          {
            collectionGroup: group,
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ownerId', order: 'ASCENDING' },
              { fieldPath: 'embedding', vectorConfig: { dimension: 3, flat: {} } },
              { fieldPath: '__name__', order: 'ASCENDING' },
            ],
          },
        ],
        fieldOverrides: [],
      }),
    );
    const vectorHash = createHash('sha256').update(explicitVectorManifest).digest('hex');
    const explicitVectorClient = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? {
            indexes: [
              {
                name: indexName,
                queryScope: 'COLLECTION',
                fields: [
                  { fieldPath: 'ownerId', order: 'ASCENDING' },
                  { fieldPath: 'embedding', vectorConfig: { dimension: 3, flat: {} } },
                  { fieldPath: '__name__', order: 'ASCENDING' },
                ],
                state: 'READY',
              },
            ],
          }
        : { fields: [] },
    );
    expect(
      (
        await observeOwnerEditorIndexes(
          input({ manifestBytes: explicitVectorManifest, expectedManifestSha256: vectorHash }),
          explicitVectorClient.client,
        )
      ).scopedIndexParity,
    ).toBe('matches');

    const arrayManifest = new TextEncoder().encode(
      JSON.stringify({
        indexes: [
          {
            collectionGroup: group,
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'ownerId', order: 'ASCENDING' },
              { fieldPath: 'labels', arrayConfig: 'CONTAINS' },
            ],
          },
        ],
        fieldOverrides: [],
      }),
    );
    const arrayHash = createHash('sha256').update(arrayManifest).digest('hex');
    const arrayClient = responseClient((url) =>
      url.pathname.endsWith('/indexes')
        ? {
            indexes: [
              {
                name: indexName,
                queryScope: 'COLLECTION',
                fields: [
                  { fieldPath: 'ownerId', order: 'ASCENDING' },
                  { fieldPath: 'labels', arrayConfig: 'CONTAINS' },
                  { fieldPath: '__name__', order: 'ASCENDING' },
                ],
                state: 'READY',
              },
            ],
          }
        : { fields: [] },
    );
    expect(
      (
        await observeOwnerEditorIndexes(
          input({ manifestBytes: arrayManifest, expectedManifestSha256: arrayHash }),
          arrayClient.client,
        )
      ).scopedIndexParity,
    ).toBe('matches');
  });
});
