import { describe, expect, it, vi } from 'vitest';
import { buildFirestoreOwnerEditorEpochRecord } from '../packages/firestore/src/owner-editor-epoch-record.js';
import {
  createEditorMetadataRead,
  editorMetadataTarget,
  editorMetadataUrls,
  observeEditorReadiness,
} from './owner-editor-release-readiness.js';

const target = { workspaceId: 'assistant', ownerId: '20000000-0000-4000-8000-000000000001' };
const nullPrivacy = '7bbca5c1c6b18b78824f0e513a232b9344a43a861442e577784faba92a89a322';
const completedPrivacy = '51ba31566246ed57d981bcf159932fff981051e9acb61a196bedc12e5e0faccc';
const field = (stringValue: string) => ({ stringValue });
function fixture(options: { ready?: boolean; privacy?: boolean; digest?: string } = {}) {
  const urls = editorMetadataUrls(target);
  const resource = (url: string) => new URL(url).pathname.replace(/^\/v1\//, '');
  const cursor = {
    ownerId: target.ownerId,
    epoch: '20000000-0000-4000-8000-000000000002',
    ready: options.ready ?? true,
    privacyGenerationDigest: options.digest ?? (options.privacy ? completedPrivacy : nullPrivacy),
  };
  const data = new Map<string, unknown | null>([
    [
      urls[0],
      {
        documents: [
          {
            name: `${resource(urls[0])}/${Buffer.from(target.ownerId).toString('base64url')}`,
            updateTime: '2026-10-29T22:00:00.123456789Z',
            fields: { id: field(target.ownerId) },
          },
        ],
      },
    ],
    [
      urls[1],
      options.privacy
        ? {
            name: resource(urls[1]),
            updateTime: '2026-10-29T22:00:00.123456789Z',
            fields: {
              agentId: field(target.ownerId),
              status: field('complete'),
              generation: field('fixture-generation'),
            },
          }
        : null,
    ],
    [
      urls[2],
      {
        name: resource(urls[2]),
        updateTime: '2026-10-29T22:00:01.123456789Z',
        fields: {
          name: field(`owner-editor-epoch:${target.ownerId}`),
          cursor: field(JSON.stringify(cursor)),
        },
      },
    ],
  ]);
  const read = vi.fn(async (url: string) => {
    if (!data.has(url)) throw new Error('unexpected URL');
    return data.get(url);
  });
  return { urls, cursor, data, read };
}
describe('field-masked release editor metadata (offline)', () => {
  it('uses exact encoded logical store keys and field masks, no user records', () => {
    const urls = editorMetadataUrls(target);
    expect(urls[0]).toContain('/installations/YXNzaXN0YW50/agents?pageSize=2&mask.fieldPaths=id');
    expect(urls[2]).not.toContain('owner-editor-epoch:');
    expect(new URL(urls[2]).searchParams.getAll('mask.fieldPaths')).toEqual(['name', 'cursor']);
    expect(() => editorMetadataUrls({ ...target, workspaceId: '../private' })).toThrow();
  });
  it('extracts only explicit plain serving config and does not guess defaults', () => {
    const service = {
      template: {
        containers: [
          {
            env: Object.entries({
              ASSISTANT_WORKSPACE_ID: target.workspaceId,
              FIRESTORE_AGENT_ID: target.ownerId,
            }).map(([name, value]) => ({ name, value })),
          },
        ],
      },
    };
    expect(editorMetadataTarget(service)).toEqual(target);
    expect(editorMetadataTarget({ template: { containers: [{ env: [] }] } })).toBeNull();
    service.template.containers[0]?.env.push({ name: 'FIRESTORE_AGENT_ID', value: target.ownerId });
    expect(editorMetadataTarget(service)).toBeNull();
  });
  it.each([false, true])(
    'observes ready bound metadata with completed privacy=%s, preserving nanoseconds',
    async (privacy) => {
      const f = fixture({ privacy });
      const result = await observeEditorReadiness(f.read, target);
      expect(result).toMatchObject({
        status: 'ready',
        epochPresent: true,
        epochReady: true,
        privacyBound: true,
        ownerMatched: true,
        consistentSnapshot: false,
        activationAuthorized: false,
      });
      expect(f.read).toHaveBeenCalledTimes(6);
      expect(JSON.stringify(result)).not.toContain(target.ownerId);
      expect(JSON.stringify(result)).not.toContain('fixture-generation');
      expect(JSON.stringify(result)).not.toContain('privacyGenerationDigest');
    },
  );
  it('reports missing and disabled epochs separately without creating either', async () => {
    const missing = fixture();
    missing.data.set(missing.urls[2], null);
    expect(await observeEditorReadiness(missing.read, target)).toMatchObject({
      status: 'missing',
      epochPresent: false,
    });
    const disabled = fixture({ ready: false });
    expect(await observeEditorReadiness(disabled.read, target)).toMatchObject({
      status: 'unavailable',
      reason: 'editor_epoch_disabled',
    });
  });
  it('reports changed privacy as unavailable, never enables or rotates', async () => {
    const f = fixture({ digest: 'a'.repeat(64) });
    expect(await observeEditorReadiness(f.read, target)).toMatchObject({
      status: 'unavailable',
      privacyBound: false,
    });
  });
  it('denied reads and malformed metadata stay unknown without raw error/body retention', async () => {
    expect(
      await observeEditorReadiness(async () => {
        throw new Error('private-token-do-not-print');
      }, target),
    ).toMatchObject({ status: 'unknown', epochReady: null });
    const f = fixture();
    f.data.set(f.urls[2], { private: 'do not retain' });
    const result = await observeEditorReadiness(f.read, target);
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'metadata_schema_invalid',
      stage: 'epoch_first_validation',
    });
    expect(JSON.stringify(result)).not.toContain('do not retain');
  });
  it('does not mistake repeated separate reads for a consistent snapshot', async () => {
    const f = fixture();
    let calls = 0;
    const result = await observeEditorReadiness(async (url) => {
      calls++;
      const value = await f.read(url);
      if (calls !== 6 || !value || typeof value !== 'object') return value;
      const epoch = value as { fields: { cursor: { stringValue: string } } };
      const state = JSON.parse(epoch.fields.cursor.stringValue) as Record<string, unknown>;
      return {
        ...epoch,
        fields: {
          ...epoch.fields,
          cursor: field(
            JSON.stringify({
              ...state,
              epoch: '20000000-0000-4000-8000-000000000003',
            }),
          ),
        },
      };
    }, target);
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'metadata_unstable',
      stage: 'consistency_check',
      httpStatus: null,
    });
  });
  it('compares canonical REST values so reordered JSON object properties remain stable', async () => {
    const f = fixture();
    let calls = 0;
    const reorderKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorderKeys);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([name, child]) => [name, reorderKeys(child)]),
      );
    };
    const result = await observeEditorReadiness(async (url) => {
      calls++;
      const value = await f.read(url);
      return calls > 3 ? reorderKeys(value) : value;
    }, target);
    expect(result).toMatchObject({ status: 'ready', observationStable: true });
  });
  it('treats a changed privacy updateTime as an unstable observation', async () => {
    const f = fixture({ privacy: true });
    let calls = 0;
    const result = await observeEditorReadiness(async (url) => {
      calls++;
      const value = await f.read(url);
      if (calls !== 5 || !value || typeof value !== 'object') return value;
      return { ...value, updateTime: '2026-10-29T22:00:00.123456788Z' };
    }, target);
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'metadata_unstable',
      stage: 'consistency_check',
    });
  });
  it('compares validated owner-set membership across both passes', async () => {
    const f = fixture();
    let calls = 0;
    const result = await observeEditorReadiness(async (url) => {
      calls++;
      const value = await f.read(url);
      if (calls !== 4 || url !== f.urls[0] || !value || typeof value !== 'object') return value;
      const otherId = '20000000-0000-4000-8000-000000000009';
      const otherName = `${new URL(f.urls[0]).pathname.replace(/^\/v1\//, '').split('/agents')[0]}/agents/${Buffer.from(otherId).toString('base64url')}`;
      const owners = value as { documents: unknown[] };
      return {
        ...owners,
        documents: [
          ...owners.documents,
          {
            name: otherName,
            updateTime: '2026-10-29T22:00:02.123456789Z',
            fields: { id: field(otherId) },
          },
        ],
      };
    }, target);
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'metadata_unstable',
      stage: 'consistency_check',
    });
  });
  it.each([
    { label: 'owner document', call: 1, urlIndex: 0 },
    { label: 'epoch document', call: 3, urlIndex: 2 },
  ])('treats a changed $label updateTime as unstable', async ({ call, urlIndex }) => {
    const f = fixture();
    let calls = 0;
    const url = f.urls.at(urlIndex);
    if (!url) throw new Error('missing metadata URL fixture');
    const result = await observeEditorReadiness(async (requested) => {
      calls++;
      const value = await f.read(requested);
      if (calls !== call + 3 || requested !== url || !value || typeof value !== 'object')
        return value;
      if (urlIndex === 0) {
        const owners = value as { documents: Array<Record<string, unknown>> };
        const [owner, ...rest] = owners.documents;
        if (!owner) throw new Error('missing owner fixture');
        return {
          ...owners,
          documents: [{ ...owner, updateTime: '2026-10-29T22:00:01.123456790Z' }, ...rest],
        };
      }
      return { ...value, updateTime: '2026-10-29T22:00:01.123456790Z' };
    }, target);
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'metadata_unstable',
      stage: 'consistency_check',
    });
  });
  it.each([
    { label: 'owner id', urlIndex: 0, field: 'id' },
    { label: 'privacy generation', urlIndex: 1, field: 'generation' },
    { label: 'epoch cursor', urlIndex: 2, field: 'cursor' },
  ])(
    'rejects an invalid oneof with an extra value for $label',
    async ({ urlIndex, field: name }) => {
      const f = fixture({ privacy: true });
      const url = f.urls.at(urlIndex);
      if (!url) throw new Error('missing metadata URL fixture');
      const raw = f.data.get(url);
      if (!raw || typeof raw !== 'object') throw new Error('missing typed fixture');
      if (urlIndex === 0) {
        const doc = (raw as { documents: Array<{ fields: Record<string, unknown> }> }).documents[0];
        if (!doc) throw new Error('missing owner fixture');
        doc.fields[name] = { stringValue: target.ownerId, integerValue: '1' };
      } else {
        const fields = (raw as { fields: Record<string, unknown> }).fields;
        const existing = fields[name] as { stringValue: string };
        fields[name] = { stringValue: existing.stringValue, integerValue: '1' };
      }
      expect(await observeEditorReadiness(f.read, target)).toMatchObject({
        status: 'unknown',
        reason: 'metadata_schema_invalid',
      });
    },
  );
  it('rejects wrong echoed document identity and ambiguous owner population', async () => {
    const f = fixture();
    f.data.set(f.urls[0], { documents: [], nextPageToken: 'more' });
    expect(await observeEditorReadiness(f.read, target)).toMatchObject({
      status: 'unavailable',
      reason: 'single_owner_not_verified',
    });
    const g = fixture();
    const doc = g.data.get(g.urls[2]) as { name: string };
    doc.name += 'wrong';
    expect((await observeEditorReadiness(g.read, target)).status).toBe('unknown');
  });
  it('dispatches GET only to exact masked URLs and refuses another installation before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const read = createEditorMetadataRead('a'.repeat(32), Date.now() + 10_000, target, fetcher);
    await read(editorMetadataUrls(target)[2]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    await expect(
      read(
        'https://firestore.googleapis.com/v1/projects/bmson-assistant/databases/assistant-production/documents/private',
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('caps metadata bytes and turns a missing document into absence, not permission to write', async () => {
    const huge = createEditorMetadataRead(
      'a'.repeat(32),
      Date.now() + 10_000,
      target,
      async () => new Response('x'.repeat(16_385)),
    );
    await expect(huge(editorMetadataUrls(target)[2])).rejects.toThrow();
    const absent = createEditorMetadataRead(
      'a'.repeat(32),
      Date.now() + 10_000,
      target,
      async () => new Response(null, { status: 404 }),
    );
    expect(await absent(editorMetadataUrls(target)[2])).toBeNull();
  });
  it.each([401, 403])(
    'reports a denied HTTP read as unknown with only fixed diagnostics (%s)',
    async (status) => {
      const reader = createEditorMetadataRead(
        'a'.repeat(32),
        Date.now() + 10_000,
        target,
        async () => new Response('private response body', { status }),
      );
      const result = await observeEditorReadiness(reader, target);
      expect(result).toMatchObject({
        status: 'unknown',
        reason: 'read_http_denied',
        stage: 'owner_first_read',
        httpStatus: status,
        epochPresent: null,
        epochReady: null,
      });
      expect(JSON.stringify(result)).not.toContain('private response body');
    },
  );
  it('distinguishes server errors, invalid response JSON, and invalid stable metadata', async () => {
    const serverError = createEditorMetadataRead(
      'a'.repeat(32),
      Date.now() + 10_000,
      target,
      async () => new Response('private body', { status: 503 }),
    );
    expect(await observeEditorReadiness(serverError, target)).toMatchObject({
      reason: 'read_http_unavailable',
      httpStatus: 503,
    });
    const invalidJson = createEditorMetadataRead(
      'a'.repeat(32),
      Date.now() + 10_000,
      target,
      async () => new Response('{private', { status: 200 }),
    );
    expect(await observeEditorReadiness(invalidJson, target)).toMatchObject({
      reason: 'read_response_invalid',
      httpStatus: 200,
    });
    const invalidSchema = fixture();
    invalidSchema.data.set(invalidSchema.urls[2], { fields: { cursor: field('{private') } });
    expect(await observeEditorReadiness(invalidSchema.read, target)).toMatchObject({
      reason: 'metadata_schema_invalid',
      stage: 'epoch_first_validation',
      httpStatus: null,
    });
  });
  it('labels its bounded timer abort as a read deadline outcome', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
      const reader = createEditorMetadataRead(
        'a'.repeat(32),
        Date.now() + 60_000,
        target,
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      const pending = observeEditorReadiness(reader, target);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toMatchObject({
        status: 'unknown',
        reason: 'read_deadline_expired',
        stage: 'owner_first_read',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([404, 403])(
    'does not accept a late HTTP %s response after the per-read timeout',
    async (status) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
        const reader = createEditorMetadataRead(
          'a'.repeat(32),
          Date.now() + 60_000,
          target,
          async () =>
            new Promise<Response>((resolve) => {
              setTimeout(() => resolve(new Response(null, { status })), 9_000);
            }),
        );
        const pending = observeEditorReadiness(reader, target);
        await vi.advanceTimersByTimeAsync(9_000);
        expect(await pending).toMatchObject({
          status: 'unknown',
          reason: 'read_deadline_expired',
          stage: 'owner_first_read',
          httpStatus: null,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('does not accept a body that finishes after the per-read timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
      const reader = createEditorMetadataRead(
        'a'.repeat(32),
        Date.now() + 60_000,
        target,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode('{}'));
                  controller.close();
                }, 9_000);
              },
            }),
            { status: 200 },
          ),
      );
      const pending = observeEditorReadiness(reader, target);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await pending).toMatchObject({
        status: 'unknown',
        reason: 'read_deadline_expired',
        stage: 'owner_first_read',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('accepts the real encoded epoch record through a field-masked REST projection', async () => {
    const record = buildFirestoreOwnerEditorEpochRecord({
      ownerId: target.ownerId,
      epoch: '20000000-0000-4000-8000-000000000002',
      ready: true,
      privacyGeneration: null,
      updatedAt: new Date('2026-10-30T12:00:00.000Z'),
    });
    const restProjection = {
      name: `projects/bmson-assistant/databases/assistant-production/documents/installations/YXNzaXN0YW50/maintenanceCursors/${Buffer.from(`owner-editor-epoch:${target.ownerId}`).toString('base64url')}`,
      updateTime: '2026-10-30T12:00:00.000Z',
      fields: Object.fromEntries(
        Object.entries(record).flatMap(([name, value]) =>
          typeof value === 'string' ? [[name, field(value)]] : [],
        ),
      ),
    };
    const f = fixture();
    f.data.set(f.urls[2], restProjection);
    expect(await observeEditorReadiness(f.read, target)).toMatchObject({
      status: 'ready',
      stage: 'complete',
      observationStable: true,
    });
  });
});
